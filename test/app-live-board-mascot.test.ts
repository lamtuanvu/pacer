/** Mascots: pure, seeded from the executor identity, no assets. */
import { expect, test } from "bun:test";
import { MASCOT_COLUMNS, MASCOT_ROWS, MASCOT_TONES, PERSON_FIGURE, mascotFor } from "../app/src/screens/runs/mascot";

const GOLDEN: Record<string, { rows: string[]; eyes: Array<[number, number]>; tone: number; accessory: string }> = {
  "oc-glm": { rows: ["...#...", "..###..", ".#####.", ".#####.", "..###..", ".#####.", "..###..", "..#.#.."], eyes: [[2, 3], [4, 3]], tone: 2, accessory: "antenna" },
  "claude-code": { rows: ["..#.#..", ".#####.", "..###..", ".#####.", ".#####.", ".#####.", "#######", "..#.#.."], eyes: [[2, 4], [4, 4]], tone: 4, accessory: "ears" },
};

const signature = (id: string) => { const m = mascotFor(id); return `${m.rows.join("/")}|${m.eyes.join(";")}|${m.tone}|${m.accessory}`; };

test("the same identity always grows the same creature", () => {
  for (const id of ["oc-glm", "claude-code", "codex", "cursor"]) {
    expect(mascotFor(id)).toEqual(mascotFor(id));
    expect(signature(id)).toBe(signature(id));
  }
  // identity is trimmed; an empty identity is one stable creature rather than an error
  expect(signature("  oc-glm ")).toBe(signature("oc-glm"));
  expect(signature("")).toBe(signature("unknown"));
});

test("known identities keep their look across releases (golden pixels)", () => {
  expect(mascotFor("oc-glm")).toEqual({
    seed: "oc-glm",
    rows: GOLDEN["oc-glm"]!.rows, eyes: GOLDEN["oc-glm"]!.eyes, tone: GOLDEN["oc-glm"]!.tone, accessory: GOLDEN["oc-glm"]!.accessory,
  });
  expect(mascotFor("claude-code")).toMatchObject({ rows: GOLDEN["claude-code"]!.rows, tone: GOLDEN["claude-code"]!.tone, accessory: GOLDEN["claude-code"]!.accessory });
});

test("different executors look different", () => {
  const ids = Array.from({ length: 60 }, (_, i) => `executor-${i}`);
  expect(new Set(ids.map(signature)).size).toBeGreaterThanOrEqual(55);
});

test("every creature is well formed: mirrored, with a torso, eyes inside the body, a known tone", () => {
  for (let i = 0; i < 200; i++) {
    const m = mascotFor(`seed-${i}`);
    expect(m.rows).toHaveLength(MASCOT_ROWS);
    for (const row of m.rows) {
      expect(row).toHaveLength(MASCOT_COLUMNS);
      expect(row).toMatch(/^[#.]+$/);
      expect([...row].reverse().join("")).toBe(row);
    }
    for (let r = 2; r <= 6; r++) expect(m.rows[r]!.slice(2, 5)).toBe("###");
    expect(m.eyes).toHaveLength(2);
    for (const [c, r] of m.eyes) expect(m.rows[r]![c]).toBe("#");
    expect(m.tone).toBeGreaterThanOrEqual(1);
    expect(m.tone).toBeLessThanOrEqual(MASCOT_TONES);
  }
});

test("the person is a fixed figure no seed can produce", () => {
  expect(PERSON_FIGURE).toHaveLength(MASCOT_ROWS);
  for (let i = 0; i < 500; i++) expect(mascotFor(`seed-${i}`).rows).not.toEqual([...PERSON_FIGURE]);
});
