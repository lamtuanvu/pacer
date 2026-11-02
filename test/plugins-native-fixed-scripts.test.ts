import { expect, test } from "bun:test";
import { SCRIPTS } from "../src/remote/scripts";
import scripts from "../crates/plugin-capabilities/src/native_ssh/scripts.json";
test("Rust SSH programs remain byte-for-byte identical to the authoritative TS programs", () => {
  expect(scripts).toEqual(SCRIPTS);
});

import { readFileSync } from "node:fs";
import { EXECUTOR_CONTRACT } from "../src/exec/prompt";
test("Rust Orca executor contract matches the TS prompt contract", () => {
  expect(readFileSync(new URL("../crates/plugin-runtime/src/orca_executor_contract.txt", import.meta.url), "utf8")).toBe(EXECUTOR_CONTRACT);
});
