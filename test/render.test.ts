import { expect, test } from "bun:test";
import type { Status } from "../src/engine/status";
import { renderHook } from "../src/render/hook";
import { fmtReset, renderLine } from "../src/render/line";
import { renderText } from "../src/render/text";
import { localTs } from "./helpers";

const now = localTs(2026, 10, 10, 19, 0);
const w = (name: string, used: number, verdict: string, extra: object = {}) =>
  ({ name, usedPct: used, resetsAt: null, lengthS: 1, paced: true, verdict, ...extra }) as never;

const ST: Status = {
  generatedAt: now, strategy: "default", planner: "claude-code", mode: "normal", disabled: false, calendarPace: false,
  providers: [
    { id: "claude-code", usage: "quota", windows: [w("weekly", 4, "ON_PACE", { pace: 10, resetsAt: localTs(2026, 10, 17, 12, 0), activeHoursLeft: 57 })], binding: null, verdict: "ON_PACE", installed: true, stale: false },
    { id: "codex", usage: "quota", windows: [w("weekly", 100, "EXHAUSTED", { pace: 30, resetsAt: localTs(2026, 10, 15, 17, 29) })], binding: null, verdict: "EXHAUSTED", installed: true, stale: false },
    { id: "byteplus", usage: "quota", windows: [w("weekly", 17, "EXPIRING", { pace: 86, resetsAt: localTs(2026, 10, 11, 1, 0), activeHoursLeft: 6 })], binding: null, verdict: "EXPIRING", installed: true, stale: false },
    { id: "local", usage: "unmetered", windows: [], binding: null, verdict: "OK", installed: true, stale: false },
  ],
  executors: { ranked: [{ id: "byteplus", score: 119, verdict: "EXPIRING", reason: "" }, { id: "local", score: 0, verdict: "OK", reason: "" }], excluded: [{ id: "codex", reason: "exhausted" }] },
};
for (const p of ST.providers) p.binding = p.windows[0] ?? null;

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("fmtReset shows a time within 20h and a weekday after", () => {
  expect(fmtReset(localTs(2026, 10, 11, 9, 5), now)).toBe("↻ 09:05");
  expect(fmtReset(localTs(2026, 10, 15, 17, 29), now)).toBe("↻ Thu 17:29");
  expect(fmtReset(null, now)).toBe("");
});

test("status line: two explicit lines, Unicode symbols, no emoji", () => {
  const out = strip(renderLine(ST));
  const [l1, l2] = out.split("\n");
  expect(l1).toContain("◆ Budget");
  expect(l1).toContain("Claude 4% used / 10% pace ✓ on pace ↻ Sat 12:00");
  expect(l1).toContain("Codex 100% used / 30% pace ✗ exhausted, avoid ↻ Thu 17:29");
  expect(l1).toContain("BytePlus 17% used / 86% pace ↓ resets soon unused, use it ↻ 01:00");
  expect(l1).toContain("Local ✓ ok");
  expect(l2).toBe("» Mode  normal: Claude plans + tiny edits, delegate execution  │  next executor: BytePlus (Codex unavailable)");
  expect(/\p{Extended_Pictographic}/u.test(out.replace(/[✓✗↓↻▲▼◆»│!]/g, ""))).toBe(false);
});

test("text report and claude-code hook JSON", () => {
  const text = renderText(ST);
  expect(text).toContain("- Claude: weekly 4% (pace 10%, 57 active-h left) ON_PACE");
  expect(text).toContain("Mode: NORMAL");
  expect(text).toContain("Executor preference: byteplus > local (excluded: codex: exhausted)");
  expect(text).toContain("Pace clock: learned activity");
  const hook = JSON.parse(renderHook(ST, "claude-code"));
  expect(hook.hookSpecificOutput.hookEventName).toBe("SessionStart");
  expect(hook.hookSpecificOutput.additionalContext).toContain("Subscription budget status (pacer)");
  expect(renderHook(ST, "codex")).toContain("Subscription budget status (pacer)");
});

test("disabled status says so in every renderer", () => {
  const off = { ...ST, disabled: true };
  expect(strip(renderLine(off))).toContain("pacer off (PACER=off)");
  expect(JSON.parse(renderHook(off, "claude-code")).hookSpecificOutput.additionalContext).toContain("PACER=off");
});
