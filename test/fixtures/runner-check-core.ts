import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { runStdio } from "../../src/api/stdio";
import type { RunnerCheckDeps } from "../../src/core/runner-check";
import { makeCtx } from "../../src/ctx";
import { startServer } from "../../src/serve/http";
import type { SpawnRunner } from "../../src/tasks/api";
import { assertIsolatedEnv } from "../isolated-port";

// TypeScript core for a front door (`api --stdio` or `serve --internal`): runner.check jobs run with
// stubbed readiness steps, so no executor CLI, account sign-in or test task is ever reached. Each
// stubbed test task records the caller identity the core ran it under. PACER_FIXTURE_DELAY_MS
// holds Core's runner.check answer back: in the stdio job itself, or in the HTTP response, since
// the serving core answers with a running job.
const mode = process.argv.slice(2).join(" ");
if (mode !== "api --stdio" && mode !== "serve --internal") throw Error("usage: runner-check-core api --stdio | serve --internal");
assertIsolatedEnv(process.env);
const ctx = makeCtx();
const delay = Number(process.env.PACER_FIXTURE_DELAY_MS ?? 0);
const record = (file: string, entry: Record<string, unknown>) => appendFileSync(join(ctx.pacerHome, file), `${JSON.stringify(entry)}\n`);
const runnerCheck: RunnerCheckDeps = {
  detectAgents: async () => [{ agent: "codex", found: true, version: "1.0", path: "/stub/codex", install_hint: "install codex" }],
  listAccounts: async () => [{ name: "codex", signedIn: true }, { name: "work", signedIn: true }],
  checkLimits: async () => ["codex", "work"].map(account => ({ account, kind: "codex", source: "session-log", capturedAt: 1, ageS: 0, stale: false, verdict: "OK", usedPct: 3, window: "weekly", resetsAt: null, runners: [account === "codex" ? "codex" : "codex#work"], error: null, hint: null })),
  runTestTask: async (request, id) => {
    if (mode === "api --stdio") await Bun.sleep(delay);
    const env = request.env;
    record("stub-test-tasks.log", { id, pid: process.pid, port: process.env.PACER_PORT, agent: env.PACER_AGENT ?? null, role: env.PACER_ROLE ?? null, task: env.PACER_TASK_ID ?? null, grant: env.PACER_WORK_GRANT ?? null });
  },
};
const spawnRunner: SpawnRunner = (_ctx, taskId) => { record("refused-runners.log", { taskId }); return undefined; };
const fresh = () => ({ ...ctx, now: Date.now() / 1000 });

if (mode === "api --stdio") {
  await runStdio(fresh, createInterface({ input: process.stdin }), line => { process.stdout.write(line); },
    { opDeps: { runnerCheck }, nativeConfigKey: process.env.PACER_NATIVE_CONFIG_SYNC_KEY });
} else {
  const token = process.env.PACER_INTERNAL_TOKEN!;
  delete process.env.PACER_INTERNAL_TOKEN;
  delete ctx.env.PACER_INTERNAL_TOKEN;
  const core = startServer(fresh, { internal: { token }, opDeps: { runnerCheck, spawnRunner } });
  const front = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: async request => {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.delete("host");
    const answer = await fetch(`http://127.0.0.1:${core.port}${url.pathname}${url.search}`, { method: request.method, headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer() });
    if (url.pathname !== "/v3/ops/runner.check") return answer;
    record("core-requests.log", { auth: request.headers.get("x-pacer-auth"), grant: request.headers.get("x-pacer-work-grant") });
    const body = await answer.arrayBuffer();
    await Bun.sleep(delay);
    return new Response(body, { status: answer.status, headers: answer.headers });
  } });
  process.stdout.write(`${JSON.stringify({ internal: { port: front.port } })}\n`);
  const stop = () => { front.stop(true); void core.stop().finally(() => process.exit(0)); };
  if (process.env.PACER_INTERNAL_PARENT_PIPE === "1") { process.stdin.once("end", stop); process.stdin.resume(); }
  process.once("SIGTERM", stop);
}
