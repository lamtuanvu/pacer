import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { recordStrategyDocs, compareStrategyDocGoldens, strategyDocGoldenPath } from "../scripts/golden/strategy-doc";

test("StrategyDoc corpus replays deterministically against the committed byte goldens", () => {
  const first = recordStrategyDocs();
  expect(first).toEqual(recordStrategyDocs());
  const expected = JSON.parse(readFileSync(strategyDocGoldenPath, "utf8"));
  expect(compareStrategyDocGoldens(expected, first)).toEqual([]);
  expect(new Set(first.map(c => c.op))).toEqual(new Set([
    "getIn", "setIn", "deleteIn", "replaceNode", "addMappingEntry", "removeMappingEntry", "setScalar", "setList", "renameKey",
  ]));
});

test("golden comparison detects formatting-only mutations and missing cases", () => {
  const expected = recordStrategyDocs();
  for (const mutate of [
    (text: string) => text + "\n",
    (text: string) => text.replace("# planner stays here", "# changed comment"),
    (text: string) => text.replace("planner: codex", 'planner: "codex"'),
    (text: string) => text.replace("{kind: codex}", "{ kind: codex }"),
  ]) {
    const actual = structuredClone(expected);
    const target = actual.find(c => c.id === "scalar-inline-comment")!;
    target.after = mutate(target.after);
    expect(compareStrategyDocGoldens(expected, actual)).toContain("scalar-inline-comment");
  }
  expect(compareStrategyDocGoldens(expected, expected.slice(1))).toContain(expected[0]!.id);
});


test("corpus exercises successful classes rather than recording unexpected errors", () => {
  const cases = recordStrategyDocs();
  expect(cases.length).toBeGreaterThanOrEqual(60);
  expect(new Set(cases.map(c => c.id)).size).toBe(cases.length);
  for (const item of cases) {
    expect(Boolean(item.error)).toBe(item.classes.includes("error"));
    if (item.error) expect(item.after).toBe(item.before);
  }
  const crlf = cases.filter(c => c.classes.includes("crlf"));
  expect(crlf.length).toBeGreaterThanOrEqual(6);
  for (const item of crlf) expect(item.after.replaceAll("\r\n", "")).not.toContain("\n");
  const byId = (id: string) => cases.find(c => c.id === id)!;
  expect(byId("list-block-survivor-comment").after).toContain("- codex # default runner");
  expect(byId("quote-single").after).toContain("planner: 'runner: next'");
  expect(byId("quote-double").after).toContain('planner: "runner: next"');
  expect(byId("get-missing").result).toEqual({ found: false });
  expect(byId("get-null").result).toEqual({ found: true, value: null });
});
