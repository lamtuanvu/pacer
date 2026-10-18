import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { executorLabel, modeWords, phaseWords, taskStatus, toneFor, verdictWords } from "../src/view-model/words";
import { ago, clock, elapsed, meterText } from "../src/view-model/format";

test("service tones and verdicts map to one status tone table", () => {
  expect(["good", "info", "warn", "bad", "muted", "EXHAUSTED", "AHEAD", "NEAR_LIMIT", "EXPIRING", "ON_PACE", "BEHIND", "UNMETERED", "whatever"].map(toneFor))
    .toEqual(["good", "info", "warn", "bad", "neutral", "bad", "warn", "warn", "warn", "good", "good", "good", "neutral"]);
});

test("verdict words cover v1 provider verdicts and planner verdicts", () => {
  expect(verdictWords("AHEAD")).toBe("Ahead of pace");
  expect(verdictWords("EXHAUSTED")).toBe("Out of quota");
  expect(["behind", "on_pace", "ahead", "out", "unknown"].map(verdictWords)).toEqual(["Behind pace", "On pace", "Ahead of pace", "Out of quota", "Usage unknown"]);
  expect(verdictWords("nonsense")).toBe("Unknown");
});

test("phases and modes read as words", () => {
  expect(phaseWords("driving")).toBe("You're driving");
  expect(["starting", "working", "testing", "idle", "lost-contact", "queued", "other"].map(phaseWords))
    .toEqual(["Starting", "Editing", "Testing", "Idle", "Lost contact", "Queued", "other"]);
  expect(["strict", "normal", "relaxed", "emergency"].map(modeWords)).toEqual(["Strict", "Normal", "Relaxed", "Emergency"]);
});

test("moved task words keep their behaviour", () => {
  expect(taskStatus({ state: "running" })).toEqual({ label: "Working", tone: "info" });
  expect(taskStatus({ state: "done", review: { accepted: false } })).toEqual({ label: "Rejected", tone: "bad" });
  expect(executorLabel("codex#team@devbox", [{ name: "team" }])).toBe("Codex · team on devbox");
  expect(executorLabel(null)).toBe("Automatic");
});

test("relative and elapsed times", () => {
  expect(ago(100, 108)).toBe("8s ago");
  expect(ago(0, 840)).toBe("14m ago");
  expect(ago(0, 3 * 3600 + 5)).toBe("3h ago");
  expect(ago(0, 2 * 86400 + 5)).toBe("2d ago");
  expect(ago(10, 5)).toBe("0s ago");
  expect(elapsed(840)).toBe("14m");
  expect(elapsed(3900)).toBe("1h 05m");
});

test("absolute clock times are 24-hour and widen with age", () => {
  // TZ is Asia/Ho_Chi_Minh (UTC+7) in the test script. 2026-10-16 is a Friday.
  const now = Date.UTC(2026, 9, 16, 8, 0) / 1000; // 15:00 local
  expect(clock(Date.UTC(2026, 9, 16, 4, 58) / 1000, now)).toBe("11:58");
  expect(clock(Date.UTC(2026, 9, 13, 4, 58) / 1000, now)).toBe("Tue 11:58");
  expect(clock(Date.UTC(2026, 9, 1, 4, 58) / 1000, now)).toBe("1 Oct 11:58");
});

test("meter text in full and compact forms", () => {
  expect(meterText(63, 77, "compact")).toBe("63%·77");
  expect(meterText(63, 77, "full")).toBe("63% used · pace 77%");
  expect(meterText(63, null, "full")).toBe("63% used");
  expect(meterText(63.4, null, "compact")).toBe("63%");
  expect(meterText(null, 50, "full")).toBe("usage unknown");
});

test("view-model stays dependency-free", () => {
  const dir = join(import.meta.dir, "../src/view-model");
  for (const file of readdirSync(dir)) {
    const imports = [...readFileSync(join(dir, file), "utf8").matchAll(/from\s+"([^"]+)"/g)].map(m => m[1]!);
    for (const path of imports) {
      expect(path.startsWith("preact")).toBe(false);
      expect(path.startsWith("node:")).toBe(false);
      expect(path.includes("/app/")).toBe(false);
    }
  }
});

test("planner verdicts map to tones in the same table", () => {
  expect(["behind", "on_pace", "ahead", "out", "unknown"].map(toneFor)).toEqual(["good", "good", "warn", "bad", "neutral"]);
});

test("executor labels use proper names for known agents and accounts", () => {
  expect(executorLabel("local")).toBe("Local model");
  expect(executorLabel("byteplus")).toBe("BytePlus");
  expect(executorLabel("opencode#byteplus")).toBe("BytePlus");
  expect(executorLabel("gemini")).toBe("Gemini");
});
