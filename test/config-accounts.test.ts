import { expect, test } from "bun:test";
import { allowedPair, type AgentId, type AccountKind } from "../src/config/accounts";
import { validateStrategy } from "../src/config/strategy";
import { rankExecutors, type ProviderStatus } from "../src/engine/rank";

const starter = {
  planner: "claude-code",
  providers: {
    "claude-code": { usage: "quota" },
    codex: { usage: "quota", allow_paid: false },
    cursor: { usage: "reactive", model: "auto", cooldown: "6h" },
    agy: { usage: "reactive" },
    byteplus: { via: "opencode", model: "coding-plan/dola-seed-2.0-code", usage: "quota", quota_source: "arkcli" },
    local: { via: "opencode", model: "ollama/qwen3", usage: "unmetered" },
  },
  pacing: { order: ["codex", "cursor", "agy", "opencode"] },
  routing: [{ default: ["claude-code", "codex", "cursor", "agy", "opencode#byteplus", "opencode#local"] }],
};
const modern = () => ({
  accounts: {
    claude: { kind: "claude" },
    work: { kind: "codex", home: "~/.codex-work" },
    team: { kind: "codex", orca_account: "team-id" },
    cursor: { kind: "cursor" },
    endpoint: { kind: "endpoint", usage: "quota", quota_source: "arkcli" },
    local: { kind: "endpoint", usage: "unmetered" },
    company: { kind: "endpoint", usage: "metered", budget: { weekly_tokens: "50M" } },
  },
  planner: { agent: "claude-code", account: "claude" },
  runners: {
    work: { agent: "codex", account: "work" },
    seed: { agent: "opencode", account: "endpoint", model: "coding-plan/seed" },
    local: { agent: "opencode", account: "local", model: "ollama/qwen3" },
  },
});
const parse = (raw: unknown) => validateStrategy(raw, "strategy.yaml");

test("legacy starter canonicalizes runner ids, provider settings, ordering and routing", () => {
  const s = parse(starter);
  expect(s.legacy).toBe(true);
  expect(Object.keys(s.runners)).toEqual(["claude-code", "codex", "cursor", "agy", "opencode#byteplus", "opencode#local"]);
  expect(s.planner).toEqual({ agent: "claude-code", account: "claude-code" });
  expect(s.accounts.byteplus).toMatchObject({ kind: "endpoint", source: "endpoint", usageSource: "arkcli", quotaSource: "arkcli" });
  expect(s.runners.cursor).toEqual({ id: "cursor", host: null, name: "cursor", agent: "cursor", account: "cursor", model: "auto" });
  expect(s.providers.codex.allowPaid).toBe(false);
  expect(s.providers["opencode#byteplus"]).toMatchObject({ via: "opencode", model: "coding-plan/dola-seed-2.0-code", usage: "quota" });
  expect(s.pacing.order).toEqual(["codex", "cursor", "agy", "opencode"]);
  expect(s.routing).toEqual([{ kinds: null, executors: ["claude-code", "codex", "cursor", "agy", "opencode#byteplus", "opencode#local"] }]);
  const statuses = Object.fromEntries(Object.values(s.providers).map(c => [c.id, {
    id: c.id, usage: c.usage, verdict: "OK", installed: true, stale: false, windows: [], binding: null,
  } satisfies ProviderStatus]));
  expect(rankExecutors(null, s, statuses).ranked.map(e => e.id)).toEqual(["codex", "cursor", "agy", "opencode#byteplus", "opencode#local"]);
});

test("new form derives sources, budgets, runners and the compatibility provider view", () => {
  const s = parse(modern());
  expect(s.legacy).toBe(false);
  expect(s.accounts.claude).toMatchObject({ name: "claude", source: "default", home: null, usage: "quota", usageSource: "native" });
  expect(s.accounts.work).toMatchObject({ source: "pacer", home: "~/.codex-work", usageSource: "native" });
  expect(s.accounts.team).toMatchObject({ source: "orca", orcaAccount: "team-id", usageSource: "orca" });
  expect(s.accounts.company.weeklyTokens).toBe(50_000_000);
  expect(s.providers["opencode#endpoint"]).toMatchObject({ id: "opencode#endpoint", via: "opencode", model: "coding-plan/seed", quotaSource: "arkcli" });
  expect(s.pacing.order).toEqual(["claude-code", "codex#work", "opencode#endpoint", "opencode#local"]);
});

test("planner string selects the agent's default account even when it is not an executor", () => {
  const s = parse({ ...modern(), accounts: {...modern().accounts, codex: {kind: "codex"}}, planner: "codex" });
  expect(s.planner).toEqual({ agent: "codex", account: "codex" });
  expect(s.accounts.codex).toMatchObject({ kind: "codex", source: "default", home: null });
  expect(parse({ planner: "opencode", providers: { local: starter.providers.local } }).planner)
    .toEqual({ agent: "opencode", account: "opencode" });
});

test("spread and fill threshold defaults and boundary values", () => {
  expect(parse(modern()).pacing).toMatchObject({ accounts: "spread", fillThreshold: 90 });
  for (const threshold of [50, 100]) {
    expect(parse({ ...modern(), pacing: { accounts: "fill", fill_threshold: threshold } }).pacing)
      .toMatchObject({ accounts: "fill", fillThreshold: threshold });
  }
  for (const threshold of [49, 101, "90", NaN, Infinity]) {
    expect(() => parse({ ...modern(), pacing: { fill_threshold: threshold } })).toThrow("fill_threshold");
  }
  expect(() => parse({ ...modern(), pacing: { accounts: "random" } })).toThrow("pacing.accounts");
});

test("invalid runner pairs, account references, and missing OpenCode models are refused", () => {
  for (const runner of [
    { agent: "claude-code", account: "endpoint" },
    { agent: "codex", account: "claude" },
    { agent: "cursor", account: "work" },
    { agent: "agy", account: "endpoint" },
    { agent: "opencode", account: "claude", model: "x/y" },
    { agent: "codex", account: "missing" },
    { agent: "opencode", account: "endpoint" },
    { agent: "unknown", account: "endpoint" },
  ]) expect(() => parse({ ...modern(), runners: { bad: runner } })).toThrow();
  expect(() => parse({ ...modern(), planner: { agent: "claude-code", account: "endpoint" } })).toThrow();
});

test("account location restrictions and usage validation are enforced", () => {
  for (const account of [
    { kind: "cursor", home: "~/.cursor-work" },
    { kind: "agy", home: "~/.agy-work" },
    { kind: "endpoint", orca_account: "endpoint-id", usage: "unmetered" },
    { kind: "claude", home: "~/.claude-work", orca_account: "id" },
    { kind: "claude", home: 123 },
    { kind: "codex", orca_account: "" },
    { kind: "unknown" },
    { kind: "endpoint", usage: "metered" },
    { kind: "endpoint", usage: "quota" },
    { kind: "cursor", usage: "quota" },
    { kind: "claude", usage_source: "unknown" },
  ]) expect(() => parse({ ...modern(), accounts: { ...modern().accounts, bad: account } })).toThrow();
});

test("agent/account table allows exactly the five supported pairs", () => {
  const agents: AgentId[] = ["claude-code", "codex", "cursor", "agy", "opencode"];
  const kinds: AccountKind[] = ["claude", "codex", "cursor", "agy", "endpoint"];
  const pairs: string[] = [];
  for (const agent of agents) for (const kind of kinds) if (allowedPair(agent, kind)) pairs.push(`${agent}:${kind}`);
  expect(pairs).toEqual(["claude-code:claude", "codex:codex", "cursor:cursor", "agy:agy", "opencode:endpoint"]);
});

test("legacy explicit runner aliases resolve to one canonical account identity", () => {
  const s = parse({ ...modern(), runners: {
    seed: { agent: "opencode", account: "company", model: "company/seed" },
    fast: { agent: "opencode", account: "company", model: "company/seed" },
  }, pacing: { order: ["fast", "seed"] }, routing: [{ default: ["seed", "fast"] }] });
  expect(s.runners["opencode#company"].account).toBe("company");
  expect(s.providers["opencode#company"].weeklyTokens).toBe(50_000_000);
  expect(s.pacing.order).toEqual(["opencode#company", "opencode#company"]);
});
