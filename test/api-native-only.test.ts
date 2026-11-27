import { describe, expect, test } from "bun:test";
import { nativeOnly } from "../src/api/native-only";

test("nativeOnly refuses with an unavailable code for the named op", async () => {
  const error = await nativeOnly("x.y")().then(
    () => null,
    e => e,
  );
  expect(error).not.toBeNull();
  expect(error.code).toBe("unavailable");
  expect(error.message).toBe("x.y is answered by the pacer front door");
  expect(error.hint).toBe("Unset PACER_FORWARD_OPS for this operation.");
});