import { PluginError, serve, type Handler } from "@pacer/plugin";
import { z } from "zod";
import { manifest } from "./manifest";
export { manifest } from "./manifest";

const input = z.object({
  task: z.object({ id: z.string(), rev: z.number().int().positive() }).strict(),
  attempt: z.number().int().positive(), runDir: z.literal(1),
  effect: z.object({ argv: z.array(z.string()).min(1).max(32), cwd: z.string(),
    timeoutMs: z.number().int().positive().max(30 * 60 * 1000), stdin: z.string().max(262144).optional(),
    env: z.record(z.string(), z.string()).optional(), secretEnv: z.record(z.string(), z.string()).optional(),
    detached: z.literal(true).optional() }).strict(),
}).strict();

const spawnResult = z.object({
  code: z.number().int().safe(), timedOut: z.boolean(),
  stderr: z.string().optional(),
  output: z.object({ stdout: z.string().uuid(), stderr: z.string().uuid() }).optional(),
}).refine(value => value.stderr !== undefined || value.output !== undefined);

export const handlers = {
  "executor.available": () => ({ available: false, reason: "Direct attempt dispatch is not yet routed to this plugin" }),
  "executor.run": async (params, host, signal) => {
    const parsed = input.safeParse(params);
    if (!parsed.success) throw new PluginError("invalid_input", "direct process effect is required");
    if (signal.aborted) throw new PluginError("plugin_unavailable", "executor call was cancelled");
    const { effect } = parsed.data;
    if (effect.detached) {
      const launched = await host.call<{ pid: number }>("capability.process.startRun", {
        task: parsed.data.task, attempt: parsed.data.attempt, runDir: parsed.data.runDir,
      });
      if (signal.aborted) throw new PluginError("plugin_unavailable", "executor call was cancelled after launch; inspect run directory");
      return { status: "launched", pid: launched.pid, report: "detached wrapper started" };
    }
    const result = spawnResult.parse(await host.call("capability.process.spawn", {
      argv: effect.argv, cwd: effect.cwd,
      env: { ...effect.env, ...Object.fromEntries(Object.entries(effect.secretEnv ?? {}).map(
        ([name, ref]) => [name, { secretRef: ref }])) }, timeoutMs: effect.timeoutMs,
      ...(effect.stdin === undefined ? {} : { stdin: effect.stdin }),
    }));
    if (signal.aborted) throw new PluginError("plugin_unavailable", "executor call was cancelled");
    let stderr = result.stderr ?? "";
    if (result.output) {
      const chunk = await host.call<{ base64: string }>("capability.process.outputChunk",
        { handle: result.output.stderr, offset: 0, length: 1024 });
      stderr = Buffer.from(chunk.base64, "base64").toString("utf8");
    }
    return { status: result.code === 0 && !result.timedOut ? "done" : "failed",
      exitCode: result.code,
      report: result.timedOut ? "local process timed out" : result.code === 0
        ? "local process exited successfully" : `local process exited ${result.code}: ${stderr.slice(0, 1024)}` };
  },
  "executor.stop": async (params, host, signal) => {
    const stop = z.object({ taskId: z.string(), attempt: z.number().int().positive(),
      graceMs: z.number().int().nonnegative().max(25_000) }).strict().parse(params);
    if (signal.aborted) throw new PluginError("plugin_unavailable", "executor stop was cancelled");
    const result = await host.call<{ code: number; killed: boolean }>("capability.process.stopRun", stop);
    if (signal.aborted) throw new PluginError("plugin_unavailable", "executor stop completion is uncertain");
    return result;
  },
  "executor.sessionState": async (params, host, signal) => {
    const input = z.object({ taskId: z.string(), attempt: z.number().int().positive() }).strict().parse(params);
    if (signal.aborted) throw new PluginError("plugin_unavailable", "executor inspection was cancelled");
    const observed = await host.call<{ state: "running" | "exited" | "uncertain" }>(
      "capability.process.inspectRun", input);
    if (signal.aborted) throw new PluginError("plugin_unavailable", "executor inspection was cancelled");
    return { state: observed.state, host: "builtin", handle: null };
  },
} satisfies Record<string, Handler>;

if (import.meta.main) await serve({ manifest, handlers });
