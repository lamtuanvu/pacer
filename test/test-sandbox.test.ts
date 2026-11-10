import { expect, test } from "bun:test";
import { testSandboxProfile } from "../scripts/test-sandbox";

test("sandbox profile validates the protected port", () => {
  for (const port of [0, 65536, -1, 1.5]) expect(() => testSandboxProfile(port)).toThrow();
  expect(testSandboxProfile(12345)).toContain("localhost:12345");
});
