// Parity for the native front-door meta routes: `/v3/hello`, `/v3/snapshot`
// and `/v3/session/exchange`. Each runs against the Rust door and, with the
// matching `PACER_FORWARD_OPS` escape, against the TypeScript core; the two
// must agree on the wire behaviour they own (hello shape, the session
// cookie, the snapshot cache), so a native answer never drifts from the
// reference the forward path still serves.
import { expect, test } from "bun:test";
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { closedPort, pinnedEnv as pinnedPort, spawnPinned } from "./pinned-port";
import { fakeServiceManager } from "./child-env";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const agentFreePath = `${join(process.env.HOME!, "bin")}:/usr/bin:/bin`;

function setup() {
  const home = mkdtempSync("/tmp/pnm-");
  mkdirSync(join(home, ".pacer"), { mode: 0o700 });
  const env = {
    HOME: home,
    PACER_HOME: join(home, ".pacer"),
    PATH: `${fakeServiceManager(home)}:${agentFreePath}`,
    PACER_CORE_ARGV: core,
    PACER_NO_UPDATE_CHECK: "1",
    PACER_NO_SELF_REPAIR: "1",
    PACER_DISCOVERY: "off",
    PACER_DEBUG_NATIVE: "1",
  };
  return { home, env, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** Boot a Rust serve door, optionally forcing a meta route back to the core. */
async function start(fixture: ReturnType<typeof setup>, forward: string | null) {
  const port = closedPort();
  const child = spawnPinned([front!, "serve", "--port", String(port)], {
    env: pinnedPort({ ...fixture.env, ...(forward ? { PACER_FORWARD_OPS: forward } : {}) }, port),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  const base = `http://127.0.0.1:${port}`;
  let token = "";
  for (let n = 0; n < 1000; n++) {
    try {
      token = readFileSync(join(fixture.env.PACER_HOME, "token"), "utf8").trim();
      // Native meta routes answer without Core; a PACER_FORWARD_OPS escape needs
      // Core. /health only reflects the door, so wait on /v2/hello when forwarding.
      const probe = forward
        ? await fetch(`${base}/v2/hello`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(500),
          })
        : await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
      if (probe.ok) break;
    } catch {}
    await Bun.sleep(20);
  }
  expect(token).not.toBe("");
  return {
    base,
    token,
    stderr,
    child,
    stop: async () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([child.exited, Bun.sleep(5000)]);
        if (child.exitCode === null) {
          child.kill("SIGKILL");
          await child.exited;
        }
      }
      await stderr;
    },
  };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      out[key] = normalize(entry);
    }
    return out;
  }
  return value;
}

type Door = Awaited<ReturnType<typeof start>>;

test.skipIf(!front)("native and forwarded /v3/hello share one body shape on the Rust door", async () => {
  const fixture = setup();
  const native = await start(fixture, null);
  const forwarded = await start(fixture, "http.hello");
  try {
    const body = async (s: Door): Promise<any> => {
      const response = await fetch(`${s.base}/v3/hello`, {
        headers: auth(s.token),
        signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-pacer")).toBe("1");
      return normalize(await response.json());
    };
    const a = await body(native);
    const b = await body(forwarded);
    // Both doors must carry the protocol, pacer, ops and events lines; the
    // forwarded coreBuild comes from the core, the native one from the core's
    // descriptor, so they must agree too.
    expect(a.protocol).toBe("3.0.0");
    expect(b.protocol).toBe("3.0.0");
    expect(a.ops).toBeDefined();
    expect(a.events).toBeDefined();
    expect(b.ops).toBeDefined();
    expect(b.events).toBeDefined();
    expect(a.pacer).toBe(b.pacer);
    expect(a.coreBuild).toEqual(b.coreBuild);
    const shared = {
      lhs: { ...(a as any), pacer: undefined, coreBuild: undefined },
      rhs: { ...(b as any), pacer: undefined, coreBuild: undefined },
    };
    expect(shared.lhs).toEqual(shared.rhs);
  } finally {
    await native.stop();
    await forwarded.stop();
    fixture.cleanup();
  }
}, 60_000);

test.skipIf(!front)("/v3/snapshot serves the cache and mode.hold refreshes it on the Rust door", async () => {
  const fixture = setup();
  const native = await start(fixture, null);
  const forwarded = await start(fixture, "http.snapshot");
  try {
    const get = async (s: Door, p: string) => {
      const r = await fetch(`${s.base}${p}`, { headers: auth(s.token), signal: AbortSignal.timeout(5000) });
      expect(r.status).toBe(200);
      expect(r.headers.get("x-pacer")).toBe("1");
      return r.json() as Promise<any>;
    };
    // The wire is served with the v3 protocol and a snapshot body; the cold
    // "starting" state before the first status is covered deterministically
    // by the Rust unit test (CoreChild::unavailable), so it is not asserted
    // here after the door has booted against a ready core.
    const cold = await get(native, "/v3/snapshot");
    expect(cold.protocol).toBe("3.0.0");
    expect(cold.snapshot.service).toBeDefined();
    const forwardedCold = await get(forwarded, "/v3/snapshot");
    expect(forwardedCold.protocol).toBe("3.0.0");
    expect(forwardedCold.snapshot.service).toBeDefined();

    // Within the one-second max age a second read is served from the cache.
    const warm = await get(native, "/v3/snapshot");
    expect(warm.seq).toBe(cold.seq);

    // mode.hold (+release) refreshes the cache and never leaves it unable to answer.
    // `mode.hold` requires a `mode` (and a future `until` keeps it native); the
    // Rust schema rejects an empty body with a 400.
    const until = Math.floor(Date.now() / 1000) + 86400;
    const hold = await fetch(`${native.base}/v3/ops/mode.hold`, {
      method: "POST",
      headers: { ...auth(native.token), "content-type": "application/json" },
      body: JSON.stringify({ mode: "normal", until }),
      signal: AbortSignal.timeout(5000),
    });
    expect(hold.status).toBe(200);
    const held = await get(native, "/v3/snapshot");
    expect(held.snapshot.service).toBeDefined();
    // The hold is on disk and the cache refresh must still answer (wire hold
    // visibility under a live status is covered by mode-hold unit coverage).
    const release = await fetch(`${native.base}/v3/ops/mode.release`, {
      method: "POST",
      headers: { ...auth(native.token), "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(5000),
    });
    expect(release.status).toBe(200);
    const after = await get(native, "/v3/snapshot");
    expect(after.snapshot.service).toBeDefined();
  } finally {
    await native.stop();
    await forwarded.stop();
    fixture.cleanup();
  }
}, 60_000);

test.skipIf(!front)("session exchange sets one cookie shape on both doors and refuses cookie callers", async () => {
  const fixture = setup();
  const native = await start(fixture, null);
  const forwarded = await start(fixture, "http.session_exchange");
  try {
    const exchange = async (s: Door) => {
      const r = await fetch(`${s.base}/v3/session/exchange`, {
        method: "POST",
        headers: { ...auth(s.token), "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(5000),
      });
      expect(r.status).toBe(204);
      expect(await r.text()).toBe("");
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("x-pacer")).toBe("1");
      const cookie = r.headers.get("set-cookie")!;
      expect(cookie).toContain("HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000");
      expect(cookie).toMatch(/^pacer_session=[A-Za-z0-9_-]+;/);
      return { cookie, session: cookie.split(";")[0]!.slice("pacer_session=".length) };
    };
    const [n, f] = [await exchange(native), await exchange(forwarded)];
    // A cookie-only caller holding a fresh session is refused (auth.rs).
    for (const { cookie } of [n, f]) {
      const refused = await fetch(`${native.base}/v3/session/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: "{}",
        signal: AbortSignal.timeout(5000),
      });
      expect(refused.status).toBe(403);
    }
    // A GET is refused (POST only) with a 405 on both doors.
    for (const s of [native, forwarded]) {
      const wrong = await fetch(`${s.base}/v3/session/exchange`, {
        headers: auth(s.token),
        signal: AbortSignal.timeout(5000),
      });
      expect(wrong.status).toBe(405);
    }
  } finally {
    await native.stop();
    await forwarded.stop();
    fixture.cleanup();
  }
}, 60_000);