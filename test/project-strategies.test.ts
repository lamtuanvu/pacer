import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readProjectStrategies, writeProjectStrategy } from "../src/config/project-strategies";
import { fakeCtx } from "./helpers";

const key = "github.com/acme/api", refs = ["cursor#cursor@local", "codex#codex@local"];
test("project policies preserve order and use CAS revisions across removal and recreation", async () => {
  const ctx = fakeCtx();
  expect(readProjectStrategies(ctx)).toEqual({ version: 1, projects: {} });
  expect(await writeProjectStrategy(ctx, key, refs, 0)).toEqual({ rev: 1, executors: refs });
  await expect(writeProjectStrategy(ctx, key, [...refs].reverse(), 0)).rejects.toMatchObject({ code: "conflict" });
  expect(await writeProjectStrategy(ctx, key, null, 1)).toEqual({ rev: 2, executors: null });
  await expect(writeProjectStrategy(ctx, key, refs, 0)).rejects.toMatchObject({ code: "conflict" });
  expect((await writeProjectStrategy(ctx, key, refs, 2)).rev).toBe(3);
  expect(statSync(join(ctx.pacerHome, "project-strategies.json")).mode & 0o777).toBe(0o600);
});
test("concurrent same-project edits conflict; different projects retain both writes", async () => {
  const ctx = fakeCtx();
  const changes = await Promise.allSettled([writeProjectStrategy(ctx, key, refs, 0), writeProjectStrategy(ctx, key, [refs[1]], 0)]);
  expect(changes.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(changes.filter(r => r.status === "rejected")).toHaveLength(1);
  await Promise.all([writeProjectStrategy(ctx, "github.com/acme/b", refs, 0), writeProjectStrategy(ctx, "github.com/acme/c", refs, 0)]);
  expect(Object.keys(readProjectStrategies(ctx).projects)).toHaveLength(3);
});
test("corrupt or unsupported policy data never becomes an empty global policy", () => {
  const ctx = fakeCtx(); mkdirSync(ctx.pacerHome, { recursive: true });
  const path = join(ctx.pacerHome, "project-strategies.json");
  for (const value of ["{", '{"version":2,"projects":{}}', '{"version":1,"projects":{"x":{"rev":1,"executors":[]}}}', '{"version":1,"projects":null}']) {
    writeFileSync(path, value);
    expect(() => readProjectStrategies(ctx)).toThrow("project strategies");
    expect(readFileSync(path, "utf8")).toBe(value);
  }
});
test("invalid writes preserve the existing policy and read-only contexts cannot mutate", async () => {
  const ctx = fakeCtx(); await writeProjectStrategy(ctx, key, refs, 0);
  for (const values of [[], ["codex"], [refs[0], refs[0]]]) {
    await expect(writeProjectStrategy(ctx, key, values, 1)).rejects.toMatchObject({ code: "invalid_input" });
  }
  await expect(writeProjectStrategy({ ...ctx, readOnly: true }, key, null, 1)).rejects.toMatchObject({ code: "not_allowed" });
  expect(readProjectStrategies(ctx).projects[key]).toEqual({ rev: 1, executors: refs });
});
