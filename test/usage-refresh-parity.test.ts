import { beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { usageRefreshCapability } from "../src/usage";
import type { AccountCfg } from "../src/config/accounts";

// B12-5: the pure refresh rules are exercised through the shared status_probe
// C3 driver, so there is one native parity binary for the status library.

const ROOT = join(import.meta.dir, "..");
const TARGET = join(ROOT, "target");
let probeBin = "";

beforeAll(() => {
  const target = process.env.CARGO_TARGET_DIR ?? TARGET;
  execFileSync("cargo", ["build", "-q", "-p", "pacer-status", "--example", "status_probe", "--locked"], {
    cwd: ROOT,
    env: { ...process.env, CARGO_TARGET_DIR: target },
  });
  probeBin = join(target, "debug", "examples", "status_probe");
});

function probe(fn: string, args: Record<string, unknown>): string {
  const input = JSON.stringify({ fn, home: ROOT, now: 0, env: {}, args }) + "\n";
  const out = execFileSync(probeBin, { input, encoding: "utf8" }).trim();
  const reply = JSON.parse(out.split("\n").at(-1) ?? "{}") as { result?: unknown; error?: string };
  if (reply.error) throw new Error(reply.error);
  return String(reply.result);
}

function tsOutcome(
  capability: ReturnType<typeof usageRefreshCapability>,
  prior: { capturedAt: number | null; stale?: boolean; error?: string | null },
  current: { capturedAt: number | null; stale?: boolean; error?: string | null },
) {
  if (capability === "unavailable") return "unsupported";
  if (current.error && capability !== "passive-log") return "failed";
  const priorAt = prior.capturedAt ?? -Infinity;
  if (!current.stale && current.capturedAt !== null && current.capturedAt > priorAt) return "updated";
  return "unchanged";
}

test("refresh_capability matches usageRefreshCapability", () => {
  const cases: AccountCfg[] = [
    { name: "claude", kind: "claude", usage: "quota" } as AccountCfg,
    { name: "work", kind: "codex", usage: "quota" } as AccountCfg,
    { name: "plan", kind: "endpoint", source: "opencode", usage: "quota", quotaSource: "arkcli" } as AccountCfg,
    { name: "cursor", kind: "cursor", usage: "reactive" } as AccountCfg,
    { name: "x", kind: "endpoint", source: "opencode", usage: "metered" } as AccountCfg,
  ];
  for (const account of cases) {
    expect(probe("refresh_capability", { account })).toBe(usageRefreshCapability(account));
  }
});

test("refresh_outcome matches refresh coordinator rules", () => {
  const matrix: {
    capability: "provider-command" | "passive-log" | "unavailable";
    prior: { capturedAt: number | null; stale?: boolean };
    current: { capturedAt: number | null; stale?: boolean; error?: string | null };
  }[] = [
    { capability: "provider-command", prior: { capturedAt: 100 }, current: { capturedAt: 200, stale: false } },
    { capability: "provider-command", prior: { capturedAt: 100 }, current: { capturedAt: 100, stale: false } },
    { capability: "provider-command", prior: { capturedAt: 100 }, current: { capturedAt: null, stale: true, error: "offline" } },
    { capability: "passive-log", prior: { capturedAt: null }, current: { capturedAt: null, stale: false, error: "boom" } },
    { capability: "unavailable", prior: { capturedAt: null }, current: { capturedAt: null, stale: false } },
  ];
  for (const row of matrix) {
    const ts = tsOutcome(row.capability, row.prior, row.current);
    const rust = probe("refresh_outcome", row);
    expect(rust).toBe(ts);
  }
});

test("automatic_refresh_suppressed matches 15-minute throttle", () => {
  const check = (now: number, last: number | null, automatic: boolean) =>
    probe("automatic_refresh_suppressed", { now, last, automatic });
  expect(check(1000, 200, true)).toBe("true");
  expect(check(1000, null, true)).toBe("false");
  expect(check(1000, 200, false)).toBe("false");
});
