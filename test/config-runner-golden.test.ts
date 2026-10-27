import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { goldenPath, recordRunnerConfig } from "../scripts/golden/runner-config";

test("runner config oracle captures comments, refusals and durable events", async () => {
  const actual = await recordRunnerConfig();
  expect(actual).toEqual(JSON.parse(readFileSync(goldenPath, "utf8")));
  const rows = actual as Array<{ id: string; outcome: { result?: unknown; error?: { code: string } }; edited: string; activity: unknown[]; outbox: unknown[]; opencode: string | null; mode: number }>;
  expect(rows).toHaveLength(11);
  expect(rows.find(row => row.id === "reorder-invalid")?.outcome.error?.code).toBe("invalid_input");
  expect(rows.find(row => row.id === "set-planner-refusal")?.outcome.error?.code).toBe("not_allowed");
  expect(rows.find(row => row.id === "set-warning-planner")?.outcome.result).toEqual({
    id: "codex", warnings: ["routing rule 'default' has no enabled executor left"],
  });
  for (const row of rows.filter(row => row.outcome.result)) {
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
