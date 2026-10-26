import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { goldenPath, recordStrategyLists } from "../scripts/golden/strategy-list";

test("strategy.list oracle captures default, named, active and invalid entries", () => {
  const actual = recordStrategyLists();
  expect(actual).toEqual(JSON.parse(readFileSync(goldenPath, "utf8")));
  expect(actual.map(item => item.id)).toEqual(["default-only", "named-inactive", "named-active", "invalid-named", "pacing-first", "legacy-opencode"]);
  expect(actual[0].result[0].active).toBe(true);
  expect(actual[1].result[0].description).toBe("");
  expect(actual[2].result[1].active).toBe(true);
  expect(actual[3].result[1].summary).toBe("Invalid or missing strategy");
  expect(actual[4].result[0].summary).toBe("Codex first, Claude keeps 20%; even policy");
  expect(actual[5].result[0].summary).toBe("Configured executors, OpenCode keeps 15%");
});
