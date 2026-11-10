import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { runDoctor } from "../src/install/doctor";
import { remedies } from "../src/install/doctor-remedy";
import type { AvailableModels } from "../src/models/available";
import type { Ctx } from "../src/types";

// doctor's executor-models report flags a default the provider stopped serving (with a
// one-click replacement) and an OpenCode account left without any executor, and stays
// quiet when a listing is unknown.

// A modern strategy: claude-code plus codex as executors, one opencode-backed account
// with its own runner, and (per fixture) an opencode account with no runner.
function doctorFixture(accounts: string[]): Ctx {
  const ctx = fakeCtx({ which: () => null });
  mkdirSync(ctx.pacerHome, { recursive: true });
  const accountsYaml = [
    "  claude: {kind: claude}",
    "  codex: {kind: codex}",
    ...accounts.map(a => `  ${a}: {kind: endpoint, source: opencode, provider: acme, usage: unmetered}`),
  ].join("\n");
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), `planner: claude-code
accounts:
${accountsYaml}
runners:
  codex: {}
  opencode#opencode: {model: acme/a}
routing:
  - default: [codex, opencode#opencode]
`);
  return ctx;
}

function listing(models: AvailableModels["models"] | null, source: AvailableModels["source"] = "opencode"): AvailableModels {
  return { runner: "opencode#opencode", source, models, fetchedAt: 0 };
}

function runDoctorWith(ctx: Ctx, perRunner: Record<string, AvailableModels>) {
  return runDoctor(ctx, {
    status: async () => ({
      generatedAt: 0, strategy: "default", planner: "claude-code", mode: "normal",
      disabled: false, paused: null, modeHold: null, calendarPace: true,
      executors: { ranked: [], excluded: [] }, providers: [],
    }) as any,
    service: async () => ({ installed: true, running: true, healthy: true, binaryMatches: true }) as any,
    availableModels: async (_ctx, runnerId) => perRunner[runnerId] ?? { runner: runnerId, source: "none", models: null, fetchedAt: 0 },
  });
}

test("doctor flags a default the provider stopped serving with a one-click replacement", async () => {
  const ctx = doctorFixture(["opencode"]);
  // opencode#opencode requests acme/a but the provider now only serves acme/b and acme/c.
  const checks = await runDoctorWith(ctx, { "opencode#opencode": listing([{ id: "acme/b" }, { id: "acme/c" }]) });
  const check = checks.find(c => c.name === "Model opencode#opencode");
  expect(check?.level).toBe("warn");
  expect(check?.detail).toBe("default model acme/a is no longer offered by acme; use acme/b");
  expect(check?.remedy).toEqual(remedies.replaceModel("opencode#opencode", "acme/b"));
});

test("doctor's drift detail names the provider and omits the use hint without a replacement", async () => {
  const ctx = doctorFixture(["opencode"]);
  const checks = await runDoctorWith(ctx, { "opencode#opencode": listing([]) });
  const check = checks.find(c => c.name === "Model opencode#opencode");
  expect(check?.level).toBe("warn");
  expect(check?.detail).toBe("default model acme/a is no longer offered by acme");
});

test("doctor emits no Model check when the listing is empty", async () => {
  const ctx = doctorFixture(["opencode"]);
  // An empty listing arrives as unknown (models null), the same as an unknown listing.
  const checks = await runDoctorWith(ctx, { "opencode#opencode": listing(null, "opencode") });
  expect(checks.some(c => c.name.startsWith("Model "))).toBe(false);
});

test("doctor flags an OpenCode account left without an executor", async () => {
  const ctx = doctorFixture(["opencode", "leftover"]);
  // Both opencode accounts request acme/a, which the provider still serves; only
  // `leftover` has no opencode runner, so only it should be flagged.
  const checks = await runDoctorWith(ctx, { "opencode#opencode": listing([{ id: "acme/a" }]) });
  const check = checks.find(c => c.name === "Account leftover");
  expect(check?.level).toBe("warn");
  expect(check?.remedy).toEqual(remedies.addExecutor("leftover"));
  expect(checks.some(c => c.name === "Account opencode")).toBe(false);
});

test("doctor stays quiet when listings are unknown", async () => {
  const ctx = doctorFixture(["opencode"]);
  const checks = await runDoctorWith(ctx, { "opencode#opencode": listing(null, "none") });
  expect(checks.some(c => c.name.startsWith("Model "))).toBe(false);
  expect(checks.some(c => c.name.startsWith("Account "))).toBe(false);
});