import { expect, test } from "bun:test";
import {
  CAPABILITY_METHODS,
  EXTENSION_METHODS,
  capabilityOf,
  manifestSchema,
} from "../src/plugins/protocol";
test("planner command capability maps strict intent to process.spawn", () => {
  expect(capabilityOf("capability.planner.run")).toBe("process.spawn");
  const schema = CAPABILITY_METHODS["capability.planner.run"]?.params;
  expect(
    schema?.safeParse({
      argv: ["tool", "mcp", "list"],
      timeoutMs: 30000,
      undo: ["tool", "mcp", "remove", "pacer"],
    }).success,
  ).toBe(true);
  for (const field of [
    "purpose",
    "mode",
    "context",
    "env",
    "cwd",
    "record",
    "planner",
    "lease",
  ]) {
    expect(
      schema?.safeParse({ argv: ["tool"], timeoutMs: 30000, [field]: "forged" })
        .success,
    ).toBe(false);
  }
});
test("planner extension schema declares prepare-only final data and rejects spoofed context fields", () => {
  expect(
    manifestSchema.safeParse({
      id: "pacer-planners",
      version: "1.0.0",
      publisher: "pacer",
      host: "^1",
      contributes: { planner: {} },
    }).success,
  ).toBe(true);
  expect(EXTENSION_METHODS["planner.install"]).toBeDefined();
  expect(CAPABILITY_METHODS["capability.planner.commit"]).toBeUndefined();
  expect(CAPABILITY_METHODS["capability.planner.rollback"]).toBeUndefined();
});
