import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { loadStrategy } from "../src/config/strategy";
import { runStdio } from "../src/api/stdio";
import { computeStatus, statusBrokerParts } from "../src/engine/status";
import { rankExecutors, type ProviderStatus } from "../src/engine/rank";
import { startServer } from "../src/serve/http";
import { draftStrategy, preview } from "../src/strategy/service";
import type { Ctx } from "../src/types";
import { fakeCtx, withLoginIndicators } from "./helpers";

// The sealed usage-broker parts route: HTTP `/_internal/status-broker-parts` and stdio
// `_internal.status-broker.parts`, with its optional `draft` and `cacheOnly` params.

const KEY = "fixture-private-key";
const TOKEN = "s".repeat(64);
const STRATEGY = `planner: claude-code
accounts:
  claude: {kind: claude}
  codex: {kind: codex}
runners:
  claude-code: {}
  codex: {}
pacing: {policy: priority, order: [claude-code, codex]}
`;
/** A saved strategy with an account and runner the active one lacks. */
const WIDE = STRATEGY.replace("  codex: {kind: codex}\n", "  codex: {kind: codex}\n  cursor: {kind: cursor}\n")
  .replace("  codex: {}\n", "  codex: {}\n  cursor: {}\n");

function fixture(): Ctx {
  const ctx = withLoginIndicators(fakeCtx());
  mkdirSync(join(ctx.pacerHome, "strategies"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), STRATEGY);
  writeFileSync(join(ctx.pacerHome, "strategies", "wide.yaml"), WIDE);
  return ctx;
}

/** Every file under PACER_HOME with its bytes and mode. */
function files(ctx: Ctx): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name), stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else out[relative(ctx.pacerHome, path)] = `${(stat.mode & 0o777).toString(8)} ${readFileSync(path, "base64")}`;
    }
  };
  walk(ctx.pacerHome);
  return out;
}

/** The raw reply line, so `{}` can be compared byte for byte. `key` is the core's own key; `null` starts one with none. */
async function stdio(ctx: Ctx, params: unknown, key: string | null = KEY): Promise<string> {
  async function* input() { yield JSON.stringify({ jsonrpc: "2.0", id: 1, method: "_internal.status-broker.parts", params }); }
  const out: string[] = [];
  await runStdio(ctx, input(), line => out.push(line), { nativeConfigKey: key ?? undefined });
  expect(out).toHaveLength(1);
  return out[0]!.trimEnd();
}

/** The home once a just-started server has finished writing its own state. */
async function settled(ctx: Ctx): Promise<Record<string, string>> {
  let last = files(ctx);
  for (;;) {
    await Bun.sleep(150);
    const next = files(ctx);
    if (JSON.stringify(next) === JSON.stringify(last)) return next;
    last = next;
  }
}

type Post = (body: string | undefined, headers?: Record<string, string>) => Promise<{ status: number; text: string }>;
async function withServer<T>(ctx: Ctx, run: (post: Post) => Promise<T>): Promise<T> {
  const s = startServer(() => ctx, { port: 0, pumpMs: 0, internal: { token: TOKEN } });
  try {
    return await run(async (body, headers = { authorization: `Bearer ${TOKEN}` }) => {
      const r = await fetch(`http://127.0.0.1:${s.port}/_internal/status-broker-parts`, {
        method: "POST", headers: { host: `127.0.0.1:${s.port}`, "content-type": "application/json", ...headers }, body,
      });
      return { status: r.status, text: await r.text() };
    });
  } finally { s.stop(); }
}

const ranking = (ctx: Ctx, draft: { from: string; set?: Record<string, unknown> }, parts: { providers: ProviderStatus[] }) =>
  rankExecutors(null, draftStrategy(ctx, draft as never), Object.fromEntries(parts.providers.map(p => [p.id, p]))).ranked.map(x => x.id);

test("the HTTP route admits only the internal bearer and refuses cookie and task callers", async () => {
  const ctx = fixture();
  await withServer(ctx, async post => {
    expect((await post("{}", {})).status).toBe(401);
    expect((await post("{}", { authorization: `Bearer ${"x".repeat(64)}` })).status).toBe(401);
    expect((await post("{}", { authorization: TOKEN })).status).toBe(401);
    const internal = { authorization: `Bearer ${TOKEN}` };
    const before = await settled(ctx);
    for (const body of ["{}", JSON.stringify({ cacheOnly: true }), JSON.stringify({ draft: { from: "wide" } })]) {
      expect(await post(body, { ...internal, "x-pacer-auth": "cookie" })).toEqual({ status: 403, text: "forbidden\n" });
      expect(await post(body, { ...internal, "x-pacer-auth": "task", "x-pacer-work-grant": "Bearer pwg_fixture" })).toEqual({ status: 403, text: "forbidden\n" });
      expect(await post(body, { ...internal, "x-pacer-auth": "task", "x-pacer-work-grant": "Bearer pet_fixture" })).toEqual({ status: 403, text: "forbidden\n" });
      expect(await post(body, { ...internal, "x-pacer-auth": "other" })).toEqual({ status: 403, text: "forbidden\n" });
    }
    expect(files(ctx)).toEqual(before);
    const admitted = await post("{}", { ...internal, "x-pacer-auth": "bearer" });
    expect(admitted.status).toBe(200);
    expect(JSON.parse(admitted.text).result.providers.map((p: ProviderStatus) => p.id)).toEqual(["claude-code", "codex"]);
  });
}, 30000);

test("the sealed stdio method answers unknown_op for a missing or wrong key and for a work-grant caller", async () => {
  const ctx = fixture();
  const granted: Ctx = { ...ctx, env: { ...ctx.env, PACER_WORK_GRANT: "pwg_fixture" } };
  const before = files(ctx);
  for (const extra of [{}, { cacheOnly: true }, { draft: { from: "wide" } }]) {
    const refused = [
      await stdio(ctx, { key: "incorrect", ...extra }),
      await stdio(ctx, { ...extra }),
      await stdio(ctx, null),
      await stdio(ctx, { key: KEY, ...extra }, null),
      await stdio(ctx, { key: "", ...extra }, ""),
      await stdio(granted, { key: KEY, ...extra }),
    ];
    for (const line of refused) {
      expect(JSON.parse(line)).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "unknown operation", data: { code: "unknown_op" } } });
      expect(line).not.toContain(KEY);
    }
  }
  expect(files(ctx)).toEqual(before);
});

test("no params answer the active strategy's parts byte for byte", async () => {
  const ctx = fixture();
  // The reference is the route's reply before params existed; usage readings are cached in this process.
  const reference = async () => statusBrokerParts(await computeStatus(ctx, loadStrategy(ctx)));
  const expected = await reference();
  expect(await stdio(ctx, { key: KEY })).toBe(JSON.stringify({ jsonrpc: "2.0", id: 1, result: expected }));
  await withServer(ctx, async post => {
    for (const body of ["{}", "", undefined, " \n"]) {
      expect(await post(body), String(body)).toEqual({ status: 200, text: JSON.stringify({ result: expected }) });
    }
  });
  expect(await reference()).toEqual(expected);
});

test("cacheOnly answers read-only parts from cached readings and writes nothing", async () => {
  const ctx = fixture();
  const reference = async () => statusBrokerParts(await computeStatus({ ...ctx, readOnly: true }, loadStrategy(ctx), { cacheOnly: true }));
  const before = files(ctx);
  const cached = JSON.parse(await stdio(ctx, { key: KEY, cacheOnly: true })).result;
  expect(files(ctx)).toEqual(before);
  expect(cached).toEqual(await reference());
  expect(cached.providers.map((p: ProviderStatus) => p.id)).toEqual(["claude-code", "codex"]);
  // Nothing was cached and no usage source was read, so every account is stale with no reading.
  for (const account of cached.accounts) expect([account.stale, account.capturedAt]).toEqual([true, null]);
  await withServer(ctx, async post => {
    const started = await settled(ctx);
    const http = await post(JSON.stringify({ cacheOnly: true }));
    expect(http.status).toBe(200);
    expect(JSON.parse(http.text).result).toEqual(await reference());
    expect(files(ctx)).toEqual(started);
  });
  // A fresh home without cacheOnly writes state, so the comparisons above can fail.
  const other = fixture(), fresh = files(other);
  await stdio(other, { key: KEY });
  expect(Object.keys(files(other))).not.toEqual(Object.keys(fresh));
}, 30000);

test("a draft answers preview's current and draft parts, and the draft's ranking equals preview's", async () => {
  const ctx = fixture();
  const draft = { from: "wide", set: { "pacing.order": ["cursor", "codex", "claude-code"] } };
  const reference = await preview(ctx, draft);
  expect(reference.ok).toBe(true);
  for (const reply of [JSON.parse(await stdio(ctx, { key: KEY, draft })).result,
    await withServer(ctx, async post => JSON.parse((await post(JSON.stringify({ draft }))).text).result)]) {
    expect(Object.keys(reply)).toEqual(["current", "draft"]);
    expect(reply.current.providers.map((p: ProviderStatus) => p.id)).toEqual(["claude-code", "codex"]);
    expect(reply.draft.providers.map((p: ProviderStatus) => p.id)).toEqual(["claude-code", "codex", "cursor"]);
    expect(reply.draft.accounts.map((a: { name: string }) => a.name)).toEqual(["claude", "codex", "cursor"]);
    expect(ranking(ctx, { from: "default" }, reply.current)).toEqual(reference.ranking.current);
    expect(ranking(ctx, draft, reply.draft)).toEqual(reference.ranking.draft);
    expect(reference.ranking.draft).toContain("cursor");
  }
  // A failing draft carries preview's errors instead of draft parts.
  const invalid = { from: "default", set: { "pacing.policy": "nope" } };
  const failed = await preview(ctx, invalid);
  expect(failed.ok).toBe(false);
  const reply = JSON.parse(await stdio(ctx, { key: KEY, draft: invalid })).result;
  expect(Object.keys(reply)).toEqual(["current", "errors"]);
  expect(reply.errors).toEqual(failed.errors);
  const unknown = JSON.parse(await stdio(ctx, { key: KEY, draft: { from: "gone" } })).result;
  expect(unknown.errors).toEqual(['unknown strategy "gone"']);
}, 30000);

test("draft mode is read-only, also with cacheOnly", async () => {
  const ctx = fixture();
  const before = files(ctx);
  const draft = { from: "wide" };
  const cached = JSON.parse(await stdio(ctx, { key: KEY, draft, cacheOnly: true })).result;
  expect(cached.draft.providers.map((p: ProviderStatus) => p.id)).toEqual(["claude-code", "codex", "cursor"]);
  for (const account of cached.draft.accounts) expect([account.stale, account.capturedAt]).toEqual([true, null]);
  expect(files(ctx)).toEqual(before);
  await stdio(ctx, { key: KEY, draft });
  expect(files(ctx)).toEqual(before);
}, 30000);

test("unknown or malformed params are invalid_input on both transports", async () => {
  const ctx = fixture();
  const cases: [unknown, string][] = [
    [{ cacheOnly: "yes" }, "cacheOnly: Invalid input: expected boolean, received string"],
    [{ extra: 1 }, 'params: Unrecognized key: "extra"'],
    [{ draft: [] }, "draft: Invalid input: expected object, received array"],
    [{ draft: { from: "" } }, "draft.from: Too small: expected string to have >=1 characters"],
  ];
  await withServer(ctx, async post => {
    const before = await settled(ctx);
    for (const [params, message] of cases) {
      const error = { code: "invalid_input", message };
      expect(JSON.parse(await stdio(ctx, { key: KEY, ...(params as object) })).error).toEqual({ code: -32602, message, data: { code: "invalid_input" } });
      expect(await post(JSON.stringify(params))).toEqual({ status: 400, text: JSON.stringify({ error }) });
    }
    expect(await post("not json")).toEqual({ status: 400, text: JSON.stringify({ error: { code: "invalid_input", message: "params: invalid JSON" } }) });
    expect(await post("[]")).toMatchObject({ status: 400 });
    expect(files(ctx)).toEqual(before);
  });
});
