import { expect, test } from "bun:test";
import { join } from "node:path";

// Launched explicitly by setup-toolchain-home.test.ts; no Rust command runs.
test("actual setup isolates user state while retaining provisioned toolchain homes", () => {
  expect(process.env.HOME).not.toBe(process.env.PACER_TEST_ORIGINAL_HOME);
  expect(process.env.PACER_HOME).toBe(join(process.env.HOME!, ".pacer"));
  expect(process.env.CARGO_HOME).toBe(process.env.PACER_TEST_EXPECT_CARGO_HOME);
  expect(process.env.RUSTUP_HOME).toBe(process.env.PACER_TEST_EXPECT_RUSTUP_HOME);
});
