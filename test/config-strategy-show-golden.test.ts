import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { goldenPath, recordStrategyShows } from "../scripts/golden/strategy-show";

test("strategy.show TypeScript golden remains fresh", () => {
  expect(JSON.parse(readFileSync(goldenPath, "utf8"))).toEqual(recordStrategyShows());
});
