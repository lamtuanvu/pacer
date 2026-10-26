import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { recordStrategyLoads, strategyLoadGoldenPath } from "../scripts/golden/strategy-load";

test("strategy load oracle is deterministic across valid and invalid YAML", () => {
  const actual = recordStrategyLoads();
  expect(actual).toEqual(recordStrategyLoads());
  const expected = JSON.parse(readFileSync(strategyLoadGoldenPath, "utf8"));
  expect(actual).toEqual(expected);
  expect(actual).toHaveLength(19);
  expect(new Set(actual.map(item => item.id)).size).toBe(actual.length);
  expect(actual.filter(item => item.result)).toHaveLength(11);
  expect(actual.filter(item => item.error?.kind === "strategy")).toHaveLength(7);
  expect(actual.filter(item => item.error?.kind === "yaml")).toHaveLength(1);
  expect(actual.find(item => item.id === "current-basic")?.result?.legacy).toBe(false);
  expect(actual.find(item => item.id === "legacy-basic")?.result?.legacy).toBe(true);
  expect(actual.find(item => item.id === "active-name")?.result?.name).toBe("offline");
});

test("recorded strategy files contain no checkout-specific path", () => {
  const text = readFileSync(join(import.meta.dir, "fixtures/strategy-load/goldens.json"), "utf8");
  expect(text).not.toContain(process.cwd());
  if (process.env.HOME) expect(text).not.toContain(process.env.HOME);
});
