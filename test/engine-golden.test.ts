import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { engineGoldens } from "./engine-golden";

test("current TypeScript engine matches committed goldens", () => {
  expect(engineGoldens()).toEqual(JSON.parse(readFileSync("test/fixtures/engine/goldens.json", "utf8")));
});
