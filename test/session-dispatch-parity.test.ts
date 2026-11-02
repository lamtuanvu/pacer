import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { recordDispatch } from "../scripts/golden/session-dispatch";
test("CLI attach and takeover dispatch every successful and fallback domain result", async () => {
  const path = new URL(
      "./fixtures/sessions/dispatch-parity.json",
      import.meta.url,
    ),
    rows = await recordDispatch();
  if (process.env.UPDATE_SESSION_GOLDENS === "1")
    writeFileSync(path, JSON.stringify(rows, null, 2) + "\n");
  expect(rows).toEqual(JSON.parse(readFileSync(path, "utf8")));
}, 30000);
