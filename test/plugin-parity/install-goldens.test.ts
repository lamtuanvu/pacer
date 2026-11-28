import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  recordHelpers,
  recordPlanOracle,
  recordPolicyText,
  recordUndoOracle,
} from "../../scripts/plugin-parity/install-goldens";

const golden = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../../crates/plugin-sdk/tests/fixtures/install/${name}`,
        import.meta.url,
      ),
      "utf8",
    ),
  );

test("helpers golden matches the TypeScript host (re-record: bun scripts/plugin-parity/install-goldens.ts)", () => {
  expect(JSON.parse(JSON.stringify(recordHelpers()))).toEqual(golden("helpers-oracle.json"));
});

test("policy text golden matches the TypeScript plugin SDK", () => {
  expect(JSON.parse(JSON.stringify(recordPolicyText()))).toEqual(golden("policy-text.json"));
});

test("undo golden matches the TypeScript host manifest helpers", () => {
  expect(JSON.parse(JSON.stringify(recordUndoOracle()))).toEqual(golden("undo-oracle.json"));
});

test("plan staging golden matches the TypeScript host transaction", () => {
  expect(JSON.parse(JSON.stringify(recordPlanOracle()))).toEqual(golden("plan-oracle.json"));
});
