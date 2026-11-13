import { afterAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installFixture } from "../conformance/install";
import { installKeychainStub } from "../scripts/live/keychain";
import { front, ownerOn, type Reply, serve, tsOwner } from "./native-plugin-door";
import { closedPort } from "./pinned-port";

// The assistant's endpoint key crosses Core's own bridge connection to the owner for the one
// assistant.respond call that resolves it, and nowhere else: not to another plugin, during the
// turn or after it, not to a credential-bound endpoint or classifier call, and never into a log,
// a store or an error.

const KEY = `sk-pacer-fixture-${randomBytes(16).toString("hex")}`;
const root = mkdtempSync("/tmp/pak-");
afterAll(async () => { await Bun.sleep(1000); rmSync(root, { recursive: true, force: true }); });

const refusal = (method: string) => `${method} needs credential bindings, which the native process owner bridge does not carry`;

/** An OpenAI-compatible endpoint that records each Authorization header and holds the first chat completion until released. */
function endpoint() {
  const authorizations: string[] = [];
  let arrived!: () => void, release!: () => void;
  const inFlight = new Promise<void>(resolve => { arrived = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    authorizations.push(request.headers.get("authorization") ?? "<none>");
    if (!new URL(request.url).pathname.endsWith("/chat/completions")) return Response.json({ data: [{ id: "m1" }] });
    arrived();
    await released;
    return Response.json({ choices: [{ message: { content: "Fixture answer." } }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
  } });
  return { server, authorizations, inFlight, release };
}

function keyHome(label: string, chat: number) {
  const home = join(root, label), state = join(home, ".pacer"), bin = join(home, "bin"), keychain = join(home, "keychain");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  symlinkSync(join(import.meta.dir, "../node_modules"), join(home, "node_modules"), "dir");
  installKeychainStub(bin, keychain);
  symlinkSync(process.execPath, join(bin, "bun"));
  writeFileSync(join(keychain, "pacer.endpoint_ep"), Buffer.from(KEY).toString("hex"), { mode: 0o600 });
  writeFileSync(join(state, "strategy.yaml"), `planner: claude-code
accounts:
  claude-code: {kind: claude}
  ep: {kind: endpoint, usage: unmetered, connection: {api: openai-compatible, base_url: "http://127.0.0.1:${chat}/v1", key: keychain, models: [{id: m1, context: 1000, output: 100, tools: false}]}}
runners:
  claude-code: {}
  opencode#ep: {model: m1}
`, { mode: 0o600 });
  const peek = installFixture("good", join(state, "plugins"), {
    manifest: { id: "fx-peek", host: "^1.6", capabilities: [{ name: "log" }, { name: "secrets.resolve" }] },
    fixture: { callCapability: "secrets.resolve", capabilityParams: { ref: "endpoint:ep" }, capabilityResultFile: "peek.json" },
  });
  return { home, state, plugin: peek, keychain, done: () => rmSync(home, { recursive: true, force: true }) };
}

/** Every file under the home except the Keychain stub's store, which holds the key by design. */
function homeFiles(home: string, skip: string): string[] {
  const out: string[] = [];
  const walk = (path: string) => {
    if (path === skip) return;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) { for (const name of readdirSync(path)) walk(join(path, name)); return; }
    out.push(path);
  };
  walk(home);
  return out;
}

type Report = { ok?: boolean; error?: string };
type Seen = { turn: { state?: string; answer?: string; error?: string }; concurrent: Report; later: Report; endpointCalls: Record<string, unknown>; authorized: boolean; leaks: string[] };

async function scenario(label: string, options: typeof tsOwner): Promise<Seen> {
  const chat = endpoint();
  const h = keyHome(label, chat.server.port!);
  const env = { PATH: `${join(h.home, "bin")}:/usr/bin:/bin`, PACER_TEST_LOCAL_SERVER_PORTS: `${closedPort()},${closedPort()}`, OLLAMA_HOST: `127.0.0.1:${closedPort()}` };
  const door = await serve(h, "", { ...options, env });
  const replies: Reply[] = [];
  const call = async (op: string, params: unknown) => { const reply = await door.call(op, params); replies.push(reply); return reply; };
  const doctor = async () => (await call("plugin.doctor", { id: "fx-peek" })).json.result?.reports?.[0];
  let stderr = "";
  try {
    expect((await call("plugin.enable", { id: "fx-peek", grant: true })).json.error).toBeUndefined();
    expect((await call("assistant.settings.set", { runner: "opencode#ep", account: "ep", expect_rev: 1 })).json.error).toBeUndefined();
    const ask = await call("assistant.ask", { text: "What is running?", scope: { kind: "dispatch", days: 7 }, requestId: `key-${label}` });
    const turnId = ask.json.result?.turnId;
    expect(turnId, ask.line).toBeString();
    await Promise.race([chat.inFlight, Bun.sleep(30000)]);
    const concurrent = await doctor();
    chat.release();
    let turn: Reply;
    for (const deadline = Date.now() + 30000; ;) {
      turn = await call("assistant.turn", { turnId });
      if (turn.json.result?.state !== "running" || Date.now() > deadline) break;
      await Bun.sleep(100);
    }
    const later = await doctor();
    const endpointCalls = Object.fromEntries(await Promise.all([
      ["account.models keyless", "account.models", { name: "ep" }],
      ["account.test", "account.test", { name: "ep" }],
      ["routing.route goal", "routing.route", { goal: "fix the parser" }],
    ].map(async ([key, op, params]) => { const reply = await call(op as string, params); return [key, reply.json.error ?? reply.json.result] as const; })));
    stderr = await door.stop();
    const files = homeFiles(h.home, h.keychain);
    const leaks = [
      ...files.filter(file => readFileSync(file).includes(KEY)).map(file => file.replace(h.home, "<HOME>")),
      ...(stderr.includes(KEY) ? ["serve stderr"] : []),
      ...replies.filter(reply => reply.line.includes(KEY)).map(reply => `reply ${reply.line.slice(0, 80)}`),
    ];
    expect(existsSync(join(h.plugin, "peek.json"))).toBe(false);
    return {
      turn: { state: turn!.json.result?.state, answer: turn!.json.result?.answer, error: turn!.json.result?.error },
      concurrent: { ok: concurrent?.ok, error: concurrent?.error }, later: { ok: later?.ok, error: later?.error },
      endpointCalls, authorized: chat.authorizations.includes(`Bearer ${KEY}`), leaks,
    };
  } finally {
    if (!stderr) await door.stop();
    chat.server.stop(true);
    h.done();
  }
}

test.skipIf(!front)("the assistant key reaches its own endpoint flag-on as flag-off, and no other call, plugin, log or error", async () => {
  const off = await scenario("off", tsOwner);
  const on = await scenario("on", ownerOn);
  console.log(JSON.stringify({ off, on }));
  expect(on.turn).toEqual(off.turn);
  for (const seen of [off, on]) {
    expect(seen.turn.state).toBe("done");
    expect(seen.turn.answer).toContain("Fixture answer.");
    expect(seen.authorized).toBe(true);
    expect(seen.leaks).toEqual([]);
    expect(seen.concurrent.ok).toBe(false);
    expect(seen.concurrent.error).toStartWith("capability_denied: ");
    expect(seen.later).toEqual(seen.concurrent);
  }
  expect(off.concurrent).toEqual({ ok: false, error: "capability_denied: plugin fx-peek may not resolve assistant secrets" });
  // DOOR_SECRET_TEXT: plugin.doctor runs on the Rust door's own owner call, which forwards no method to Core,
  // so the owner's broker refuses the unissued secret with its own text and the same code.
  expect(on.concurrent).toEqual({ ok: false, error: "capability_denied: capability is not granted to the owning call: secret alias was not issued" });
  expect(on.endpointCalls["account.models keyless"]).toMatchObject({ message: refusal("endpoint.models") });
  expect(JSON.stringify(on.endpointCalls["account.test"])).toContain(refusal("endpoint.test"));
  expect(on.endpointCalls["routing.route goal"]).toMatchObject({ message: refusal("classifier.ask") });
}, 240000);
