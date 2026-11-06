import { request as httpRequest } from "node:http";
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import golden from "./fixtures/config-writes-goldens.json";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const productionFront = process.env.PACER_TEST_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
function setup() {
  const home = mkdtempSync(join(tmpdir(), "pacer-native-dispatch-"));
  mkdirSync(join(home, ".pacer"), { mode: 0o700 });
  const env = { HOME: home, PACER_HOME: join(home, ".pacer"), PATH: process.env.PATH ?? "/usr/bin:/bin", PACER_CORE_ARGV: core,
    PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1" };
  return { home, env, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}
const rpc = (id: number, method: string, params: unknown = {}) => JSON.stringify({ jsonrpc: "2.0", id, method, params });

test.skipIf(!productionFront)("release front door rejects test-only native operations", async () => {
  const fixture = setup();
  const child = Bun.spawn([productionFront!, "api", "--stdio"], { env: fixture.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    await child.stdin.write([rpc(1, "hello", { protocol: 3 }), rpc(2, "test.echo", { ok: true }), rpc(3, "_debug.native")].join("\n") + "\n");
    await child.stdin.end();
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, stderr).toBe(0);
    const replies = stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(replies[0].result.protocol).toBe("3.0.0");
    expect(replies.slice(1).map(reply => reply.error.data.code)).toEqual(["unknown_op", "unknown_op"]);
    expect(stderr).not.toContain("native test.echo");
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } fixture.cleanup(); }
}, 30000);

test.skipIf(!front)("test binary exposes only its feature-gated native operations", async () => {
  const fixture = setup();
  const child = Bun.spawn([front!, "api", "--stdio"], { env: fixture.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    await child.stdin.write([rpc(1, "hello", { protocol: 3 }), rpc(2, "_debug.native")].join("\n") + "\n");
    await child.stdin.end();
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, stderr).toBe(0);
    const replies = stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(replies[1].result).toEqual(["_debug.native", "activity.list", "api.describe", "api.list", "config.get", "config.set", "delegation.pause", "delegation.resume", "files.search", "host.account.add", "host.add", "host.get", "host.list", "host.remove", "host.repo.map", "host.set", "host.suggest", "limits.check", "limits.report", "machine.get", "machine.rotate", "machine.set", "mode.hold", "mode.release", "notifications.get", "notifications.set", "onboarding.skip", "repo.add", "repo.list", "repo.remove", "routing.get", "routing.route", "routing.set", "routing.status", "runner.remove", "runner.reorder", "runner.set", "runner.settings.get", "runner.settings.save", "setup.check", "snapshot.get", "strategy.list", "strategy.remove", "strategy.save", "strategy.show", "strategy.use", "task.diff", "task.dismiss", "task.get", "task.list", "task.log", "task.prune", "task.request_review", "task.restore", "task.stop", "task.wait", "test.echo", "version.get"]);
    expect(stderr).toContain("native _debug.native");
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } fixture.cleanup(); }
}, 30000);

test.skipIf(!front)("stdio accepts hello before native dispatch and flips back to v2", async () => {
  const fixture = setup();
  const child = Bun.spawn([front!, "api", "--stdio"], { env: fixture.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    const lines = [rpc(1, "test.echo", { n: 1 }), rpc(2, "hello", { protocol: 3 }), rpc(3, "test.echo", { n: 3 }),
      rpc(4, "hello", { protocol: 9 }), rpc(5, "test.echo", { n: 5 }), rpc(6, "hello", { protocol: 2 }), rpc(7, "test.echo", { n: 7 }),
      "{", rpc(8, "hello", { protocol: 3 }), rpc(9, "test.echo", { n: 9 })];
    await child.stdin.write(lines.join("\n") + "\n"); await child.stdin.end();
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, stderr).toBe(0);
    const replies = stdout.trim().split("\n").map(line => JSON.parse(line));
    const byId = (id: number) => replies.find(reply => reply.id === id);
    expect(byId(1).error.data.code).toBe("unknown_op");
    expect(byId(2).result.protocol).toBe("3.0.0");
    expect(byId(3).result).toEqual({ n: 3 });
    expect(byId(4).error.data.code).toBe("invalid_input");
    expect(byId(5).result).toEqual({ n: 5 });
    expect(byId(6).result.protocol).toBe("2.8.0");
    expect(byId(7).error.data.code).toBe("unknown_op");
    expect(byId(8).result.protocol).toBe("3.0.0");
    expect(byId(9).result).toEqual({ n: 9 });
    expect(replies.some(reply => reply.error?.code === -32700)).toBe(true);
    expect(stderr.split("\n").filter(line => line.startsWith("native test.echo"))).toEqual([
      "native test.echo 3", "native test.echo 5", "native test.echo 9",
    ]);
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } fixture.cleanup(); }
}, 30000);

test.skipIf(!front)("stdio hello notifications negotiate only with accepted parameters", async () => {
  const fixture = setup();
  const child = Bun.spawn([front!, "api", "--stdio"], { env: fixture.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const notification = (params: unknown) => JSON.stringify({ jsonrpc: "2.0", method: "hello", params });
  try {
    const lines = [
      notification({ protocol: 3 }), rpc(1, "test.echo", { n: 1 }),
      notification({ protocol: 9 }), rpc(2, "test.echo", { n: 2 }),
      notification([]), rpc(3, "test.echo", { n: 3 }),
      notification({ protocol: 2 }), rpc(4, "test.echo", { n: 4 }),
      notification({ protocol: 3 }), rpc(5, "test.echo", { n: 5 }),
    ];
    await child.stdin.write(lines.join("\n") + "\n"); await child.stdin.end();
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, stderr).toBe(0);
    const replies = stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(replies.map(reply => reply.id).sort()).toEqual([1, 2, 3, 4, 5]);
    for (const id of [1, 2, 3, 5]) expect(replies.find(reply => reply.id === id).result).toEqual({ n: id });
    expect(replies.find(reply => reply.id === 4).error.data.code).toBe("unknown_op");
    expect(stderr.split("\n").filter(line => line.startsWith("native test.echo"))).toEqual([
      "native test.echo 1", "native test.echo 2", "native test.echo 3", "native test.echo 5",
    ]);
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } fixture.cleanup(); }
}, 30000);

test.skipIf(!front)("HTTP native route enforces auth, version, body limit and forward override", async () => {
  const fixture = setup();
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!; reservation.stop(true);
  const child = Bun.spawn([front!, "serve", "--port", String(port)], { env: fixture.env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const stderrText = new Response(child.stderr).text();
  const base = `http://127.0.0.1:${port}`;
  try {
    let token = "";
    for (let n = 0; n < 500; n++) {
      try { token = readFileSync(join(fixture.env.PACER_HOME, "token"), "utf8").trim();
        const response = await fetch(base + "/v3/hello", { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) });
        if (response.ok) break;
      } catch {}
      await Bun.sleep(20);
    }
    expect(token).not.toBe("");
    const post = async (path: string, body: string, authorization = `Bearer ${token}`) => {
      const response = await fetch(base + path, { method: "POST", headers: { Authorization: authorization }, body, signal: AbortSignal.timeout(5000) });
      const text = await response.text(); return { status: response.status, type: response.headers.get("content-type"), body: text.startsWith("{") ? JSON.parse(text) : text };
    };
    expect((await post("/v3/ops/test.echo", "{}", "Bearer wrong")).status).toBe(401);
    expect((await post("/v3/ops/test.echo", "{}", `Bearer pwg_${"a".repeat(64)}`)).status).toBe(403);
    const result = await post("/v3/ops/test.echo", '{"ok":true}');
    expect(result).toEqual({ status: 200, type: "application/json;charset=utf-8", body: { result: { ok: true } } });
    expect((await post("/v2/ops/test.echo", "{}")).body.error.code).toBe("unknown_op");
    expect((await post("/v3/ops/test.echo", "{")).body.error.code).toBe("invalid_input");
    const large = await post("/v3/ops/test.echo", "x".repeat(256 * 1024 + 1));
    expect(large.status).toBe(413); expect(large.body.error.code).toBe("too_large");
    const aborted = httpRequest(base + "/v3/ops/test.echo", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Length": "100" } });
    aborted.on("error", () => {});
    aborted.write('{"unfinished":');
    aborted.destroy();
    await Bun.sleep(50);
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([child.exited, Bun.sleep(5000)]); if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
    fixture.cleanup();
  }
  expect((await stderrText).match(/^native test\.echo$/gm)).toHaveLength(1);
}, 30000);

test.skipIf(!front)("PACER_FORWARD_OPS forces stdio echo back to TypeScript", async () => {
  const fixture = setup();
  const child = Bun.spawn([front!, "api", "--stdio"], { env: { ...fixture.env, PACER_FORWARD_OPS: "test.echo" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    await child.stdin.write([rpc(1, "hello", { protocol: 3 }), rpc(2, "test.echo", { ok: true })].join("\n") + "\n");
    await child.stdin.end();
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit).toBe(0);
    const replies = stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(replies.find(reply => reply.id === 2).error.data.code).toBe("unknown_op");
    expect(stderr).toContain("PACER_FORWARD_OPS=test.echo");
    expect(stderr).not.toContain("native test.echo");
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } fixture.cleanup(); }
}, 30000);

test.skipIf(!front)("PACER_FORWARD_OPS forces HTTP echo back to TypeScript", async () => {
  const fixture = setup();
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!; reservation.stop(true);
  const child = Bun.spawn([front!, "serve", "--port", String(port)], { env: { ...fixture.env, PACER_FORWARD_OPS: "test.echo" }, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const base = `http://127.0.0.1:${port}`;
  try {
    let token = "";
    let ready = false;
    for (let n = 0; n < 500; n++) {
      try { token = readFileSync(join(fixture.env.PACER_HOME, "token"), "utf8").trim();
        const response = await fetch(base + "/v3/hello", { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) });
        if (response.ok) { ready = true; break; }
      } catch {}
      await Bun.sleep(20);
    }
    expect(ready).toBe(true);
    const response = await fetch(base + "/v3/ops/test.echo", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{}" });
    expect(response.status).toBe(404);
    expect((await response.json() as any).error.code).toBe("unknown_op");
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([child.exited, Bun.sleep(5000)]); if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
    fixture.cleanup();
  }
}, 30000);


test.skipIf(!productionFront)("HTTP config environment matches the forwarded core for legacy settings and save author", async () => {
  for (const override of ["override", "", undefined]) {
    const outputs = [];
    for (const forwarded of [false, true]) {
      const fixture = setup();
      const xdg = join(fixture.home, "xdg");
      const legacy = override ? join(fixture.home, override) : process.platform === "darwin"
        ? join(fixture.home, "Library/Application Support/orca") : join(xdg, "orca");
      mkdirSync(join(legacy, "plugins-data/lamtuanvu.pacer"), {recursive:true, mode:0o700});
      writeFileSync(join(legacy, "plugins-data/lamtuanvu.pacer/settings.json"), '{"notifications":"off"}', {mode:0o600});
      writeFileSync(join(fixture.env.PACER_HOME, "strategy.yaml"), golden.initial, {mode:0o600});
      const reservation = Bun.serve({hostname:"127.0.0.1", port:0, fetch:() => new Response()});
      const port = reservation.port!; reservation.stop(true);
      const env = {...fixture.env, XDG_CONFIG_HOME:xdg, PACER_AGENT:"alice", PACER_FORWARD_OPS:forwarded ? "*" : "",
        ...(override === undefined ? {} : {PACER_ORCA_USER_DATA:override ? legacy : ""})};
      const child = Bun.spawn([productionFront!, "serve", "--port", String(port)], {env, stdin:"ignore", stdout:"ignore", stderr:"pipe"});
      const errors = new Response(child.stderr).text();
      const base = `http://127.0.0.1:${port}`;
      try {
        let token = "", ready = false;
        for (let attempt=0; attempt<500; attempt++) {
          try {
            token = readFileSync(join(fixture.env.PACER_HOME, "token"), "utf8").trim();
            if ((await fetch(base+"/v3/hello", {headers:{Authorization:`Bearer ${token}`}, signal:AbortSignal.timeout(500)})).ok) {ready=true; break;}
          } catch {}
          await Bun.sleep(20);
        }
        expect(ready).toBe(true);
        const call = async (op: string, params: unknown) => {
          const response = await fetch(base+`/v3/ops/${op}`, {method:"POST", headers:{Authorization:`Bearer ${token}`, "Content-Type":"application/json"}, body:JSON.stringify(params), signal:AbortSignal.timeout(10000)});
          const body = await response.json(); expect(response.status, JSON.stringify(body)).toBe(200); return body;
        };
        expect(await call("notifications.get", {})).toEqual({result:{level:"off"}});
        const settings = readFileSync(join(fixture.env.PACER_HOME, "settings.json"), "utf8");
        const saved = await call("strategy.save", {name:"review", draft:{from:"default"}, reason:"environment parity"});
        const yaml = readFileSync(join(fixture.env.PACER_HOME, "strategies/review.yaml"), "utf8");
        expect(yaml).toContain("# created by alice on ");
        outputs.push({settings, saved:JSON.stringify(saved).replaceAll(fixture.env.PACER_HOME,"$HOME"), yaml:yaml.replace(/on [^ ]+: environment parity/, "on $DATE: environment parity")});
      } finally {
        if (child.exitCode === null) {child.kill("SIGTERM"); await child.exited;}
        const stderr = await errors;
        expect(stderr.includes("native notifications.get")).toBe(!forwarded);
        expect(stderr.includes("native strategy.save")).toBe(!forwarded);
        fixture.cleanup();
      }
    }
    expect(outputs[0]).toEqual(outputs[1]);
  }
}, 120_000);
