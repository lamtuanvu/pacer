import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { goldenPath, recordRoutingSet } from "../scripts/golden/routing-set";

test("routing.set oracle captures source bytes, refusals and durable events", async () => {
  const actual = await recordRoutingSet();
  expect(actual).toEqual(JSON.parse(readFileSync(goldenPath, "utf8")));
  const rows = actual as Array<{ id: string; outcome: { result?: { diff: string }; error?: { code: string } }; edited: string; activity: unknown[]; outbox: unknown[]; opencode: string | null; mode: number }>;
  expect(rows).toHaveLength(11);
  expect(rows.find(row => row.id === "unchanged-default")?.outcome.result?.diff).toBe("");
  const successful = rows.filter(row => row.outcome.result);
  expect(successful.length).toBeGreaterThan(0);
  for (const row of successful) {
    expect(row.mode).toBe(0o600);
    expect(row.opencode).toContain('"provider": {}');
    expect(row.activity).toHaveLength(1);
    expect(row.outbox).toHaveLength(2);
  }
  for (const row of rows.filter(row => row.outcome.error)) {
    expect(row.edited).not.toBe("");
    expect(row.activity).toHaveLength(0);
    expect(row.outbox).toHaveLength(0);
  }
});
