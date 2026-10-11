import { expect, test } from "bun:test";
import type { ActivityProfile } from "../src/pace/activity";
import { activeHoursLeft, activeSeconds, isCalendar, pacePct } from "../src/pace/clock";
import { localTs } from "./helpers";

function profile(activeHours: number[], days = 10): ActivityProfile {
  const bins = new Array(168).fill(0);
  for (let wd = 0; wd < 7; wd++) for (const h of activeHours) bins[wd * 24 + h] = 5;
  return { builtAt: 0, days, bins, active: bins.map((b) => b > 0) };
}
const WORK = [9, 10, 11, 12, 13, 14, 15, 16, 17]; // 09:00-18:00 every day

test("calendar fallback: no profile, fewer than 7 days, or no active hours", () => {
  expect(isCalendar(null)).toBe(true);
  expect(isCalendar(profile(WORK, 6))).toBe(true);
  expect(isCalendar({ ...profile([], 10) })).toBe(true);
  expect(isCalendar(profile(WORK, 7))).toBe(false);
  const start = localTs(2026, 10, 5);
  expect(pacePct(start, start + 7 * 86400, start + 3.5 * 86400, null)).toBeCloseTo(50);
});

test("learned profile: pace only advances in active hours", () => {
  const p = profile(WORK);
  const start = localTs(2026, 10, 5); // Monday 00:00
  const end = start + 7 * 86400;
  expect(activeSeconds(start, end, p)).toBe(63 * 3600);
  // Monday 13:30 -> 4.5 of 63 active hours
  expect(pacePct(start, end, localTs(2026, 10, 5, 13, 30), p)).toBeCloseTo((4.5 / 63) * 100);
  // overnight the line does not move
  expect(pacePct(start, end, localTs(2026, 10, 5, 23, 0), p)).toBeCloseTo(pacePct(start, end, localTs(2026, 10, 6, 8, 59), p));
  // Saturday 19:00 -> 6 full days of 9h = 54/63
  expect(pacePct(start, end, localTs(2026, 10, 10, 19, 0), p)).toBeCloseTo((54 / 63) * 100);
  expect(activeHoursLeft(localTs(2026, 10, 10, 19, 0), end, p)).toBeCloseTo(9);
});

test("now past the window end caps at 100; empty window is 0", () => {
  const start = localTs(2026, 10, 5);
  expect(pacePct(start, start + 86400, start + 2 * 86400, null)).toBe(100);
  expect(pacePct(start, start, start, null)).toBe(0);
});
