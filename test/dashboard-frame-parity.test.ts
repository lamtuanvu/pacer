import { expect, test } from "bun:test";
import inputs from "./fixtures/dashboard-frame/inputs.json";
import golden from "./fixtures/dashboard-frame/golden.json";
import { cellWidth } from "../src/dashboard/frame";
import { SECTIONS } from "../src/dashboard/screens/settings";
import { renderCase, corpus } from "./fixtures/dashboard-frame/cases";

const reference = corpus();

// Full frame strings, including trailing spaces and blank rows, are intentional.
test("TypeScript dashboard frames match the cross-runtime reference", () => {
  expect(reference as unknown).toEqual(inputs);
  const names = new Set(inputs.cases.map(c => c.name));
  expect(new Set(inputs.cases.map(c => c.name)).size).toBe(inputs.cases.length);
  expect(Object.keys(golden).sort()).toEqual([...names].sort());
  const required = ["dashboard", "review", "workspace", "thread", "settings", "upgrade", ...SECTIONS.map(s => `settings-${s.id}`)];
  for (const view of required) for (const size of ["60x16", "80x24", "120x40", "160x50"]) {
    expect(names.has(`${view}-${size}`)).toBe(true);
  }
  expect(golden["thread-120x40"]).toContain("Can you check the result?");
  expect(golden["upgrade-120x40"]).toContain("Updates");
});

// Separate tests keep the growing matrix within the normal per-test timeout.
for (const entry of reference.cases) {
  test(`dashboard frame: ${entry.name}`, () => {
    const text = renderCase(reference, entry);
    expect(text).toBe((golden as Record<string, string>)[entry.name]!);
    expect(text.split("\n")).toHaveLength(entry.height);
    expect(text).not.toContain("\x1b");
    for (const row of text.split("\n")) expect(cellWidth(row)).toBeLessThanOrEqual(entry.width);
  });
}

import referenceSemantics from "./fixtures/dashboard-frame/semantics.json";
import { semantics } from "./fixtures/dashboard-frame/semantics";
test("TypeScript text and coercion references stay fresh", () => {
  // JSON is the cross-runtime boundary; it canonically encodes negative zero as zero.
  expect(JSON.parse(JSON.stringify(semantics())) as unknown).toEqual(referenceSemantics);
});
