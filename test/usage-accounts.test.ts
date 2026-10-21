import { expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { validateStrategy } from "../src/config/strategy";
import { captureClaudeRateLimits, statusLine } from "../src/install/statusline";
import { computeStatus } from "../src/engine/status";
import { fakeCtx } from "./helpers";

function strategy(home: string) {
  return validateStrategy({
    planner: "claude-code",
    accounts: {
      "claude-code": { kind: "claude" },
      "claude-work": { kind: "claude", home: join(home, "claude-work") },
      codex: { kind: "codex" },
      "codex-work": { kind: "codex", home: join(home, "codex-work") },
    },
    routing: [{ default: ["claude-code#claude-work", "codex#codex-work"] }],
  }, "/strategy");
}
const limits = { seven_day: { used_percentage: 37 }, five_hour: { used_percentage: 4 } };

test("Codex accounts read their own sessions instead of the default login", async () => {
  const ctx = fakeCtx();
  for (const [home, pct] of [[join(ctx.home, ".codex"), 9], [join(ctx.home, "codex-work"), 73]] as const) {
    mkdirSync(join(home, "sessions"), { recursive: true });
    await Bun.write(join(home, "sessions", "rollout-test.jsonl"), JSON.stringify({
      rate_limits: { primary: { used_percent: pct, window_minutes: 10080, resets_at: ctx.now + 86400 } },
    })+"\n");
  }
  const st = await computeStatus(ctx, strategy(ctx.home), { profile: null });
  expect(st.accounts.find(a => a.name === "codex-work")?.usedPct).toBe(73);
  expect(st.accounts.find(a => a.name === "codex")?.usedPct).toBe(9);
});

test("Claude status-line capture selects the configured account cache", async () => {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), `
planner: claude-code
accounts:
  claude-code: {kind: claude}
  claude-work: {kind: claude, home: "${join(ctx.home, "claude-work")}"}
routing:
  - default: [claude-code#claude-work]
`);
  ctx.env.CLAUDE_CONFIG_DIR = join(ctx.home, "claude-work");
  expect(captureClaudeRateLimits(ctx, JSON.stringify({ rate_limits: limits }))).toBe(true);
  const path = join(ctx.pacerHome, "cache", "claude-rate-limits.claude-work.json");
  expect(existsSync(path)).toBe(true);
  expect((await Bun.file(path).json()).seven_day.used_percentage).toBe(37);
  const st = await computeStatus(ctx, strategy(ctx.home), { profile: null });
  expect(st.accounts.find(a => a.name === "claude-work")?.usedPct).toBe(37);
  expect(st.accounts.find(a => a.name === "claude-code")?.usedPct).toBeNull();
  delete ctx.env.CLAUDE_CONFIG_DIR;
  captureClaudeRateLimits(ctx, JSON.stringify({ rate_limits: limits }));
  expect(existsSync(join(ctx.pacerHome, "cache", "claude-rate-limits.json"))).toBe(true);
});

test("unknown Claude folder falls back to the default cache with a recorded visible warning", async () => {
  const ctx = fakeCtx({ env: { CLAUDE_CONFIG_DIR: "/unknown-account" } });
  mkdirSync(ctx.pacerHome, { recursive: true });
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
  const line = await statusLine(ctx, JSON.stringify({ rate_limits: limits }));
  const data = await Bun.file(join(ctx.pacerHome, "cache", "claude-rate-limits.json")).json();
  expect(data.warning).toContain("unknown CLAUDE_CONFIG_DIR");
  expect(line).toContain("unknown CLAUDE_CONFIG_DIR");
});

async function orcaCtx() {
  const fixture = await Bun.file(join(import.meta.dir, "fixtures", "orca-account-list.json")).json();
  // Synthetic email used only to verify redaction, never an account fixture identity.
  fixture.result.claude.accounts[0].email = "synthetic@example.invalid";
  fixture.result.rateLimits.claude.email = "synthetic@example.invalid";
  const ctx = fakeCtx({ now: 1792000100, run: async (argv) => {
    if (argv.join(" ") !== "orca account list --json") throw new Error("unexpected command");
    return { code: 0, stdout: JSON.stringify(fixture), stderr: "" };
  } });
  return ctx;
}
function orcaStrategy() {
  return validateStrategy({
    planner: "claude-code",
    accounts: {
      "claude-code": {kind: "claude"},
      work: {kind: "claude", orca_account: "cl-team"},
      main: {kind: "codex", orca_account: "cx-main"},
      team: {kind: "codex", orca_account: "cx-team"},
      cursor: {kind: "cursor"},
      go: {kind: "endpoint", model: "opencode-go/kimi-k2", usage: "metered", budget: {weekly_tokens: "20M"}},
    },
    routing: [{default: ["claude-code#work", "codex#main", "codex#team", "cursor", "opencode#go"]}],
  }, "/strategy");
}


test("missing Orca falls back to native Claude and reactive Cursor", async () => {
  const ctx = fakeCtx({which: () => null});
  captureClaudeRateLimits(ctx, JSON.stringify({rate_limits: limits}));
  const s = validateStrategy({
    planner: "claude-code",
    accounts: {"claude-code": {kind: "claude", usage_source: "orca"}, cursor: {kind: "cursor", usage_source: "orca"}},
    routing: [{default: ["cursor"]}],
  }, "/strategy");
  const st = await computeStatus(ctx, s, {profile: null});
  expect(st.accounts.find(a => a.name === "claude-code")?.usedPct).toBe(37);
  expect(st.accounts.find(a => a.name === "cursor")?.usedPct).toBeNull();
});

test("Orca parsing exposes safe ids and labels without email fields or values", async () => {
  const {readOrcaAccounts} = await import("../src/orca/accounts");
  const parsed = await readOrcaAccounts(await orcaCtx());
  expect(parsed?.claude).toEqual([
    {id: "cl-main", label: "Main", active: true},
    {id: "cl-team", label: "Team", active: false},
  ]);
  expect(parsed?.inactive.claude[0].accountId).toBe("cl-team");
  expect(JSON.stringify(parsed)).not.toContain("email");
  expect(JSON.stringify(parsed)).not.toContain("synthetic@example.invalid");
  expect(await readOrcaAccounts(fakeCtx({which: () => null}))).toBeNull();
});

test("derived Orca homes require a real directory and refuse path traversal", async () => {
  const {orcaAccountHome} = await import("../src/orca/accounts");
  const ctx = fakeCtx();
  ctx.env.PACER_ORCA_USER_DATA = join(ctx.home, "orca-data");
  expect(orcaAccountHome(ctx, "claude", "cl-team")).toBeNull();
  const path = join(ctx.home, "orca-data", "claude-profiles", "cl-team", "home");
  mkdirSync(path, {recursive: true});
  expect(orcaAccountHome(ctx, "claude", "cl-team")).toBe(path);
  expect(orcaAccountHome(ctx, "claude", "../escape")).toBeNull();
});


test("Claude status-line capture recognizes an existing Orca-managed home", async () => {
  const ctx = fakeCtx();
  ctx.env.PACER_ORCA_USER_DATA = join(ctx.home, "orca-data");
  const folder = join(ctx.home, "orca-data", "claude-profiles", "cl-team", "home");
  mkdirSync(folder, {recursive: true});
  ctx.env.CLAUDE_CONFIG_DIR = folder;
  mkdirSync(ctx.pacerHome, {recursive: true});
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), `
planner: claude-code
accounts:
  claude-code: {kind: claude}
  work: {kind: claude, orca_account: cl-team}
routing:
  - default: [claude-code#work]
`);
  captureClaudeRateLimits(ctx, JSON.stringify({rate_limits: limits}));
  expect(existsSync(join(ctx.pacerHome, "cache", "claude-rate-limits.work.json"))).toBe(true);
  expect(existsSync(join(ctx.pacerHome, "cache", "claude-rate-limits.json"))).toBe(false);
});

test("Orca unavailable reads linked Codex logs only when its derived home exists", async () => {
  const ctx = fakeCtx({which: () => null});
  ctx.env.PACER_ORCA_USER_DATA = join(ctx.home, "orca-data");
  const s = orcaStrategy();
  let st = await computeStatus(ctx, s, {profile: null});
  expect(st.accounts.find(a => a.name === "team")?.usedPct).toBeNull();
  expect(st.providers.find(p => p.account === "team")?.error).toContain("folder not found");
  const folder = join(ctx.home, "orca-data", "codex-accounts", "cx-team", "home", "sessions");
  mkdirSync(folder, {recursive: true});
  await Bun.write(join(folder, "rollout-test.jsonl"), JSON.stringify({
    rate_limits: {primary: {used_percent: 66, window_minutes: 10080, resets_at: ctx.now + 86400}},
  })+"\n");
  // Advance beyond the source cache TTL.
  ctx.now += 61;
  st = await computeStatus(ctx, s, {profile: null});
  expect(st.accounts.find(a => a.name === "team")?.usedPct).toBe(66);
});

test("Orca command failures and malformed output fall back without leaking stdout or stderr", async () => {
  const {readOrcaAccounts} = await import("../src/orca/accounts");
  for (const result of [
    {code: 1, stdout: "synthetic@example.invalid", stderr: "synthetic@example.invalid"},
    {code: 0, stdout: "{broken", stderr: ""},
    {code: 0, stdout: JSON.stringify({ok: false, error: {message: "synthetic@example.invalid"}}), stderr: ""},
  ]) {
    const ctx = fakeCtx({run: async (argv) => argv[0] === "orca" ? result : {code: 0, stdout: JSON.stringify({models: []}), stderr: ""}});
    expect(await readOrcaAccounts(ctx)).toBeNull();
    const st = await computeStatus(ctx, orcaStrategy(), {profile: null});
    expect(JSON.stringify(st)).not.toContain("synthetic@example.invalid");
    expect(st.accounts.find(a => a.name === "cursor")?.usedPct).toBeNull();
  }
});

test("a native default runner limit does not exhaust a different account", async () => {
  const {markExhausted} = await import("../src/usage/reactive");
  const ctx = fakeCtx();
  const s = strategy(ctx.home);
  await Bun.write(join(ctx.pacerHome, "cache", "claude-rate-limits.claude-work.json"), JSON.stringify({
    ...limits, captured_at: ctx.now,
  }));
  markExhausted(ctx, "claude-code", ctx.now + 3600, {manual:true});
  const st = await computeStatus(ctx, s, {profile: null});
  expect(st.accounts.find(a => a.name === "claude-code")?.verdict).toBe("EXHAUSTED");
  const work = st.providers.find(p => p.account === "claude-work")!;
  expect(work.windows.some(w => w.name === "limit")).toBe(false);
  expect(work.binding?.usedPct).toBe(37);
});
