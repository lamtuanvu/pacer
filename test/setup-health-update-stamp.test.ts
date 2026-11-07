import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setupHealthRequired } from "../src/install/setup-health-store";
import { createTestRoot } from "./temp-roots";

test("CLI update deps expose pacerHome for the post-replace health stamp", async () => {
  const { defaultUpdateDeps } = await import("../src/update/update");
  const root = createTestRoot("pacer-test-");
  const pacerHome = join(root, ".pacer");
  mkdirSync(pacerHome, { mode: 0o700 });
  const deps = defaultUpdateDeps({
    home: root,
    pacerHome,
    now: 1,
    env: {},
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    which: () => null,
  });
  expect(deps.pacerHome).toBe(pacerHome);
  expect(setupHealthRequired({ pacerHome })).toBe(false);
});
