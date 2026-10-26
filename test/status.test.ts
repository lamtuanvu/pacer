import { withLoginIndicators } from "./helpers";
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { validateStrategy } from "../src/config/strategy";
import { binaryFor, computeStatus, displayName } from "../src/engine/status";
import { claudeCachePaths } from "../src/usage/claude";
import type { RunFn } from "../src/types";
import { fakeCtx, localTs } from "./helpers";
import { fakeCtx as fakeUsageCtx, cleanupUsageFixtures } from "./usage-plugin-fixtures";

afterEach(cleanupUsageFixtures);

const s = validateStrategy({
  planner: "claude-code",
  providers: {
    "claude-code": {}, codex: {},
    byteplus: { via: "opencode", model: "coding-plan/x", usage: "quota", quota_source: "arkcli" },
    local: { via: "opencode", model: "lmstudio/q", usage: "unmetered" },
  },
  pacing: { policy: "even" },
  routing: [{ default: ["opencode#byteplus", "codex", "opencode#local"] }],
}, "/x");

const now = localTs(2026, 10, 10, 19, 0);
const weeklyReset = localTs(2026, 10, 11, 1, 0); // 6h ahead: 9 or fewer active hours left, 83% unused
const ARK = JSON.stringify({ items: [{ product: "coding-plan", subscribed: true, periods: [
  { label: "weekly", percent: 17, reset_at: new Date(weeklyReset * 1000).toISOString() },
] }] });
const run: RunFn = async (argv) => argv[0] === "arkcli"
  ? { code: 0, stdout: ARK, stderr: "" }
  : { code: 127, stdout: "", stderr: "missing" };

test("assembles verdicts, planner mode and the default executor ranking", async () => {
  const ctx = withLoginIndicators(fakeUsageCtx({ now, run }));
  const claude = claudeCachePaths(ctx)[0];
  mkdirSync(dirname(claude), { recursive: true });
  await Bun.write(claude, JSON.stringify({
    seven_day: { used_percentage: 4, resets_at: localTs(2026, 10, 17, 12, 0) },
    five_hour: { used_percentage: 2, resets_at: now + 3600 },
    captured_at: now - 60,
  }));
  const st = await computeStatus(ctx, s, { profile: null });
  expect(st.calendarPace).toBe(true);
  expect(st.mode).toBe("normal");
  const by = Object.fromEntries(st.providers.map((p) => [p.id, p]));
  expect(by["claude-code"].verdict).toBe("ON_PACE");
  expect(by["opencode#byteplus"].verdict).toBe("EXPIRING");
  expect(by["opencode#local"].verdict).toBe("OK");
  expect(st.executors.ranked[0].id).toBe("opencode#byteplus");
});

test("broken sources degrade to UNKNOWN and the status still renders", async () => {
  const ctx = withLoginIndicators(fakeUsageCtx({ now, run: async () => ({ code: 127, stdout: "", stderr: "arkcli: not found" }) }));
  const st = await computeStatus(ctx, s, { profile: null });
  const by = Object.fromEntries(st.providers.map((p) => [p.id, p]));
  expect(by["claude-code"].verdict).toBe("UNKNOWN");
  expect(by.codex.verdict).toBe("UNKNOWN");
  expect(by["opencode#byteplus"].verdict).toBe("UNKNOWN");
  expect(by["opencode#byteplus"].error).toContain("arkcli");
  expect(st.mode).toBe("normal");
  expect(st.executors.ranked.map((e) => e.id)).toEqual(["opencode#local", "opencode#byteplus", "codex"]);
});

test("unreadable activity logs do not prevent status without a profile override", async () => {
  const ctx = withLoginIndicators(fakeCtx({ now, run }));
  const path = join(ctx.home, ".claude", "projects", "-proj", "unreadable.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify({ timestamp: new Date((now - 3600) * 1000).toISOString() }));
  const mode = statSync(path).mode;
  try {
    chmodSync(path, 0o000);
    const st = await computeStatus(ctx, s);
    expect(st.calendarPace).toBe(true);
    expect(st.providers).toHaveLength(Object.keys(s.providers).length);
    expect(st.providers.find((p) => p.id === "opencode#local")?.verdict).toBe("OK");
  } finally {
    chmodSync(path, mode);
  }
});

test("PACER=off marks the status disabled; missing binaries are not installed", async () => {
  const ctx = withLoginIndicators(fakeCtx({ now, run, env: { PACER: "off" }, which: (b) => (b === "codex" ? null : "/bin/" + b) }));
  const st = await computeStatus(ctx, s, { profile: null });
  expect(st.disabled).toBe(true);
  expect(st.providers.find((p) => p.id === "codex")?.installed).toBe(false);
  expect(st.executors.excluded).toContainEqual(expect.objectContaining({ id: "codex", account: "codex", reason: "not installed" }));
});

test("displayName", () => {
  expect(displayName("claude-code")).toBe("Claude");
  expect(displayName("agy")).toBe("Antigravity");
  expect(displayName("byteplus")).toBe("BytePlus");
  expect(displayName("opencode-go")).toBe("Opencode-go");
});

test("agy uses the Antigravity CLI binary", () => {
  const s = validateStrategy({ planner: "codex", providers: { agy: {} } }, "/x");
  expect(binaryFor(s.providers.agy)).toBe("agy");
});
