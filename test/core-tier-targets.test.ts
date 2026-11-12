import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readTierTargets, saveTierTargets } from "../src/core/tier-targets";
import { loadStrategy } from "../src/config/strategy";
import { callOp, OPS } from "../src/api/ops";
import { fakeCtx } from "./helpers";

const withFile = (body: string) => {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), body);
  return ctx;
};

const plainCtx = () => withFile(`# keep targets
planner: claude-code
accounts:
  claude: {kind: claude}
runners:
  claude-code: {}
`);

const savedCtx = () => withFile(`# keep targets
planner: claude-code
accounts:
  claude: {kind: claude}
runners:
  claude-code: {}
dispatch:
  engine: ladder
  tierTargets: {simple: small, standard: small, complex: medium}
`);

const BUILTIN = {simple: "small", standard: "medium", complex: "frontier"} as const;
const MEDIUM = {simple: "medium", standard: "medium", complex: "medium"} as const;

test("get returns built-in defaults when the setup saves none", () => {
  const ctx = plainCtx();
  expect(readTierTargets(ctx)).toEqual({revision: readTierTargets(ctx).revision, targets: {...BUILTIN}});
  expect(loadStrategy(ctx).dispatch).toBeUndefined();
});

test("get returns the saved targets and the current revision", () => {
  const ctx = savedCtx();
  const got = readTierTargets(ctx);
  expect(got.targets).toEqual({simple: "small", standard: "small", complex: "medium"});
  expect(got.revision).toMatch(/^[0-9a-f]{64}$/);
});

test("set saves targets in one edit and preserves comments and other dispatch keys", async () => {
  const ctx = savedCtx(), base = readTierTargets(ctx);
  const result = await saveTierTargets(ctx, {expectedRevision: base.revision, targets: {...MEDIUM}});
  expect(result.revision).not.toBe(base.revision);
  expect(result.targets).toEqual({...MEDIUM});
  expect(readTierTargets(ctx)).toEqual({revision: result.revision, targets: {...MEDIUM}});
  expect(loadStrategy(ctx).dispatch!.engine).toBe("ladder");
  const text = readFileSync(join(ctx.pacerHome, "strategy.yaml"), "utf8");
  expect(text).toContain("# keep targets");
  expect(text).toContain("tierTargets: { simple: medium, standard: medium, complex: medium }");
});

test("set refuses a stale revision and writes nothing", async () => {
  const ctx = savedCtx(), path = join(ctx.pacerHome, "strategy.yaml"), before = readFileSync(path, "utf8");
  await expect(saveTierTargets(ctx, {expectedRevision: "stale", targets: {...MEDIUM}})).rejects.toMatchObject({code: "conflict"});
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("set refuses a decreasing mapping as invalid_input and writes nothing", async () => {
  const ctx = savedCtx(), base = readTierTargets(ctx), path = join(ctx.pacerHome, "strategy.yaml"), before = readFileSync(path, "utf8");
  await expect(saveTierTargets(ctx, {expectedRevision: base.revision, targets: {simple: "frontier", standard: "medium", complex: "medium"}}))
    .rejects.toMatchObject({code: "invalid_input"});
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("set succeeds on the default strategy without a dispatch block, writing only dispatch.tierTargets", async () => {
  const ctx = plainCtx();
  const path = join(ctx.pacerHome, "strategy.yaml");
  const base = readTierTargets(ctx);
  const result = await saveTierTargets(ctx, {expectedRevision: base.revision, targets: {...MEDIUM}});
  expect(result.targets).toEqual({...MEDIUM});
  const text = readFileSync(path, "utf8");
  expect(text).toContain("dispatch:");
  expect(text).toContain("tierTargets:");
  expect(text).not.toContain("engine:");
  expect(text).not.toContain("steps:");
  expect(loadStrategy(ctx).dispatch!.tierTargets).toEqual({...MEDIUM});
  const got = await callOp(ctx, "dispatch.config.get", {});
  expect((got as {config: {tierTargets: unknown}}).config.tierTargets).toEqual({...MEDIUM});
});

test("set edits a named active strategy in place", async () => {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, {recursive: true});
  mkdirSync(join(ctx.pacerHome, "strategies"), {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategies", "work.yaml"), `# keep
planner: claude-code
accounts:
  claude: {kind: claude}
runners:
  claude-code: {}
dispatch:
  engine: ladder
  tierTargets: {simple: small, standard: small, complex: medium}
`);
  writeFileSync(join(ctx.pacerHome, "active"), "work\n");
  const base = readTierTargets(ctx);
  const path = join(ctx.pacerHome, "strategies", "work.yaml");
  const beforeDefault = existsSync(join(ctx.pacerHome, "strategy.yaml")) ? readFileSync(join(ctx.pacerHome, "strategy.yaml"), "utf8") : null;
  const result = await saveTierTargets(ctx, {expectedRevision: base.revision, targets: {...MEDIUM}});
  expect(result.targets).toEqual({...MEDIUM});
  const text = readFileSync(path, "utf8");
  expect(text).toContain("# keep");
  expect(text).toContain("engine: ladder");
  expect(loadStrategy(ctx).dispatch!.engine).toBe("ladder");
  if (beforeDefault !== null) expect(readFileSync(join(ctx.pacerHome, "strategy.yaml"), "utf8")).toBe(beforeDefault);
});

test("the ops are registered and validate through the registry", async () => {
  expect(Object.keys(OPS)).toContain("dispatch.tierTargets.get");
  expect(Object.keys(OPS)).toContain("dispatch.tierTargets.set");
  const ctx = savedCtx();
  const got = await callOp(ctx, "dispatch.tierTargets.get", {});
  expect(got).toMatchObject({targets: {simple: "small", standard: "small", complex: "medium"}});
  const set = await callOp(ctx, "dispatch.tierTargets.set", {expectedRevision: (got as {revision: string}).revision, targets: {...MEDIUM}});
  expect(set).toMatchObject({targets: {...MEDIUM}});
  await expect(callOp(ctx, "dispatch.tierTargets.set", {expectedRevision: (set as {revision: string}).revision, targets: {simple: "frontier", standard: "medium", complex: "medium"}}))
    .rejects.toMatchObject({code: "invalid_input"});
});
