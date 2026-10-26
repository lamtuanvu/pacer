import { expect, test } from "bun:test";
import { main } from "../scripts/live/cli";
test("initial layout is a fixed build-only option and cannot be selected during exercise", async () => {
  await expect(main(["ota", "build", "--id", "nonexistent-layout-fixture", "--initial-layout", "unknown"])).rejects.toThrow("--initial-layout must be bridge or paired");
  await expect(main(["ota", "exercise", "--id", "nonexistent-layout-fixture", "--scenario", "adopt", "--initial-layout", "paired"])).rejects.toThrow("Unsupported OTA option");
  await expect(main(["status", "--initial-layout", "paired"])).rejects.toThrow("OTA options require the ota command");
  // Both platforms refuse the default adhoc signer before session/keychain operations.
  let error: unknown;
  try { await main(["ota", "build", "--id", "nonexistent-layout-fixture", "--initial-layout", "paired"]); } catch (value) { error = value; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(/Native fixtures require macOS|requires --signer cert/);
});

test("fixture old-service choice is an opt-in paired build flag only", async () => {
  await expect(main(["status", "--fixture-continue-old-service"])).rejects.toThrow("OTA build");
  await expect(main(["ota", "exercise", "--id", "nonexistent-choice-fixture", "--scenario", "adopt", "--fixture-continue-old-service"])).rejects.toThrow("OTA build");
  await expect(main(["ota", "build", "--id", "nonexistent-choice-fixture", "--fixture-continue-old-service"])).rejects.toThrow("paired layout");
});
