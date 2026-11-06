import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { usageRefreshCapability } from "../src/usage";
import type { AccountCfg } from "../src/config/accounts";

const ROOT = join(import.meta.dir, "..");
const TARGET = join(ROOT, "target");

function probe(args: string[]) {
  execFileSync("cargo", ["build", "-q", "-p", "pacer-engine", "--bin", "usage_refresh_probe"], {
    cwd: ROOT,
    env: { ...process.env, CARGO_TARGET_DIR: TARGET },
  });
  const bin = join(TARGET, "debug", "usage_refresh_probe");
  return execFileSync(bin, args, { encoding: "utf8" }).trim();
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

test("usage_refresh capability matches usageRefreshCapability", () => {
  const cases: AccountCfg[] = [
    { name: "claude", kind: "claude", usage: "quota" } as AccountCfg,
    { name: "work", kind: "codex", usage: "quota" } as AccountCfg,
    { name: "plan", kind: "endpoint", source: "opencode", usage: "quota", quotaSource: "arkcli" } as AccountCfg,
    { name: "cursor", kind: "cursor", usage: "reactive" } as AccountCfg,
    { name: "x", kind: "endpoint", source: "opencode", usage: "metered" } as AccountCfg,
  ];
  for (const account of cases) {
    expect(probe(["capability", JSON.stringify(account)])).toBe(usageRefreshCapability(account));
  }
});

test("usage_refresh outcome matches refresh coordinator rules", () => {
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
    const rust = probe([
      "outcome",
      row.capability,
      JSON.stringify(row.prior),
      JSON.stringify(row.current),
    ]);
    expect(rust).toBe(ts);
  }
});

test("automatic_refresh_suppressed matches 15-minute throttle", () => {
  expect(probe(["automatic", "1000", "200", "1"])).toBe("true");
  expect(probe(["automatic", "1000", "", "1"])).toBe("false");
  expect(probe(["automatic", "1000", "200", "0"])).toBe("false");
});
