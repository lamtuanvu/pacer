import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installFixture } from "../conformance/install";
import { CoreError } from "../src/core/errors";
import { HOST_SOCKET_KEY_ENV, takeOwnerKey } from "../src/plugins/host-bridge";
import { manifestSchema } from "../src/plugins/protocol";
import { PluginRegistry } from "../src/plugins/registry";
import { fakeCtx } from "./helpers";
import { front, makeHome, ownerOn, serve, tsOwner, type Home, type Options } from "./native-plugin-door";

// A Core call with a long deadline gives `plugin.hello` 10 s (HELLO_DEADLINE_MS) flag-off and on the
// native owner, and words a hello timeout the same way. Calls whose own deadline is shorter, such as
// plugin.doctor's 5 s ping, expire as the call instead.
// Flag-off records a hello timeout as a crash (`restarts`, backoff); the owner has no such accounting.

const manifest = (id: string) => manifestSchema.parse({ id, version: "1.0.0", publisher: "pacer", host: "^1.6", contributes: { diagnostic: {} }, capabilities: [], tier: "free" });
/** Answers `plugin.hello` after `delay` ms, or never when it is `never`. */
const child = (delay: string) => `const r=Bun.stdin.stream().getReader();let b='';const delay=${JSON.stringify(delay)};const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));for(;;){const {value,done}=await r.read();if(done)break;b+=new TextDecoder().decode(value);while(b.includes('\\n')){const i=b.indexOf('\\n'),m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='plugin.hello'){if(delay!=='never')setTimeout(()=>send({id:m.id,result:{protocol:m.params.protocol,id:m.params.manifest.id,version:'1.0.0',contributes:['diagnostic']}}),Number(delay));}else if(m.method==='diagnostic.ping')send({id:m.id,result:{ok:true,uptimeS:0}});}}`;
const DELAYS: Record<string, string> = { "fx-slow": "6000", "fx-silent": "never" };

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

type Outcome = { ok: true } | { code: string; message: string; afterMs: number };

async function pings(h: Home, socket?: string): Promise<Record<string, Outcome>> {
  // In-process Core proves the owner's per-start key, as serve's Core child does.
  if (socket) takeOwnerKey({ [HOST_SOCKET_KEY_ENV]: readFileSync(join(h.state, "run", "host.key"), "utf8").trim() });
  const ctx = fakeCtx({ home: h.home, pacerHome: h.state, env: { PATH: process.env.PATH!, ...(socket ? { PACER_HOST_SOCKET: socket } : {}) } });
  const registry = new PluginRegistry({ bundled: Object.keys(DELAYS).map(id => ({ manifest: manifest(id), main: async () => ({ handlers: {} }) })),
    spawnBundled: (_ctx, id) => ({ argv: [process.execPath, "-e", child(DELAYS[id]!)], cwd: h.home, env: {} }), eventPumpMs: 0 });
  cleanups.push(() => registry.shutdown());
  return Object.fromEntries(await Promise.all(Object.keys(DELAYS).map(async id => {
    const started = Date.now();
    try {
      await registry.call(ctx, id, "diagnostic.ping", {}, { deadlineMs: 30000 });
      return [id, { ok: true }];
    } catch (error) {
      if (!(error instanceof CoreError)) throw error;
      return [id, { code: error.code, message: error.message, afterMs: Date.now() - started }];
    }
  })));
}

type Doctor = { ok: boolean; error: string | null; restarts: number };

/** `plugin.doctor` for a child that answers its hello after 6 s and one that never does. */
async function doctors(options: Options, forward = ""): Promise<Record<string, Doctor>> {
  const h = makeHome();
  cleanups.push(() => h.done());
  const delays: Record<string, number> = { "fx-slow": 6000, "fx-silent": 600_000 };
  for (const [id, startDelayMs] of Object.entries(delays)) installFixture("good", join(h.state, "plugins"), { manifest: { id }, fixture: { startDelayMs } });
  const service = await serve(h, forward, options);
  cleanups.push(() => service.stop());
  for (const id of Object.keys(delays)) await service.call("plugin.enable", { id, grant: true });
  return Object.fromEntries(await Promise.all(Object.keys(delays).map(async id => {
    const { ok, error, restarts } = (await service.call("plugin.doctor", { id })).json.result.reports[0];
    return [id, { ok, error, restarts }];
  })));
}
const outcome = (seen: Record<string, Doctor>) => Object.fromEntries(Object.entries(seen).map(([id, { ok, error }]) => [id, { ok, error }]));

test.skipIf(!front)("plugin.doctor's 5 s ping bounds the hello flag-off, and Core's doctor on the native owner matches", async () => {
  const off = await doctors(tsOwner);
  const core = await doctors(ownerOn, "plugin.doctor");
  console.log(JSON.stringify({ off, core }));
  const expired = { ok: false, error: "plugin_timeout: plugin call passed its absolute deadline" };
  expect(outcome(off)).toEqual({ "fx-slow": expired, "fx-silent": expired });
  expect(outcome(core)).toEqual(outcome(off));
}, 90000);

test.skipIf(!front)("plugin.hello gets 10 s and the same timeout text flag-off and on the native owner", async () => {
  const h = makeHome();
  cleanups.push(() => h.done());
  const off = await pings(h);
  const service = await serve(h, "", ownerOn);
  cleanups.push(() => service.stop());
  const on = await pings(h, join(h.state, "run", "host.sock"));
  console.log(JSON.stringify({ off, on }));
  for (const [mode, seen] of Object.entries({ off, on })) {
    expect(seen["fx-slow"], mode).toEqual({ ok: true });
    expect(seen["fx-silent"], mode).toMatchObject({ code: "plugin_timeout", message: "plugin.hello passed its 10000 ms deadline" });
    const { afterMs } = seen["fx-silent"] as { afterMs: number };
    expect(afterMs, mode).toBeGreaterThanOrEqual(10000);
    expect(afterMs, mode).toBeLessThan(15000);
  }
}, 90000);
