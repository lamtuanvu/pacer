import { expect, test } from "bun:test";
import { join } from "node:path";
import { tmpDir } from "./helpers";

test("HOME isolation keeps default and explicit Cargo/Rustup locations available to compiled tests", () => {
  const cases = [
    {},
    { CARGO_HOME: "relative-cargo", RUSTUP_HOME: "relative-rustup" },
    { CARGO_HOME: "explicit-cargo" },
    { RUSTUP_HOME: "explicit-rustup" },
    { CARGO_HOME: "", RUSTUP_HOME: "" },
  ];
  for (const overrides of cases) {
    const home = tmpDir();
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      PACER_TEST_ORIGINAL_HOME: home,
      PACER_TEST_EXPECT_CARGO_HOME: overrides.CARGO_HOME ?? join(home, ".cargo"),
      PACER_TEST_EXPECT_RUSTUP_HOME: overrides.RUSTUP_HOME ?? join(home, ".rustup"),
    };
    delete env.CARGO_HOME;
    delete env.RUSTUP_HOME;
    Object.assign(env, overrides);
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/toolchain-home-probe.ts"], {
      cwd: join(import.meta.dir, ".."), env, stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  }
});
