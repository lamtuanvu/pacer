import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchConfigSchema } from "../src/dispatch/types";
import { fakeCtx } from "./helpers";

const defaults = { simple: "small", standard: "medium", complex: "frontier" } as const;
test("tier targets default and fill partial input", () => {
  expect(dispatchConfigSchema.parse({}).tierTargets).toEqual(defaults);
  expect(dispatchConfigSchema.parse({ tierTargets: {} }).tierTargets).toEqual(defaults);
  expect(dispatchConfigSchema.parse({ tierTargets: { simple: "medium" } }).tierTargets)
    .toEqual({ ...defaults, simple: "medium" });
});

test("tier targets reject decreasing mappings with the specific error", () => {
  for (const tierTargets of [{ simple: "frontier" }, { standard: "frontier", complex: "medium" }]) {
    expect(() => dispatchConfigSchema.parse({ tierTargets }))
      .toThrow("dispatch.tierTargets must not decrease from simple to complex");
  }
});

test("tier targets accept equal tiers and reject invalid shapes, values and extra keys", () => {
  expect(dispatchConfigSchema.parse({ tierTargets: { simple: "medium", complex: "medium" } }).tierTargets)
    .toEqual({ simple: "medium", standard: "medium", complex: "medium" });
  for (const tierTargets of [null, [], "small", { simple: "unknown" }, { standard: 1 }, { extra: "small" }]) {
    expect(dispatchConfigSchema.safeParse({ tierTargets }).success).toBe(false);
  }
});

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
test.skipIf(!front)("native dispatch.config.get agrees with TS for tier target defaults, overrides and errors", async () => {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  for (const dispatch of [undefined, {}, { tierTargets: {} }, { tierTargets: { simple: "medium" } },
    { tierTargets: { simple: "frontier" } }, { tierTargets: { simple: "unknown" } }, { tierTargets: { extra: "small" } }]) {
    writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify({ planner: "codex", providers: { codex: {} }, dispatch }));
    const results = [];
    for (const forward of [false, true]) {
      const child = Bun.spawn([front!, "api", "--stdio"], {
        env: { HOME: ctx.home, PACER_HOME: ctx.pacerHome, PATH: process.env.PATH,
          PACER_CORE_ARGV: JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]),
          PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1",
          ...(forward ? { PACER_FORWARD_OPS: "dispatch.config.get" } : {}) },
        stdin: "pipe", stdout: "pipe", stderr: "pipe",
      });
      try {
        await child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } }) + "\n"
          + JSON.stringify({ jsonrpc: "2.0", id: 2, method: "dispatch.config.get", params: {} }) + "\n");
        await child.stdin.end();
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect(code, stderr).toBe(0);
        expect(stderr.includes("native dispatch.config.get 2"), stderr).toBe(!forward);
        results.push(JSON.parse(stdout.trim().split("\n")[1]!));
      } finally {
        if (child.exitCode === null) { child.kill(); await child.exited; }
      }
    }
    expect(results[0]).toEqual(results[1]);
    if (dispatchConfigSchema.safeParse(dispatch ?? {}).success) {
      expect(results[0].result.config.tierTargets).toEqual(dispatchConfigSchema.parse(dispatch ?? {}).tierTargets);
    } else expect(results[0].error).toBeDefined();
  }
}, 60_000);
