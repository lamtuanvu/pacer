import { expect, test } from "bun:test";
import { testSandboxProfile } from "../scripts/test-sandbox";

test("sandbox profile validates the protected port", () => {
  for (const port of [0, 65536, -1, 1.5]) expect(() => testSandboxProfile(port)).toThrow();
  for (const port of [4317, 11434, 1234, 41343]) expect(testSandboxProfile(4317, 11434, 1234, 41343)).toContain(`localhost:${port}`);
});

test("sandbox profile protects the real installation and service manager", () => {
  const profile = testSandboxProfile(4317);
  expect(profile).toContain('(deny process-exec (literal "/bin/launchctl"))');
  expect(profile).toContain('(deny file-write*');
  for (const path of ["/.pacer", "/Applications/pacer.app", "/.local/bin/pacer", "/.local/bin/pacer-core", "/Library/LaunchAgents/com.pacer.serve.plist"]) expect(profile).toContain(path);
});
