import { expect, test } from "bun:test";
import {
  CAPABILITY_METHODS,
  EXTENSION_METHODS,
  secretReference,
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
test("secret references accept the shared grammar and old endpoint slash refs",()=>{
  for(const ref of ["env:KEY", "secrets:api-key", "endpoint:account-id", "endpoint/account-id"])
    expect(secretReference.safeParse(ref).success).toBe(true);
  for(const ref of ["endpoint/../key", "endpoint:", "secrets/key", "env:BAD/KEY"])
    expect(secretReference.safeParse(ref).success).toBe(false);
  expect(CAPABILITY_METHODS["capability.secrets.resolve"]?.params.safeParse({ref:"endpoint:account-id"}).success).toBe(true);
  expect(CAPABILITY_METHODS["capability.secrets.check"]?.params.safeParse({ref:"endpoint/account-id"}).success).toBe(true);
});
test("planner extension schema declares prepare-only final data and rejects spoofed context fields", () => {
  expect(
    manifestSchema.safeParse({
      id: "pacer-planners",
      version: "1.0.0",
      publisher: "pacer",
      host: "^1.6",
      contributes: { planner: {} },
    }).success,
  ).toBe(true);
  expect(EXTENSION_METHODS["planner.install"]).toBeDefined();
  expect(CAPABILITY_METHODS["capability.planner.commit"]).toBeUndefined();
  expect(CAPABILITY_METHODS["capability.planner.rollback"]).toBeUndefined();
});
