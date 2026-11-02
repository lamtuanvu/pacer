import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { recordKeys } from "../scripts/golden/session-keys";

test("attach key golden matches the TypeScript reference", () => {
  expect(recordKeys()).toEqual(
    JSON.parse(
      readFileSync(
        new URL("./fixtures/sessions/keys-parity.json", import.meta.url),
        "utf8",
      ),
    ),
  );
});
