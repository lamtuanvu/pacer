import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { recordControl } from "../scripts/golden/session-control";
test("session view/control golden matches the TS reference", () => {
  expect(recordControl()).toEqual(
    JSON.parse(
      readFileSync(
        new URL("./fixtures/sessions/control-parity.json", import.meta.url),
        "utf8",
      ),
    ),
  );
});
import { recordViewers } from "../scripts/golden/session-viewers";
test("viewer arbitration golden matches TS reference", () => {
  expect(recordViewers()).toEqual(
    JSON.parse(
      readFileSync(
        new URL("./fixtures/sessions/viewers-parity.json", import.meta.url),
        "utf8",
      ),
    ),
  );
});
