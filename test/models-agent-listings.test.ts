import {expect, test} from "bun:test";
import {mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync} from "node:fs";
import {join} from "node:path";
import {availableModels} from "../src/models/available";
import {parseAgyModels, parseCodexCache, parseCursorModels} from "../src/models/agent-listings";
import {execProcess} from "../src/exec/process";
import type {Ctx, RunFn} from "../src/types";
import {fakeCtx, tmpDir} from "./helpers";

// Codex, Cursor and Antigravity listings for the pick list. The CLIs are the stand-ins in
// test/fixtures/agent-bin (state in $HOME/.fake-<name>); the Codex cache is test/fixtures/codex.

const AGENT_BIN = join(import.meta.dir, "fixtures", "agent-bin");
const CODEX_CACHE = readFileSync(join(import.meta.dir, "fixtures", "codex", "models_cache.json"), "utf8");
const CURSOR_OUT = "Available models\n\nauto - Auto (current, default)\ngpt-5.3-codex - Codex 5.3\ncomposer-2.5 - Composer 2.5\n\nTip: use --model <id> (or /model <id> in interactive mode) to switch.\n";
const AGY_OUT = "Fetching available models...\ngemini-4-hydrogen-high\tGemini 4 Hydrogen (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n";

/** Runs the real process layer against the stand-in CLIs only, with a short timeout cap. */
function agentCtx(o: {path?: string; timeoutCapMs?: number} = {}): Ctx {
  const home = tmpDir();
  const run: RunFn = (argv, timeoutMs, options) => execProcess({argv, cwd: home, env: {HOME: home, PATH: `${o.path ?? AGENT_BIN}:/usr/bin:/bin`},
    timeoutMs: Math.min(timeoutMs, o.timeoutCapMs ?? 10_000), stdin: options?.stdin});
  return fakeCtx({home, run});
}
function fake(ctx: Ctx, name: "cursor-agent" | "agy", mode: string, models?: string) {
  const state = join(ctx.home, `.fake-${name}`);
  mkdirSync(state, {recursive: true});
  writeFileSync(join(state, "mode"), mode);
  if (models !== undefined) writeFileSync(join(state, "models"), models);
}
const calls = (ctx: Ctx, name: string) => {
  const log = join(ctx.home, `.fake-${name}`, "calls.log");
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
};
function writeStrategy(ctx: Ctx, accounts: Record<string, unknown>, runners: Record<string, unknown>) {
  mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify({planner: "claude-code", accounts: {claude: {kind: "claude"}, ...accounts}, runners}));
}
const caches = (ctx: Ctx) => {
  const dir = join(ctx.pacerHome, "cache", "available-models");
  return existsSync(dir) ? readdirSync(dir) : [];
};

test("cursor-agent lines become ids and names; the current marker, heading and tip are dropped", () => {
  expect(parseCursorModels(CURSOR_OUT)).toEqual([
    {id: "auto", name: "Auto"}, {id: "gpt-5.3-codex", name: "Codex 5.3"}, {id: "composer-2.5", name: "Composer 2.5"},
  ]);
  expect(parseCursorModels("a - A (current)\r\nb - B (beta)\nb - again\n﻿c - \n has space - X\n")).toEqual([
    {id: "a", name: "A"}, {id: "b", name: "B (beta)"},
  ]);
  expect(parseCursorModels("garbage\n{\"json\":true}\n")).toEqual([]);
});

test("agy lines split at the first tab; other lines are skipped", () => {
  expect(parseAgyModels(AGY_OUT)).toEqual([
    {id: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)"}, {id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)"},
  ]);
  expect(parseAgyModels("x\t\r\n y \tY\tmore\nno tab here\n\tnameless\n")).toEqual([{id: "x"}, {id: "y", name: "Y\tmore"}]);
});

test("the Codex cache lists only models Codex lists itself, with names and context", () => {
  expect(parseCodexCache(CODEX_CACHE)).toEqual([
    {id: "gpt-6-luna", name: "GPT-6-Luna", context: 272000},
    {id: "gpt-5.6-terra", name: "GPT-5.6-Terra", context: 400000},
    {id: "gpt-5.6-luna", name: "GPT-5.6-Luna", context: 272000},
  ]);
  // No visibility field (older caches) is listed; odd entries and facts are skipped.
  expect(parseCodexCache('{"models":[{"slug":"old"},{"slug":"x","visibility":null},{"slug":""},null,"s",{"slug":"y","display_name":3,"context_window":-1},{"slug":"z","display_name":"","context_window":1e400}]}'))
    .toEqual([{id: "old"}, {id: "y"}, {id: "z"}]);
  expect(parseCodexCache("not json")).toBeNull();
  expect(parseCodexCache(JSON.stringify({models: {}}))).toBeNull();
});

test("a Codex runner reads models_cache.json from its folder, fresh on every call and never cached", async () => {
  const ctx = agentCtx();
  writeStrategy(ctx, {codex: {kind: "codex"}, work: {kind: "codex", home: "~/codex-work"}}, {codex: {}, "codex#work": {}});
  mkdirSync(join(ctx.home, ".codex"));
  writeFileSync(join(ctx.home, ".codex", "models_cache.json"), CODEX_CACHE);
  const r = await availableModels(ctx, "codex", {agents: true});
  expect(r).toEqual({runner: "codex", source: "codex", models: [
    {id: "gpt-6-luna", name: "GPT-6-Luna", context: 272000}, {id: "gpt-5.6-terra", name: "GPT-5.6-Terra", context: 400000}, {id: "gpt-5.6-luna", name: "GPT-5.6-Luna", context: 272000},
  ], fetchedAt: ctx.now, provider: "codex"});
  expect(caches(ctx)).toEqual([]);
  // A named account reads its own folder; missing, garbage and empty files are unknown with a note.
  const named = await availableModels(ctx, "codex#work", {agents: true});
  expect(named).toMatchObject({source: "codex", models: null, note: "Codex has not saved a model list yet; start Codex once with this account"});
  mkdirSync(join(ctx.home, "codex-work"));
  writeFileSync(join(ctx.home, "codex-work", "models_cache.json"), "{garbage");
  expect((await availableModels(ctx, "codex#work", {agents: true})).note).toBe("Codex's saved model list could not be read");
  writeFileSync(join(ctx.home, "codex-work", "models_cache.json"), JSON.stringify({models: [{slug: "h", visibility: "hide"}]}));
  expect((await availableModels(ctx, "codex#work", {agents: true})).note).toBe("Codex's saved model list has no models; start Codex once to refresh it");
  writeFileSync(join(ctx.home, "codex-work", "models_cache.json"), JSON.stringify({models: [{slug: "n"}]}));
  expect((await availableModels(ctx, "codex#work", {agents: true})).models).toEqual([{id: "n"}]);
});

test("the model checks keep no listing for native agents", async () => {
  const ctx = agentCtx();
  writeStrategy(ctx, {codex: {kind: "codex"}, cursor: {kind: "cursor"}}, {codex: {}, cursor: {}});
  mkdirSync(join(ctx.home, ".codex"));
  writeFileSync(join(ctx.home, ".codex", "models_cache.json"), CODEX_CACHE);
  fake(ctx, "cursor-agent", "list", CURSOR_OUT);
  // A cached pick list must not reach the checks either.
  expect((await availableModels(ctx, "cursor", {agents: true})).models).toHaveLength(3);
  expect(await availableModels(ctx, "codex")).toMatchObject({source: "none", models: null});
  expect(await availableModels(ctx, "cursor")).toMatchObject({source: "none", models: null});
  expect(calls(ctx, "cursor-agent")).toBe(1);
});

for (const [agent, bin, out, first] of [["cursor", "cursor-agent", CURSOR_OUT, {id: "auto", name: "Auto"}], ["agy", "agy", AGY_OUT, {id: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)"}]] as const) {
  const label = agent === "cursor" ? "Cursor" : "Antigravity";

  test(`${agent} lists through ${bin} models and caches the list for ten minutes unless refreshed`, async () => {
    const ctx = agentCtx();
    writeStrategy(ctx, {[agent]: {kind: agent}}, {[agent]: {}});
    fake(ctx, bin, "list", out);
    const r = await availableModels(ctx, agent, {agents: true});
    expect(r).toMatchObject({runner: agent, source: agent, provider: agent, fetchedAt: ctx.now});
    expect(r.models![0]).toEqual(first);
    expect(readFileSync(join(ctx.home, `.fake-${bin}`, "calls.log"), "utf8")).toStartWith("args=models ");
    expect(await availableModels(ctx, agent, {agents: true})).toEqual(r);
    expect(calls(ctx, bin)).toBe(1);
    ctx.now += 600;
    await availableModels(ctx, agent, {agents: true});
    expect(calls(ctx, bin)).toBe(2);
    await availableModels(ctx, agent, {agents: true, refresh: true});
    expect(calls(ctx, bin)).toBe(3);
  });

  test(`${agent}: a failed, empty, garbage or hung listing is unknown and never cached`, async () => {
    const ctx = agentCtx({timeoutCapMs: 500});
    writeStrategy(ctx, {[agent]: {kind: agent}}, {[agent]: {}});
    for (const [mode, models, note] of [
      ["fail", undefined, `${label} could not list its models`],
      ["empty", undefined, `${label} lists no models; check that it is signed in`],
      ["list", "Available models\n\nnot a model line\n", `${label} lists no models; check that it is signed in`],
      ["hang", undefined, `${label} could not list its models`],
    ] as const) {
      fake(ctx, bin, mode, models);
      expect(await availableModels(ctx, agent, {agents: true}), mode).toMatchObject({source: agent, models: null, note});
      expect(caches(ctx), mode).toEqual([]);
    }
    expect(calls(ctx, bin)).toBe(4);
  });

  test(`${agent}: a missing ${bin} is unknown`, async () => {
    const ctx = agentCtx({path: tmpDir()});
    writeStrategy(ctx, {[agent]: {kind: agent}}, {[agent]: {}});
    expect(await availableModels(ctx, agent, {agents: true})).toMatchObject({source: agent, models: null, note: `${label} could not list its models`});
  });
}

test("a runner on another host has no local listing", async () => {
  const ctx = agentCtx();
  mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify({planner: "claude-code", accounts: {claude: {kind: "claude"}, codex: {kind: "codex"}},
    hosts: {box: {ssh: "box.example.com"}}, runners: {"codex@box": {}}}));
  mkdirSync(join(ctx.home, ".codex"));
  writeFileSync(join(ctx.home, ".codex", "models_cache.json"), CODEX_CACHE);
  expect(await availableModels(ctx, "codex@box", {agents: true})).toMatchObject({source: "none", models: null});
});
