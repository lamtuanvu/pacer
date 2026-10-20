import {expect, test} from "bun:test";
import {validateStrategy} from "../src/config/strategy";

const base = (accounts: Record<string, unknown>, runners: Record<string, unknown> = {}) => ({
  accounts: {personal: {kind: "claude"}, ...accounts}, planner: "claude-code", runners,
  routing: [{default: Object.keys(runners).length ? Object.keys(runners) : ["claude-code"]}],
});
const problems = (raw: unknown) => { try { validateStrategy(raw, "strategy.yaml"); return []; } catch (e) { return (e as {problems?: string[]}).problems ?? [String(e)]; } };

test("a source: opencode account refers to a provider and carries a dollar cap", () => {
  const s = validateStrategy(base({openrouter: {kind: "endpoint", source: "opencode", provider: "openrouter", usage: "metered", budget: {weekly_usd: 10}}},
    {"opencode#openrouter": {model: "openrouter/qwen/qwen3-coder"}}), "strategy.yaml");
  expect(s.accounts.openrouter).toMatchObject({source: "opencode", provider: "openrouter", weeklyUsd: 10, weeklyTokens: null});
  expect(s.providers["opencode#openrouter"]).toMatchObject({usage: "metered", weeklyUsd: 10, model: "openrouter/qwen/qwen3-coder"});
});

test("metered endpoint accounts may omit a budget", () => {
  expect(problems(base({openrouter: {kind: "endpoint", source: "opencode", provider: "openrouter", usage: "metered"}},
    {"opencode#openrouter": {model: "openrouter/x"}}))).toEqual([]);
});

test("source: opencode rejects bad shapes", () => {
  const ps = problems(base({
    a: {kind: "claude", source: "opencode", provider: "x"},
    b: {kind: "endpoint", source: "opencode"},
    c: {kind: "endpoint", source: "elsewhere", provider: "x"},
    d: {kind: "endpoint", source: "opencode", provider: "x", budget: {weekly_usd: 5, weekly_tokens: "1M"}},
    e: {kind: "endpoint", source: "opencode", provider: "x", budget: {weekly_usd: 0}},
  }, {"opencode#b": {model: "x/m"}, "opencode#e": {model: "y/m"}}));
  expect(ps.join("\n")).toContain("accounts.a: source: opencode requires an endpoint account");
  expect(ps.join("\n")).toContain("accounts.b: source: opencode needs provider");
  expect(ps.join("\n")).toContain("accounts.c: source must be opencode");
  expect(ps.join("\n")).toContain("accounts.d: budget cannot combine weekly_usd and weekly_tokens");
  expect(ps.join("\n")).toContain("accounts.e: budget.weekly_usd must be a positive number");
  expect(ps.join("\n")).toContain('runner opencode#e: model must start with "x/"');
});

test("quota on a source: opencode account needs no quota_source", () => {
  expect(problems(base({zhipu: {kind: "endpoint", source: "opencode", provider: "zhipuai-coding-plan", usage: "quota"}},
    {"opencode#zhipu": {model: "zhipuai-coding-plan/glm-5"}}))).toEqual([]);
});

test("other source values are ignored as before, so existing native accounts still load", () => {
  for (const source of ["external", "default", "pacer"]) {
    expect(problems(base({work: {kind: "claude", source, home: "/tmp/work"}}, {"claude-code#work": {}}))).toEqual([]);
    expect(problems(base({team: {kind: "codex", source}}, {"codex#team": {}}))).toEqual([]);
  }
  expect(problems(base({work: {kind: "claude", source: "opencode", provider: "openrouter"}}))).toContain("accounts.work: source: opencode requires an endpoint account");
});
