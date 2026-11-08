import { expect, test } from "bun:test";
import { join } from "node:path";
import { CoreError, PluginReportedError } from "../src/core/errors";
import { internalErrorCode } from "../src/install/doctor-remedy";
import { PluginProcess } from "../src/plugins/process";
import { tmpDir } from "./helpers";

type Raiser = "pacer" | "plugin";

// The plugin boundaries are mocked in a child process so the mocks never leak into other test files.
async function doctorChecks(raiser: Raiser): Promise<Record<string, unknown>> {
  const src = join(import.meta.dir, "../src"), script = join(tmpDir(), "doctor-error-codes.ts");
  const path = (relative: string) => JSON.stringify(join(src, relative));
  await Bun.write(script, `
    import { mock } from "bun:test";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const { CoreError } = await import(${path("core/errors.ts")});
    const { pluginReplyError } = await import(${path("plugins/errors.ts")});
    // Pacer's own failure, or a plugin's JSON-RPC error reply choosing (or defaulting to) the same code.
    const fail = (code, message) => ${JSON.stringify(raiser)} === "pacer" ? new CoreError(code, message)
      : pluginReplyError({ message, ...(code === "plugin_unavailable" ? {} : { data: { code } }) });
    const broker = await import(${path("plugins/usage-broker.ts")});
    mock.module(${path("plugins/usage-broker.ts")}, () => ({ ...broker, readPluginUsage: async (_ctx, cfg) => {
      if (cfg.id === "claude-code") throw fail("plugin_unavailable", "usage source is unavailable");
      return { windows: [], capturedAt: null, stale: false, error: "plugin reported a failure", errorCode: "plugin_unavailable" };
    } }));
    const install = await import(${path("plugins/planner-install.ts")});
    mock.module(${path("plugins/planner-install.ts")}, () => ({ ...install,
      withPlannerInstall: async () => { throw fail("plugin_timeout", "planner plugin did not answer"); } }));
    const check = await import(${path("plugins/planner-check.ts")});
    mock.module(${path("plugins/planner-check.ts")}, () => ({ ...check,
      plannerCheck: async () => { throw fail("plugin_refused", "planner check refused"); } }));
    const { fakeCtx, withLoginIndicators } = await import(${JSON.stringify(join(import.meta.dir, "helpers.ts"))});
    const { runDoctor } = await import(${path("install/doctor.ts")});
    const { writeManifest } = await import(${path("install/manifest.ts")});
    const { sha256 } = await import(${path("install/fsx.ts")});
    const ctx = withLoginIndicators(fakeCtx());
    mkdirSync(ctx.pacerHome, { recursive: true });
    writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\\nproviders:\\n  claude-code: {usage: quota}\\n  codex: {usage: quota}\\nrouting:\\n  - default: [codex]\\n");
    const file = join(ctx.home, ".codex/AGENTS.md");
    mkdirSync(join(ctx.home, ".codex"), { recursive: true });
    writeFileSync(file, "policy");
    writeManifest(ctx, { version: 1, planners: { codex: { planner: "codex", installedAt: ctx.now, pacerArgv: ["pacer"],
      files: [{ path: file, action: "created", afterHash: sha256("policy"), undo: [] }], commands: [], notes: [] } } });
    const checks = await runDoctor(ctx, { service: async () => ({ installed: true, running: true, healthy: true, binaryMatches: true }) });
    console.log(JSON.stringify(checks.filter(c => /^(Usage|Integration freshness|Planner check) /.test(c.name))
      .map(c => ({ name: c.name, level: c.level, evidence: c.evidence ?? null, remedy: c.remedy?.kind ?? null }))));
    process.exit(0);
  `);
  const child = Bun.spawn([process.execPath, script], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 25000 });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  return Object.fromEntries((JSON.parse(stdout) as { name: string }[]).map(({ name, ...rest }) => [name, rest]));
}

const internal = { level: "warn", evidence: "unverified", remedy: "internal" };
// A plugin's own reading cannot claim a pacer-internal code.
const pluginReading = { level: "warn", evidence: null, remedy: "agent" };

test("pacer-internal codes reach the doctor through usage status, integration freshness and the planner check", async () => {
  expect(await doctorChecks("pacer")).toEqual({
    "Usage claude-code": internal,
    "Usage codex": pluginReading,
    "Integration freshness codex": internal,
    "Planner check codex": internal,
  });
}, 30000);

test("a plugin's thrown error reply is the plugin's failure, whatever code it chose or defaulted to", async () => {
  const checks = await doctorChecks("plugin");
  expect(Object.keys(checks)).toEqual(["Usage claude-code", "Usage codex", "Integration freshness codex", "Planner check codex"]);
  for (const check of Object.values(checks)) expect(check).not.toMatchObject({ remedy: "internal" });
  expect(checks["Usage codex"]).toEqual(pluginReading);
}, 30000);

test("the transport marks a plugin's JSON-RPC error reply, and only errors pacer raises count as internal", async () => {
  const script = join(tmpDir(), "error-reply-plugin.js");
  await Bun.write(script, `
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => {
      buffer += chunk;
      for (let at = buffer.indexOf("\\n"); at >= 0; at = buffer.indexOf("\\n")) {
        const message = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
        if (message.method !== "fail") continue; // "hang" never answers
        const data = message.params.code ? { code: message.params.code } : undefined;
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "sign in required", data } }) + "\\n");
      }
    });
  `);
  const plugin = new PluginProcess({ argv: [process.execPath, script], cwd: tmpDir(), env: { PATH: process.env.PATH } },
    { onRequest: async () => ({}), onStderr: () => {}, onExit: () => {} });
  const failure = (method: string, params: unknown, deadlineMs = 5000) => plugin.request(method, params, deadlineMs).then(() => null, (e: unknown) => e);
  try {
    for (const code of ["plugin_unavailable", "plugin_timeout", "plugin_refused", "unknown_plugin", undefined] as const) {
      const error = await failure("fail", { code });
      expect(error).toBeInstanceOf(PluginReportedError);
      expect((error as CoreError).code).toBe(code ?? "plugin_unavailable");
      expect(internalErrorCode(error)).toBeUndefined();
    }
    const deadline = await failure("hang", {}, 200);
    expect(deadline).toBeInstanceOf(CoreError);
    expect(deadline).not.toBeInstanceOf(PluginReportedError);
    expect(internalErrorCode(deadline)).toBe("plugin_timeout");
  } finally {
    await plugin.terminate();
  }
  expect(internalErrorCode(await plugin.request("fail", {}, 1000).catch((e: unknown) => e))).toBe("plugin_unavailable");
}, 15000);
