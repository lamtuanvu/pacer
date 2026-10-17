import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { callOp, type OpDeps } from "../src/api/ops";
import { eventsSince } from "../src/api/events";
import { toApiError } from "../src/api/protocol";
import { defaultUpdateDeps, runUpdate } from "../src/update/update";
import { fakeCtx } from "./helpers";

function configured() {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\npacing: {policy: priority}\nrouting: [{default: [codex]}]\n");
  return ctx;
}

test("strategy show, preview, save, list and remove wrap the strategy service", async () => {
  const ctx = configured(), path = join(ctx.pacerHome, "strategy.yaml"), before = readFileSync(path, "utf8");
  expect(await callOp(ctx, "strategy.show", {name: "default"})).toMatchObject({yaml: before, summary: expect.any(String), active: true});
  const draft = {from: "default", set: {"pacing.policy": "even"}};
  expect(await callOp(ctx, "strategy.preview", {draft})).toMatchObject({ok: true, errors: [], yaml: expect.stringContaining("even")});
  expect(await callOp(ctx, "strategy.preview", {draft: {from: "default", set: {"pacing.policy": "bad"}}})).toMatchObject({ok: false, errors: expect.arrayContaining([expect.any(String)])});
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(eventsSince(ctx, 0).events).toEqual([]);
  const saved = join(ctx.pacerHome, "strategies", "balanced.yaml");
  expect(await callOp(ctx, "strategy.save", {name: "balanced", draft, reason: "Spread work evenly"})).toEqual({name: "balanced", path: saved});
  expect(await callOp(ctx, "strategy.list", {})).toEqual(expect.arrayContaining([expect.objectContaining({name: "balanced", active: false})]));
  expect(await callOp(ctx, "strategy.remove", {name: "balanced"})).toEqual({removed: true});
  expect(existsSync(saved)).toBe(false);
  expect(eventsSince(ctx, 0).events.filter(e => e.type === "config").map(e => e.data)).toEqual([1, 2].map(() => ({area: "strategy", at: ctx.now})));
});

test("strategy mutations refuse protected strategies and invalid drafts without events", async () => {
  const ctx = configured();
  await callOp(ctx, "strategy.save", {name: "active", draft: {from: "default"}, reason: "Test"});
  writeFileSync(join(ctx.pacerHome, "active"), "active\n");
  const since = eventsSince(ctx, 0).last;
  for (const name of ["default", "active"]) {
    await expect(callOp(ctx, "strategy.remove", {name})).rejects.toMatchObject({code: "not_allowed", hint: expect.any(String)});
  }
  await expect(callOp(ctx, "strategy.save", {name: "bad", draft: {from: "default", set: {"pacing.policy": "bad"}}, reason: "Test"})).rejects.toMatchObject({code: "invalid_input"});
  await expect(callOp(ctx, "strategy.show", {name: "missing"})).rejects.toMatchObject({code: "invalid_input", hint: expect.any(String)});
  expect(eventsSince(ctx, since).events).toEqual([]);
});

test("strategy use also publishes a strategy config change only on success", async () => {
  const ctx = configured();
  await callOp(ctx, "strategy.save", {name: "balanced", draft: {from: "default"}, reason: "Test"});
  const since = eventsSince(ctx, 0).last;
  await callOp(ctx, "strategy.use", {name: "balanced"});
  expect(eventsSince(ctx, since).events.filter(e => e.type === "config").map(e => e.data)).toEqual([{area: "strategy", at: ctx.now}]);
  const last = eventsSince(ctx, 0).last;
  await expect(callOp(ctx, "strategy.use", {name: "missing"})).rejects.toMatchObject({code: "invalid_input"});
  expect(eventsSince(ctx, last).events).toEqual([]);
});

test("update.check honors the cache and force with a local release base and publishes config", async () => {
  const ctx = configured(), base = join(ctx.home, "releases");
  mkdirSync(base);
  ctx.env.PACER_RELEASE_BASE = pathToFileURL(base).href;
  writeFileSync(join(base, "latest.json"), JSON.stringify({version: "99.0.0"}));
  expect(await callOp(ctx, "update.check", {})).toMatchObject({current: expect.any(String), latest: "99.0.0", available: true, plugin: null});
  writeFileSync(join(base, "latest.json"), JSON.stringify({version: "99.0.1"}));
  expect(await callOp(ctx, "update.check", {})).toMatchObject({latest: "99.0.0"});
  expect(await callOp(ctx, "update.check", {force: true})).toMatchObject({latest: "99.0.1"});
  expect(eventsSince(ctx, 0).events.filter(e => e.type === "config").map(e => e.data)).toEqual([1, 2, 3].map(() => ({area: "update", at: ctx.now})));
});

test("update.apply spawns once detached and publishes the starting alert", async () => {
  const ctx = configured(), calls: unknown[] = [];
  const deps: OpDeps = {update: {standalone: true}, spawnUpdate: (argv, options) => { calls.push({argv, options}); }};
  expect(await callOp(ctx, "update.apply", {}, deps)).toEqual({started: true});
  expect(calls).toEqual([{argv: [process.execPath, "update"], options: {detached: true, stdio: "ignore", env: ctx.env}}]);
  expect(eventsSince(ctx, 0).events).toMatchObject([{type: "alert", data: {key: "update", level: "info", title: "Updating pacer…", at: ctx.now}}]);
});

test("update.apply preserves source, npm and Homebrew refusal messages without spawning", async () => {
  for (const kind of ["source", "npm", "brew"]) {
    const ctx = configured(), execPath = join(ctx.home, "Cellar/pacer/1.0.0/bin/pacer");
    mkdirSync(join(execPath, ".."), {recursive: true});
    writeFileSync(execPath, "fixture");
    if (kind === "npm") ctx.env.PACER_INSTALL_METHOD = "npm";
    const update = {standalone: kind !== "source", execPath: kind === "brew" ? execPath : process.execPath};
    const expected = await runUpdate({check: false}, {...defaultUpdateDeps(ctx), ...update});
    let calls = 0;
    try {
      await callOp(ctx, "update.apply", {}, {update, spawnUpdate: () => { calls++; }});
      throw Error("expected refusal");
    } catch (e) {
      expect(toApiError(e)).toMatchObject({code: "not_allowed", message: expected.err.replace(/^pacer update: /, ""), hint: expect.any(String)});
    }
    expect(calls).toBe(0);
    expect(eventsSince(ctx, 0).events).toEqual([]);
  }
});

test("failed update spawn does not announce a started update", async () => {
  const ctx = configured();
  await expect(callOp(ctx, "update.apply", {}, {update: {standalone: true}, spawnUpdate: () => { throw Error("spawn failed"); }})).rejects.toMatchObject({code: "invalid_input", message: "spawn failed", hint: expect.any(String)});
  expect(eventsSince(ctx, 0).events).toEqual([]);
});
