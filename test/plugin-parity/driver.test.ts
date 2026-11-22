/**
 * Driver self-test: prove the scripted host reproduces the plugin's behavior the
 * same way through the TypeScript CLI and the Rust front door (M3 C0a). The
 * Rust side only runs when PACER_TEST_FRONT_DOOR is set; without it the parity
 * case is skipped and the rest of the suite still passes.
 */
import { describe, expect, test } from "bun:test";
import { drive, parity, rustArgv, tsArgv } from "./driver";
import type { Answer } from "./driver";

const notifyStep = {
  method: "notifier.deliver",
  params: { key: "k", title: "T", body: "B", url: "/app/" },
};
const notifyAnswers: Record<string, Answer> = {
  "capability.config.get": () => ({ config: { platform: "linux" } }),
  "capability.process.spawn": () => ({ code: 0, timedOut: false, stdout: "", stderr: "" }),
  "capability.log": () => ({ ok: true }),
};

describe("plugin parity driver", () => {
  test("the driver records hello, results and the capability-call sequence for the TS notifier", async () => {
    const ts = await drive(tsArgv("pacer-notify"), "pacer-notify", [notifyStep], notifyAnswers);
    expect((ts.hello as any)?.id).toBe("pacer-notify");
    expect(ts.steps[0]!.result).toEqual({ delivered: true });
    expect(ts.calls.map((c) => c.method)).toEqual(["capability.config.get", "capability.process.spawn"]);
    const spawn = ts.calls.find((c) => c.method === "capability.process.spawn")!;
    expect(spawn.params).toEqual({ argv: ["notify-send", "--", "T", "B"], timeoutMs: 5000 });
    expect(spawn.owned).toBe(true);
  }, 20000);

  test("an unanswered capability is denied as the Rust harness denies it", async () => {
    const noSpawn: Record<string, Answer> = {
      "capability.config.get": () => ({ config: { platform: "linux" } }),
      "capability.log": () => ({ ok: true }),
    };
    const ts = await drive(tsArgv("pacer-notify"), "pacer-notify", [notifyStep], noSpawn);
    expect(ts.steps[0]!.result).toEqual({ delivered: false });
    expect(ts.calls.map((c) => c.method)).toEqual([
      "capability.config.get",
      "capability.process.spawn",
      "capability.log",
    ]);
    const log = ts.calls.find((c) => c.method === "capability.log")!;
    expect(log.params).toEqual({ level: "warn", message: "OS notification delivery failed" });
  }, 20000);

  test("rustArgv is null without a front door and throws when parity is required", () => {
    const saved = { door: process.env.PACER_TEST_FRONT_DOOR, req: process.env.PACER_REQUIRE_PARITY };
    try {
      delete process.env.PACER_REQUIRE_PARITY;
      delete process.env.PACER_TEST_FRONT_DOOR;
      expect(rustArgv("pacer-notify")).toBeNull();

      process.env.PACER_REQUIRE_PARITY = "1";
      expect(() => rustArgv("pacer-notify")).toThrow(/PACER_TEST_FRONT_DOOR/);

      process.env.PACER_TEST_FRONT_DOOR = "/x/pacer";
      expect(rustArgv("pacer-notify")).toEqual(["/x/pacer", "plugin", "run", "pacer-notify"]);
    } finally {
      if (saved.door === undefined) delete process.env.PACER_TEST_FRONT_DOOR;
      else process.env.PACER_TEST_FRONT_DOOR = saved.door;
      if (saved.req === undefined) delete process.env.PACER_REQUIRE_PARITY;
      else process.env.PACER_REQUIRE_PARITY = saved.req;
    }
  });

  const front = rustArgv("pacer-notify");
  test.skipIf(!front)(
    "a TypeScript row through the Rust door reproduces the TS transcript",
    async () => {
      const { ts, rust } = await parity("pacer-notify", [notifyStep], notifyAnswers);
      expect(rust).toEqual(ts);
    },
    30000,
  );
});
