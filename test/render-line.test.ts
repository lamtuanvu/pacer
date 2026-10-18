import { expect, test } from "bun:test";
import fixture from "./fixtures/ui/snapshot.json";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import { lineFields, renderLine } from "../src/render/line";
const snapshot = () => structuredClone(fixture) as ClientSnapshot;
const rgb = (s: string, hex: string) => `\x1b[38;2;${hex.match(/../g)!.map(x => parseInt(x, 16)).join(";")}m${s}\x1b[0m`;
for (const [width, plain, colored] of [
  [120, "▬┃ Claude 63%·77  ▸2  ⚑4", `${rgb("▬", "a3e635")}${rgb("┃", "a3e635")} ${rgb("Claude", "D97757")} 63%·77  ${rgb("▸2", "93c5fd")}  ${rgb("⚑4", "fcd34d")}`],
  [60, "▬┃ Claude 63%·77  ▸2  ⚑4", `${rgb("▬", "a3e635")}${rgb("┃", "a3e635")} ${rgb("Claude", "D97757")} 63%·77  ${rgb("▸2", "93c5fd")}  ${rgb("⚑4", "fcd34d")}`],
  [40, "▬┃ 63%·77 ▸2 ⚑4", `${rgb("▬", "a3e635")}${rgb("┃", "a3e635")} 63%·77 ${rgb("▸2", "93c5fd")} ${rgb("⚑4", "fcd34d")}`],
  [20, "▬┃63 ⚑4", `${rgb("▬", "a3e635")}${rgb("┃", "a3e635")}63 ${rgb("⚑4", "fcd34d")}`],
] as const) {
  test(`fixture golden at ${width} columns`, () => {
    expect(renderLine(snapshot(), { width, color: false })).toBe(plain);
    expect(renderLine(snapshot(), { width, color: true })).toBe(colored);
  });
}
test("offline and unknown usage", () => {
  expect(renderLine(null)).toMatch(/▬┃(\x1b\[0m)? pacer not running · pacer serve$/);
  const s = snapshot(); s.planner!.usedPct = null; s.planner!.pacePct = null;
  expect(renderLine(s, { color: false })).toContain("usage unknown");
});
test("mode only when non-normal; needs hidden at zero", () => {
  const s = snapshot(); s.planner!.mode = "relaxed"; s.counts!.attention = 0;
  expect(renderLine(s, { color: false, width: 120 })).toBe("▬┃ Claude 63%·77  ▸2  relaxed");
  expect(renderLine(s, { color: false, width: 60 })).toBe("▬┃ Claude 63%·77  ▸2");
});
test("ahead and out use service verdicts and colour only the tick", () => {
  const s = snapshot(); s.planner!.verdict = "ahead";
  expect(renderLine(s)).toStartWith(rgb("▬", "a3e635") + rgb("┃", "fcd34d"));
  expect(renderLine(s, { color: false })).toContain("63%·77 ahead");
  s.planner!.verdict = "out";
  expect(renderLine(s)).toStartWith(rgb("▬", "a3e635") + rgb("┃", "fca5a5"));
  expect(renderLine(s, { color: false })).toContain("out · back");
});
test("JSON fields preserve snapshot counts and planner values", () => {
  expect(lineFields(snapshot())).toEqual({ online: true, planner: "Claude", agent: "claude-code", usedPct: 63, pacePct: 77, verdict: "behind", resetsAt: 1800259200, running: 2, attention: 4, mode: "normal" });
});
test("Codex uses its shared identity and invalid counts stay unknown", () => {
  const s = snapshot(); s.planner!.agent = "codex";
  expect(renderLine(s)).toContain(rgb("Codex", "fafafa"));
  s.counts!.running = -1; s.counts!.attention = NaN;
  expect(lineFields(s)).toMatchObject({ running: null, attention: null });
  expect(renderLine(s, { color: false })).toBe("▬┃ Codex 63%·77");
});
test("narrow ahead/out states preserve the needs-you count", () => {
  const s = snapshot();
  for (const verdict of ["ahead", "out"] as const) {
    s.planner!.verdict = verdict;
    expect(renderLine(s, { color: false, width: 20 })).toBe("▬┃63 ⚑4");
  }
});
