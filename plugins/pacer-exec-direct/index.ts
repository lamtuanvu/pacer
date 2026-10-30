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

const ownedInput = z.object({
  task: z.object({ id: z.string(), rev: z.number().int().positive() }).strict(),
  attempt: z.number().int().positive(), runDir: z.literal(1),
  owned: z.object({ placement: z.enum(["current", "new"]),
    session: z.literal("interactive").optional(),
    timeoutMs: z.number().int().positive().max(30 * 60 * 1000),
    executor: z.string().min(1).max(256), model: z.string().max(256).nullable(),
    resume: z.object({ startedAt: z.number().finite(), logFile: z.string().min(1).max(4096),
      worktree: z.string().min(1).max(4096).optional() }).strict().optional() }).strict(),
}).strict();
const remoteInput = z.object({
  task: z.object({ id: z.string(), rev: z.number().int().positive() }).strict(),
  attempt: z.number().int().positive(), runDir: z.literal(1),
  remote: z.object({ timeoutMs: z.number().int().positive().max(30 * 60 * 1000),
    executor: z.string().min(1).max(256), model: z.string().max(256).nullable(),
    resume: z.object({ startedAt: z.number().finite(), logFile: z.string().min(1).max(4096) }).strict().optional(),
  }).strict(),
}).strict();

async function runOwnedRemote(params: z.infer<typeof remoteInput>, host: Parameters<Handler>[1], signal: AbortSignal) {
  const { task, attempt, remote } = params;
  let startedAt = remote.resume?.startedAt, logFile = remote.resume?.logFile;
  if (!remote.resume) {
    await host.call("capability.hosts.prepareOwned", { taskId: task.id, attempt });
    if (signal.aborted) throw new PluginError("plugin_unavailable", "remote placement was cancelled");
    const claimed = await host.call<{ startedAt: number; logFile: string }>(
      "capability.hosts.claimOwned", { taskId: task.id, attempt });
    startedAt = claimed.startedAt; logFile = claimed.logFile;
    if (signal.aborted) throw new PluginError("plugin_unavailable", "remote start was cancelled");
    await host.call("capability.hosts.startOwned", { taskId: task.id, attempt });
  }
  const deadline = startedAt! * 1000 + remote.timeoutMs;
  let uncertainSince: number | null = null;
  for (;;) {
    if (signal.aborted) throw new PluginError("plugin_unavailable", "remote run was cancelled; inspect the persisted run");
    const state = await host.call<{ state: "running" | "exited" | "uncertain"; exitCode: number | null }>(
      "capability.hosts.pollOwned", { taskId: task.id, attempt });
    if (state.state === "exited" && state.exitCode !== null) {
      const encoded = await host.call<{ stdoutBase64: string; stderrBase64: string }>(
        "capability.hosts.readOwnedOutput", { taskId: task.id, attempt });
      const stdout = Buffer.from(encoded.stdoutBase64, "base64").toString("utf8");
      const stderr = Buffer.from(encoded.stderrBase64, "base64").toString("utf8");
      const report = (stdout.trim() || stderr.trim()).slice(-4000);
      const transfer = await host.call<{ transferred: boolean; branch?: string; commits?: number;
        reviewWorktree?: string; reason?: string }>("capability.hosts.transferOwned", { taskId: task.id, attempt });
      if (transfer.reason) throw new PluginError("plugin_refused", `remote transfer is unresolved: ${transfer.reason}`);
      return { backend: "direct", report,
        exec: { code: state.exitCode, stdout, stderr, timedOut: false },
        attempt: { executor: remote.executor, model: remote.model, startedAt: startedAt!,
          endedAt: Date.now() / 1000, exitCode: state.exitCode, timedOut: false,
          limitHit: false, log: logFile! },
        ...(transfer.transferred && transfer.reviewWorktree ? { worktree: transfer.reviewWorktree,
          report: `ran on remote host; fetched ${transfer.branch} (${transfer.commits} commits)\n\n${report}` } : {}) };
    }
    uncertainSince = state.state === "uncertain" ? uncertainSince ?? Date.now() : null;
    if (uncertainSince !== null && Date.now() - uncertainSince >= 5000)
      throw new PluginError("plugin_unavailable", "remote run state is uncertain; replacement launch refused");
    if (Date.now() >= deadline)
      throw new PluginError("plugin_timeout", "remote deadline reached; persisted run requires stop reconciliation");
    await Bun.sleep(200);
  }
}

async function runOwned(params: z.infer<typeof ownedInput>, host: Parameters<Handler>[1], signal: AbortSignal) {
  const { task, attempt, owned } = params;
  let worktree: string | undefined = owned.resume?.worktree;
  if (!owned.resume && owned.placement === "new") {
    const base = await host.call<{ base: string; sha: string }>("capability.worktree.resolveBase",
      { taskId: task.id, attempt });
    if (signal.aborted) throw new PluginError("plugin_unavailable", "executor placement was cancelled");
    const placed = await host.call<{ workdir: string }>("capability.worktree.createOrReuse",
      { taskId: task.id, attempt, baseSha: base.sha });
    worktree = placed.workdir;
  }
  if (signal.aborted) throw new PluginError("plugin_unavailable", "executor claim was cancelled");
  let startedAt = owned.resume?.startedAt, logFile = owned.resume?.logFile;
  if (!owned.resume) {
    const claim = await host.call<{ task: { id: string; rev: number }; attempt: number; runDir: 1;
      dir: string; workdir: string; startedAt: number; logFile: string }>(
      "capability.process.claimRun", { taskId: task.id, attempt });
    if (worktree && claim.workdir !== worktree)
      throw new PluginError("capability_denied", "executor worktree changed after placement");
    startedAt = claim.startedAt;
    logFile = claim.logFile;
    if (signal.aborted) throw new PluginError("plugin_unavailable", "executor start was cancelled");
    await host.call("capability.process.startRun", { task: claim.task, attempt, runDir: 1 });
  }
  const deadline = owned.resume ? owned.resume.startedAt * 1000 + owned.timeoutMs : Date.now() + owned.timeoutMs;
  let uncertainSince: number | null = null;
  let completed: { status: "done" | "failed"; summary: string; at: number; exitCode: number } | null = null;
  for (;;) {
    if (signal.aborted) throw new PluginError("plugin_unavailable", "executor run was cancelled; inspect the persisted wrapper");
    const state = await host.call<{ state: "running" | "exited" | "uncertain"; exitCode: number | null;
      interactive?: boolean; report?: { status: string; summary: string; at: number } | null }>(
      "capability.process.pollRun", { taskId: task.id, attempt });
    if (owned.session === "interactive" && state.interactive !== true)
      throw new PluginError("plugin_refused", "interactive run observation has no session proof");
    if (owned.session === "interactive" && !completed &&
      (state.report?.status === "done" || state.report?.status === "failed")) {
      const receipt = await host.call<{ status: "done" | "failed"; summary: string;
        at: number; exitCode: number }>("capability.process.completeReportedRun", { taskId: task.id, attempt });
      if (receipt.status !== state.report.status || receipt.summary !== state.report.summary ||
        receipt.at !== state.report.at)
        throw new PluginError("plugin_refused", "interactive report completion changed");
      completed = receipt;
      continue;
    }
    if (state.state === "exited" && state.exitCode !== null) {
      if (completed && state.exitCode !== completed.exitCode)
        throw new PluginError("plugin_refused", "interactive exit changed after completion");
      const encoded = await host.call<{ stdoutBase64: string; stderrBase64: string }>(
        "capability.process.readRunOutput", { taskId: task.id, attempt });
      const stdout = Buffer.from(encoded.stdoutBase64, "base64").toString("utf8");
      const stderr = Buffer.from(encoded.stderrBase64, "base64").toString("utf8");
      const report = completed?.summary ?? (owned.session === "interactive"
        ? `Interactive session exited without an explicit completion report${state.report?.summary ? `\n\n${state.report.summary.slice(-4000)}` : ""}`
        : (stdout.trim() || stderr.trim()).slice(-4000));
      if (owned.session === "interactive" && !completed &&
        (state.report?.status === "done" || state.report?.status === "failed"))
        throw new PluginError("plugin_refused", "interactive completion has no host receipt");
      const code = owned.session === "interactive"
        ? completed ? completed.status === "done" ? 0 : 1 : state.exitCode || 1 : state.exitCode;
      return { backend: "direct", report, exec: { code, stdout, stderr, timedOut: false },
        attempt: { executor: owned.executor, model: owned.model,
          startedAt: startedAt!, endedAt: Date.now() / 1000,
          exitCode: code, timedOut: false, limitHit: false, log: logFile! },
        ...(worktree ? { worktree } : {}) };
    }
    uncertainSince = state.state === "uncertain" ? uncertainSince ?? Date.now() : null;
    if (uncertainSince !== null && Date.now() - uncertainSince >= 5000)
      throw new PluginError("plugin_unavailable", "executor wrapper state is uncertain; replacement launch refused");
    if (Date.now() >= deadline)
      throw new PluginError("plugin_timeout", "executor deadline reached; persisted wrapper requires stop reconciliation");
    await Bun.sleep(200);
  }
}

export const handlers = {
  "executor.available": () => ({ available: true }),
  "executor.run": async (params, host, signal) => {
    const remote = remoteInput.safeParse(params);
    if (remote.success) return runOwnedRemote(remote.data, host, signal);
    const owned = ownedInput.safeParse(params);
    if (owned.success) return runOwned(owned.data, host, signal);
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
      graceMs: z.number().int().nonnegative().max(25_000), remote: z.literal(true).optional() }).strict().parse(params);
    if (signal.aborted) throw new PluginError("plugin_unavailable", "executor stop was cancelled");
    const result = await host.call<{ code: number; killed: boolean }>(
      stop.remote ? "capability.hosts.stopOwned" : "capability.process.stopRun",
      { taskId: stop.taskId, attempt: stop.attempt, graceMs: stop.graceMs });
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
