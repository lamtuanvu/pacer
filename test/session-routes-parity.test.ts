import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { recordRoutes } from "../scripts/golden/session-routes";
test("WebSocket routes characterize JS Number query offsets and upgrade failures", async () => {
  const path = new URL(
      "./fixtures/sessions/routes-parity.json",
      import.meta.url,
    ),
    rows = await recordRoutes();
  if (process.env.UPDATE_SESSION_GOLDENS === "1")
    writeFileSync(path, JSON.stringify(rows, null, 2) + "\n");
  expect(rows).toEqual(JSON.parse(readFileSync(path, "utf8")));
});
