import { expect, test } from "bun:test";
import { join } from "node:path";
import { tmpDir } from "./helpers";

// The plugin boundaries are mocked in a child process so the mocks never leak into other test files.
test("pacer-internal codes reach the doctor through usage status, integration freshness and the planner check", async () => {
  const src = join(import.meta.dir, "../src"), script = join(tmpDir(), "doctor-error-codes.ts");
  const path = (relative: string) => JSON.stringify(join(src, relative));
  await Bun.write(script, `
    import { mock } from "bun:test";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const { CoreError } = await import(${path("core/errors.ts")});
    const broker = await import(${path("plugins/usage-broker.ts")});
    mock.module(${path("plugins/usage-broker.ts")}, () => ({ ...broker, readPluginUsage: async (_ctx, cfg) => {
      if (cfg.id === "claude-code") throw new CoreError("plugin_unavailable", "native process owner supervises plugin children");
      return { windows: [], capturedAt: null, stale: false, error: "plugin reported a failure", errorCode: "plugin_unavailable" };
    } }));
    const install = await import(${path("plugins/planner-install.ts")});
    mock.module(${path("plugins/planner-install.ts")}, () => ({ ...install,
      withPlannerInstall: async () => { throw new CoreError("plugin_timeout", "planner plugin did not answer"); } }));
    const check = await import(${path("plugins/planner-check.ts")});
    mock.module(${path("plugins/planner-check.ts")}, () => ({ ...check,
      plannerCheck: async () => { throw new CoreError("plugin_unavailable", "planner plugin unavailable"); } }));
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
  const checks = Object.fromEntries((JSON.parse(stdout) as { name: string }[]).map(({ name, ...rest }) => [name, rest]));
  const internal = { level: "warn", evidence: "unverified", remedy: "internal" };
  expect(checks).toEqual({
    "Usage claude-code": internal,
    // A plugin's own reading cannot claim a pacer-internal code.
    "Usage codex": { level: "warn", evidence: null, remedy: "agent" },
    "Integration freshness codex": internal,
    "Planner check codex": internal,
  });
}, 30000);
