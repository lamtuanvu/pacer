import { expect, test } from "bun:test";

// A conflict marker left in CSS makes browsers drop the next rule, and in TS it breaks the build only sometimes.
test("tracked source files contain no merge conflict markers", () => {
  const result = Bun.spawnSync(["git", "grep", "-nE", "^(<{7}|\\|{7}|={7}|>{7})( |$)", "--", "app", "src", "desktop/ui", "scripts", "test", ":!*.md"]);
  expect(result.stdout.toString()).toBe("");
});
