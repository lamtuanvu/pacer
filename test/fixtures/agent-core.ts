/**
 * Test core for the Rust front doors (`PACER_CORE_ARGV`): the real `serve --internal` HTTP server and
 * `api --stdio` handler, with `agent.preview`/`connect`/`undo`/`disconnect` driven by a seeded
 * `strategy.yaml` and a fake CLI (`which` returns null, `run` returns not-available), so the built-in
 * planner plugin produces a deterministic file plan that installs/undoes without a real agent home, and
 * every side effect stays under a disposable HOME.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { OpDeps } from "../../src/api/ops";
import { runStdio } from "../../src/api/stdio";
import { makeCtx } from "../../src/ctx";
import { startServer } from "../../src/serve/http";
import { readCoreSecrets, scrubCoreSecrets } from "../../src/core-secrets";
import { holdOwnerKey } from "../../src/plugins/host-bridge";

const secrets = scrubCoreSecrets(process.env) ? readCoreSecrets() : {};
if (secrets.ownerKey) holdOwnerKey(secrets.ownerKey);
const ctx = makeCtx({
  which: () => "/usr/bin/fake",
  run: async () => ({ code: 127, stdout: "", stderr: "not available in tests" }),
});
const fresh = () => ({ ...ctx, now: Date.now() / 1000 });
mkdirSync(join(ctx.pacerHome, "config", "agents"), {recursive: true});
// A planner strategy that resolves codex as the planner without a provider account or an installed CLI,
// matching test/api-ops-config.test.ts : configured() so agent ops are deterministic.
writeFileSync(join(ctx.pacerHome, "strategy.yaml"),
  "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\npacing: {policy: priority}\nrouting: [{default: [codex]}]\n");

const opDeps: OpDeps = {};

const [command, flag] = process.argv.slice(2);
appendFileSync(join(ctx.pacerHome, "core-port.log"), `${command} ${process.env.PACER_PORT ?? "unset"}\n`);
if (command === "serve" && flag === "--internal") {
  const token = secrets.internalToken!;
  const server = startServer(fresh, { internal: { token }, opDeps });
  process.stdout.write(`${JSON.stringify({ internal: { port: server.port } })}\n`);
  writeFileSync(join(ctx.pacerHome, "core-ready"), String(process.pid));
  process.stdin.once("end", () => { void server.stop().finally(() => process.exit(0)); });
  process.stdin.resume();
} else if (command === "api" && flag === "--stdio") {
  const nativeConfigKey = secrets.nativeConfigSyncKey;
  await runStdio(fresh, createInterface({ input: process.stdin, crlfDelay: Infinity }), line => { process.stdout.write(line); }, { opDeps, nativeConfigKey });
  process.exit(0);
} else {
  process.exit(2);
}