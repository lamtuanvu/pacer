import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { runStdio } from "../src/api/stdio";
import { loadStrategy } from "../src/config/strategy";
import { enforcementExclusion, enforcementExclusionCached } from "../src/dispatch/enforcement";
import { openReadOnlyStore } from "../src/dispatch/readonly";
import { blockExecutor } from "../src/executors/blocked";
import { executorExclusion } from "../src/executors/availability";
import { startServer } from "../src/serve/http";
import { draftStrategy } from "../src/strategy/service";
import type { Ctx } from "../src/types";
import { fakeCtx, tmpDir } from "./helpers";

// The sealed dispatch parts route: HTTP `/_internal/dispatch-parts` and stdio `_internal.dispatch.parts`,
// with its `dispatch.executor-guards` and `dispatch.enforcement-exclusions` kinds.

const KEY = "fixture-private-key";
const TOKEN = "s".repeat(64);
const STRATEGY = `planner: claude-code
accounts:
  claude: {kind: claude}
  codex: {kind: codex}
  cursor: {kind: cursor}
runners:
  claude-code: {}
  codex: {}
  cursor: {}
`;
const RUNNERS = ["claude-code", "codex", "cursor"];

function fixture(): { ctx: Ctx; repo: string } {
  const bin = tmpDir();
  for (const name of ["claude", "codex", "cursor-agent"]) writeFileSync(join(bin, name), "cli");
  const ctx = fakeCtx({
    which: name => ["claude", "codex", "cursor-agent"].includes(name) ? join(bin, name) : null,
    run: async argv => argv[1] === "--version" && argv[0]!.endsWith("codex") ? { code: 1, stdout: "", stderr: "boom" }
      : { code: 0, stdout: "2.1.281 (Claude Code)\n", stderr: "" },
  });
  mkdirSync(join(ctx.pacerHome, "strategies"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), STRATEGY);
  return { ctx, repo: tmpDir() };
}

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

async function stdio(ctx: Ctx, params: unknown, key: string | null = KEY): Promise<string> {
  async function* input() { yield JSON.stringify({ jsonrpc: "2.0", id: 1, method: "_internal.dispatch.parts", params }); }
  const out: string[] = [];
  await runStdio(ctx, input(), line => out.push(line), { nativeConfigKey: key ?? undefined });
  expect(out).toHaveLength(1);
  return out[0]!.trimEnd();
}
const result = async (ctx: Ctx, params: object) => JSON.parse(await stdio(ctx, { key: KEY, ...params })).result;

type Post = (body: string | undefined, headers?: Record<string, string>) => Promise<{ status: number; text: string }>;
async function withServer<T>(ctx: Ctx, run: (post: Post) => Promise<T>): Promise<T> {
  const s = startServer(() => ctx, { port: 0, pumpMs: 0, internal: { token: TOKEN } });
  try {
    return await run(async (body, headers = { authorization: `Bearer ${TOKEN}` }) => {
      const r = await fetch(`http://127.0.0.1:${s.port}/_internal/dispatch-parts`, {
        method: "POST", headers: { host: `127.0.0.1:${s.port}`, "content-type": "application/json", ...headers }, body,
      });
      return { status: r.status, text: await r.text() };
    });
  } finally { s.stop(); }
}

const guards = { kind: "dispatch.executor-guards", runners: RUNNERS };

test("the HTTP route admits only the internal bearer", async () => {
  const { ctx } = fixture();
  await withServer(ctx, async post => {
    const body = JSON.stringify(guards);
    expect((await post(body, {})).status).toBe(401);
    expect((await post(body, { authorization: `Bearer ${"x".repeat(64)}` })).status).toBe(401);
    const internal = { authorization: `Bearer ${TOKEN}` };
    for (const auth of ["cookie", "task", "other"]) {
      expect(await post(body, { ...internal, "x-pacer-auth": auth, "x-pacer-work-grant": "Bearer pwg_fixture" })).toEqual({ status: 403, text: "forbidden\n" });
    }
    const admitted = await post(body, { ...internal, "x-pacer-auth": "bearer" });
    expect(admitted).toEqual({ status: 200, text: JSON.stringify({ result: await result(ctx, guards) }) });
    expect(await post("not json")).toEqual({ status: 400, text: JSON.stringify({ error: { code: "invalid_input", message: "params: invalid JSON" } }) });
  });
}, 30000);

test("the sealed stdio method answers unknown_op for a missing or wrong key and for a work-grant caller", async () => {
  const { ctx } = fixture();
  const granted: Ctx = { ...ctx, env: { ...ctx.env, PACER_WORK_GRANT: "pwg_fixture" } };
  for (const line of [
    await stdio(ctx, { key: "incorrect", ...guards }),
    await stdio(ctx, guards),
    await stdio(ctx, null),
    await stdio(ctx, { key: KEY, ...guards }, null),
    await stdio(granted, { key: KEY, ...guards }),
  ]) {
    expect(JSON.parse(line)).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "unknown operation", data: { code: "unknown_op" } } });
    expect(line).not.toContain(KEY);
  }
});

test("malformed params are invalid_input and name no other operation", async () => {
  const { ctx } = fixture();
  for (const params of [{}, { kind: "task.send", runners: [] }, { ...guards, extra: 1 }, { ...guards, runners: [""] },
    { kind: "dispatch.enforcement-exclusions", runners: [], repo: "/r" }, { ...guards, draft: { from: "" } }]) {
    expect(JSON.parse(await stdio(ctx, { key: KEY, ...params })).error.data.code).toBe("invalid_input");
  }
  const draft = JSON.parse(await stdio(ctx, { key: KEY, ...guards, draft: { from: "default", set: { "pacing.policy": "nope" } } })).error;
  expect(draft.message).toBe("Invalid strategy draft");
});

test("a draft is read only: enforcement for a draft requires cached: true", async () => {
  const { ctx, repo } = fixture();
  const params = { kind: "dispatch.enforcement-exclusions", repo, runners: RUNNERS, draft: { from: "default" } };
  expect(JSON.parse(await stdio(ctx, { key: KEY, ...params, cached: false })).error)
    .toEqual({ code: -32602, message: "draft: requires cached: true", data: { code: "invalid_input" } });
  expect(await result(ctx, { ...params, cached: true })).toHaveLength(RUNNERS.length);
});

test("both routes refuse a request over 256 KiB", async () => {
  const { ctx } = fixture();
  // Unknown keys are invalid_input, so a request at the limit is parsed and refused by the schema.
  const padded = (size: number) => {
    const body = JSON.stringify({ ...guards, pad: "" });
    return JSON.stringify({ ...guards, pad: "x".repeat(size - body.length) });
  };
  const max = 256 * 1024;
  await withServer(ctx, async post => {
    expect(JSON.parse((await post(padded(max))).text).error.code).toBe("invalid_input");
    const refused = { status: 413, text: JSON.stringify({ error: { code: "too_large", message: "body exceeds 256 KiB" } }) };
    expect(await post(padded(max + 1))).toEqual(refused);
    // Without a declared length the route stops reading at the limit.
    const chunks = [padded(max + 1).slice(0, max), padded(max + 1).slice(max)];
    const stream = new ReadableStream({ pull(c) { const next = chunks.shift(); if (next === undefined) c.close(); else c.enqueue(new TextEncoder().encode(next)); } });
    expect(await post(stream as unknown as string)).toEqual(refused);
  });
  const line = (size: number) => {
    const frame = (pad: string) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "_internal.dispatch.parts", params: { key: KEY, ...guards, pad } });
    return { key: KEY, ...guards, pad: "x".repeat(size - frame("").length) };
  };
  expect(JSON.parse(await stdio(ctx, line(max))).error.data.code).toBe("invalid_input");
  expect(JSON.parse(await stdio(ctx, line(max + 1))).error).toEqual({ code: -32000, message: "request exceeds 256 KiB", data: { code: "too_large" } });
}, 30000);

test("executor guards are executorExclusion and the classifier check, read-only", async () => {
  const { ctx } = fixture();
  blockExecutor(ctx, "codex");
  const before = files(ctx);
  const reply = await result(ctx, guards);
  const strategy = loadStrategy(ctx);
  expect(reply).toEqual({ guards: RUNNERS.map(runner => ({ runner, reason: executorExclusion(ctx, strategy, runner) ?? null })), admissionHooks: false });
  expect(reply.guards[1].reason).toBe("Blocked by you");
  const draft = { from: "default", set: { classifier: { timeout_ms: 1000 } } };
  const drafted = await result(ctx, { ...guards, draft });
  expect(drafted.admissionHooks).toBe(true);
  expect(drafted.guards).toEqual(RUNNERS.map(runner => ({ runner, reason: executorExclusion(ctx, draftStrategy(ctx, draft), runner) ?? null })));
  expect(files(ctx)).toEqual(before);
});

test("cached enforcement is enforcementExclusionCached and writes nothing", async () => {
  const { ctx, repo } = fixture();
  const before = files(ctx);
  const params = { kind: "dispatch.enforcement-exclusions", repo, runners: RUNNERS, cached: true };
  const reply = await result(ctx, params);
  const store = openReadOnlyStore({ ...ctx, readOnly: true });
  const strategy = loadStrategy(ctx);
  const expected = await Promise.all(RUNNERS.map(async runner => ({ runner, ...await enforcementExclusionCached({ ...ctx, readOnly: true }, strategy, runner, repo, store) })));
  store.close();
  expect(reply).toEqual(expected);
  expect(reply.some((row: { unverified: string | null }) => row.unverified !== null)).toBe(true);
  expect(files(ctx)).toEqual(before);
});

test("uncached enforcement is enforcementExclusion with its version probe", async () => {
  const { ctx, repo } = fixture();
  const params = { kind: "dispatch.enforcement-exclusions", repo, runners: RUNNERS, cached: false };
  const reply = await result(ctx, params);
  const strategy = loadStrategy(ctx);
  expect(reply).toEqual(await Promise.all(RUNNERS.map(async runner => ({ runner, reason: await enforcementExclusion(ctx, strategy, runner, repo), unverified: null }))));
  expect(reply.every((row: { reason: string | null }) => typeof row.reason === "string")).toBe(true);
}, 30000);
