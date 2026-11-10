/**
 * Test core for the Rust front doors (`PACER_CORE_ARGV`): the real `serve --internal` HTTP server and
 * `api --stdio` handler, with the login-service backend and the update job replaced by recorders, so
 * `service.install` and `update.apply` never reach launchd, systemd, a release feed or a binary.
 * `<PACER_HOME>/fixture.json` sets per-call behavior; every effect appends to `<PACER_HOME>/effects.log`.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { OpDeps } from "../../src/api/ops";
import { runStdio } from "../../src/api/stdio";
import { makeCtx } from "../../src/ctx";
import { startServer } from "../../src/serve/http";
import type { ServiceStatus } from "../../src/service";

type Behavior = { installDelayMs?: number; installFail?: string; standalone?: boolean };

const ctx = makeCtx();
const fresh = () => ({ ...ctx, now: Date.now() / 1000 });
const behavior = (): Behavior => { try { return JSON.parse(readFileSync(join(ctx.pacerHome, "fixture.json"), "utf8")); } catch { return {}; } };
const log = (line: string) => appendFileSync(join(ctx.pacerHome, "effects.log"), `${line}\n`);
let installs = 0;

const opDeps: OpDeps = {
  service: {
    async install() {
      const n = ++installs, b = behavior();
      log(`install ${n} start`);
      await Bun.sleep(b.installDelayMs ?? 0);
      if (b.installFail) { log(`install ${n} failed`); throw new Error(b.installFail); }
      log(`install ${n} done`);
      return [];
    },
    async status() { return { installed: true, running: true } as ServiceStatus; },
  },
  get update() { return { standalone: behavior().standalone ?? true, execPath: join(ctx.pacerHome, "bin/pacer") }; },
  runUpdate: async () => { log("update job"); return { code: 0, out: "", err: "" }; },
};

const [command, flag] = process.argv.slice(2);
if (command === "serve" && flag === "--internal") {
  const token = ctx.env.PACER_INTERNAL_TOKEN!;
  delete ctx.env.PACER_INTERNAL_TOKEN;
  const server = startServer(fresh, { internal: { token }, opDeps });
  process.stdout.write(`${JSON.stringify({ internal: { port: server.port } })}\n`);
  writeFileSync(join(ctx.pacerHome, "core-ready"), String(process.pid));
  process.stdin.once("end", () => { void server.stop().finally(() => process.exit(0)); });
  process.stdin.resume();
} else if (command === "api" && flag === "--stdio") {
  const nativeConfigKey = ctx.env.PACER_NATIVE_CONFIG_SYNC_KEY;
  delete ctx.env.PACER_NATIVE_CONFIG_SYNC_KEY;
  await runStdio(fresh, createInterface({ input: process.stdin, crlfDelay: Infinity }), line => { process.stdout.write(line); }, { opDeps, nativeConfigKey });
  process.exit(0);
} else {
  process.exit(2);
}
