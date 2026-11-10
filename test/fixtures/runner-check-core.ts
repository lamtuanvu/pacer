import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { runStdio } from "../../src/api/stdio";
import type { RunnerCheckDeps } from "../../src/core/runner-check";
import { makeCtx } from "../../src/ctx";

// TypeScript core for a stdio front door: runner.check jobs run with stubbed readiness steps,
// so no executor CLI, account sign-in or test task is ever reached.
if (process.argv.slice(2).join(" ") !== "api --stdio") throw Error("usage: runner-check-core api --stdio");
const ctx = makeCtx();
const runnerCheck: RunnerCheckDeps = {
  detectAgents: async () => [{ agent: "codex", found: true, version: "1.0", path: "/stub/codex", install_hint: "install codex" }],
  listAccounts: async () => [{ name: "codex", signedIn: true }],
  checkLimits: async () => [{ account: "codex", kind: "codex", source: "session-log", capturedAt: 1, ageS: 0, stale: false, verdict: "OK", usedPct: 3, window: "weekly", resetsAt: null, runners: ["codex"], error: null, hint: null }],
  runTestTask: async (_ctx, id) => { appendFileSync(join(ctx.pacerHome, "stub-test-tasks.log"), `${id} ${process.pid}\n`); },
};
await runStdio(() => ({ ...ctx, now: Date.now() / 1000 }), createInterface({ input: process.stdin }), line => { process.stdout.write(line); },
  { opDeps: { runnerCheck }, nativeConfigKey: process.env.PACER_NATIVE_CONFIG_SYNC_KEY });
