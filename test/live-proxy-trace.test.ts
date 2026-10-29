import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort, type Session } from "../scripts/live/core";
import { startProxy } from "../scripts/live/proxy";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(enabled: boolean): Promise<Session> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "proxy-trace-"))); roots.push(root);
  chmodSync(root, 0o700);
  mkdirSync(join(root, "evidence"), { mode: enabled ? 0o700 : 0o755 });
  const port = await freePort(); let innerPort = await freePort();
  while (innerPort === port) innerPort = await freePort();
  return { root, id: "trace", pid: process.pid, port, innerPort, createdAt: "now" };
}
function traceFile(session: Session) { return join(session.root, "evidence/ota-request-trace.jsonl"); }
function rows(session: Session): { correlationId: string; stage: string; outcome: string; elapsedMs: number; status?: number }[] {
  return readFileSync(traceFile(session), "utf8").trim().split("\n").map(line => JSON.parse(line));
}
test("real loopback proxy tracing preserves refusal, delayed forwarding and upstream errors", async () => {
  const results: unknown[][] = [];
  for (const enabled of [false, true]) {
    const session = await fixture(enabled), observed: unknown[] = [];
    let seen = 0, arrived!: () => void, release!: () => void;
    const arrival = new Promise<void>(resolve => { arrived = resolve; });
    const delay = new Promise<void>(resolve => { release = resolve; });
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: session.innerPort, async fetch(req) {
      seen++; arrived(); await delay;
      return new Response("secret-upstream-body", { status: 202, headers: { "x-synthetic": "fixed", "set-cookie": "secret-cookie=1; HttpOnly" } });
    } });
    const proxy = startProxy(session), url = `http://127.0.0.1:${session.port}/v3/ops/desktop.update.check`;
    try {
      const refused = await fetch(url, { method: "POST", body: '{"requestId":"secret-request","nonce":"secret-nonce"}', headers: { authorization: "Bearer secret-token" } });
      observed.push([refused.status, await refused.text()]);
      expect(seen).toBe(0);
      if (enabled) expect(rows(session).map(row => [row.stage, row.outcome])).toEqual([["body", "start"], ["body", "pass"], ["initial-policy", "start"], ["initial-policy", "error"], ["forward", "refused"]]);
      // Non-mutating wrong-method probe: it exercises forwarding, never the native gate.
      const pending = fetch(url, { headers: { authorization: "Bearer secret-token", cookie: "secret-cookie=1" } });
      await arrival;
      if (enabled) {
        const events = rows(session);
        expect(events.at(-1)?.stage).toBe("forward");
        expect(events.at(-1)?.outcome).toBe("start");
        expect(events.filter(row => row.stage === "upstream")).toHaveLength(0);
      }
      release();
      const forwarded = await pending;
      observed.push([forwarded.status, forwarded.headers.get("x-synthetic"), forwarded.headers.getSetCookie(), await forwarded.text()]);
      expect(seen).toBe(1);
      upstream.stop(true);
      const failed = await fetch(url);
      observed.push([failed.status, await failed.text()]);
      if (enabled) {
        const events = rows(session), groups = Map.groupBy(events, row => row.correlationId);
        expect(groups.size).toBe(3);
        const [, forwardedEvents, failedEvents] = [...groups.values()];
        expect(forwardedEvents.map(row => [row.stage, row.outcome])).toEqual([["forward", "start"], ["upstream", "response"]]);
        expect(forwardedEvents[1].status).toBe(202);
        expect(forwardedEvents[1].elapsedMs).toBeGreaterThanOrEqual(forwardedEvents[0].elapsedMs);
        expect(failedEvents.map(row => [row.stage, row.outcome])).toEqual([["forward", "start"], ["upstream", "error"]]);
        expect(readFileSync(traceFile(session), "utf8")).not.toContain("secret");
        const before = readFileSync(traceFile(session), "utf8");
        await fetch(`http://127.0.0.1:${session.port}/app/secret-path`);
        expect(readFileSync(traceFile(session), "utf8")).toBe(before);
      } else expect(existsSync(traceFile(session))).toBe(false);
      results.push(observed);
    } finally { release(); proxy.stop(true); upstream.stop(true); }
  }
  expect(results[0]).toEqual(results[1]);
});

test("aborting a delayed loopback request preserves client cancellation with tracing unavailable or enabled", async () => {
  const outcomes: string[] = [];
  for (const enabled of [false, true]) {
    const session = await fixture(enabled);
    let arrived!: () => void, release!: () => void;
    const arrival = new Promise<void>(resolve => { arrived = resolve; });
    const delayed = new Promise<void>(resolve => { release = resolve; });
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: session.innerPort, async fetch() {
      arrived(); await delayed;
      return new Response("delayed synthetic response");
    } });
    const proxy = startProxy(session), controller = new AbortController();
    try {
      const pending = fetch(`http://127.0.0.1:${session.port}/v3/ops/desktop.update.check`, { signal: controller.signal }).then(() => "response", error => error.name as string);
      await arrival;
      if (enabled) expect(rows(session).at(-1)).toMatchObject({ stage: "forward", outcome: "start" });
      controller.abort();
      outcomes.push(await pending);
      expect(outcomes.at(-1)).toBe("AbortError");
      release();
    } finally { release(); proxy.stop(true); upstream.stop(true); }
  }
  expect(outcomes[0]).toBe(outcomes[1]);
});
