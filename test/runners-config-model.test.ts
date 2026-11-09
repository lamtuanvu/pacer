import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import * as runners from "../src/core/runners-config";
import { loadStrategy } from "../src/config/strategy";
import type { AvailableModels } from "../src/models/available";

// runner.set validates a string model against the account's provider listing
// (src/core/runners-config.ts): a served-provider miss is refused with close
// suggestions, an unverifiable model is saved with a warning, and model null
// clears without consulting any listing.

const OPENER = `planner: claude-code
accounts:
  claude: {kind: claude}
  codex: {kind: codex}
  cursor: {kind: cursor}
  acme: {kind: endpoint, source: opencode, provider: acme, usage: unmetered}
runners:
  codex: {}
  opencode#acme: {model: acme/a}
routing:
  - kinds: [docs]
    executors: [codex, opencode#acme]
  - default: [codex, opencode#acme]
`;

function runnerCtx() {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), OPENER);
  return ctx;
}

function seedListing(ctx: ReturnType<typeof fakeCtx>, listing: Partial<AvailableModels>) {
  const hash = createHash("sha256").update("opencode#acme").digest("hex");
  const dir = join(ctx.pacerHome, "cache", "available-models");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${hash}.json`), JSON.stringify({ runner: "opencode#acme", source: "opencode", models: null, fetchedAt: ctx.now - 60, ...listing }));
}

test("runner.set rejects a model the provider does not serve and names close ones", async () => {
  const ctx = runnerCtx();
  seedListing(ctx, { source: "opencode", models: [{ id: "acme/a" }, { id: "acme/b" }, { id: "acme/c" }] });
  await expect(runners.set(ctx, "opencode#acme", { model: "acme/nope" })).rejects.toThrow(
    expect.objectContaining({ code: "invalid_input", message: "acme/nope is not offered by acme", hint: expect.stringContaining("acme/b") }),
  );
});

test("runner.set saves an unverifiable model with a warning", async () => {
  const ctx = runnerCtx();
  seedListing(ctx, { source: "opencode", models: null, note: "opencode could not list models for acme" });
  const result = await runners.set(ctx, "opencode#acme", { model: "acme/b" });
  expect(result.warnings).toEqual(["acme/b could not be checked: opencode could not list models for acme"]);
  expect(loadStrategy(ctx).runners["opencode#acme"].model).toBe("acme/b");
});

test("runner.set saves a model against an empty listing with a could-not-check warning", async () => {
  const ctx = fakeCtx({run: async () => ({code: 0, stdout: "", stderr: ""})});
  mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), OPENER);
  const result = await runners.set(ctx, "opencode#acme", {model: "acme/b"});
  expect(result.warnings).toEqual(["acme/b could not be checked: opencode lists no models for acme; check opencode auth list"]);
  expect(loadStrategy(ctx).runners["opencode#acme"].model).toBe("acme/b");
});

test("runner.set refusal omits the hint when the listing offers nothing close", async () => {
  const ctx = runnerCtx();
  seedListing(ctx, {models: []});
  await expect(runners.set(ctx, "opencode#acme", {model: "acme/nope"})).rejects.toThrow(
    expect.objectContaining({code: "invalid_input", message: "acme/nope is not offered by acme", hint: undefined}),
  );
});

test("runner.set model null clears without a listing", async () => {
  const ctx = runnerCtx();
  const result = await runners.set(ctx, "codex", { model: null });
  expect(result.warnings).toEqual([]);
  expect(loadStrategy(ctx).runners.codex.model).toBeNull();
});