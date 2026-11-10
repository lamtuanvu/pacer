import { expect, test } from "bun:test";
import { testSandboxProfile } from "../scripts/test-sandbox";

test("sandbox profile validates the protected port", () => {
  for (const port of [0, 65536, -1, 1.5]) expect(() => testSandboxProfile(port)).toThrow();
  for (const port of [4317, 11434, 1234, 41343]) expect(testSandboxProfile(4317, 11434, 1234, 41343)).toContain(`localhost:${port}`);
});
