import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { recordCliFlows } from "../scripts/golden/session-cli-flow";
test("session CLI success and refusal branches preserve API orchestration", async () => {
  const path = new URL(
      "./fixtures/sessions/cli-flow-parity.json",
      import.meta.url,
    ),
    rows = await recordCliFlows();
  if (process.env.UPDATE_SESSION_GOLDENS === "1")
    writeFileSync(path, JSON.stringify(rows, null, 2) + "\n");
  expect(rows).toEqual(JSON.parse(readFileSync(path, "utf8")));
});
