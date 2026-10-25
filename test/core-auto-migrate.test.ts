import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { ensureAccounts } from "../src/core/accounts";
import * as migrations from "../src/config/migrate";
import { loadStrategy } from "../src/config/strategy";
import { executorCommand } from "../src/executors/command";
import { fakeCtx } from "./helpers";

const legacy = "# original\nplanner: claude-code\nproviders: {codex: {usage: quota}}\n";
function fixture(text = legacy) {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, {recursive: true});
  const path = join(ctx.pacerHome, "strategy.yaml");
  writeFileSync(path, text);
  return {ctx, path};
}
function backup(path: string) {
  expect(readFileSync(path + ".pre-accounts.bak", "utf8")).toBe(legacy);
}

test("runner.set migrates legacy settings, preserves its backup and edits max_tasks", async () => {
  const {ctx, path} = fixture();
  expect(await callOp(ctx, "runner.set", {id: "codex", max_tasks: 3})).toMatchObject({id: "codex", migrated: {backup: path + ".pre-accounts.bak"}});
  expect(loadStrategy(ctx).legacy).toBe(false);
  expect(loadStrategy(ctx).runners.codex.maxTasks).toBe(3);
  backup(path);
  expect(await callOp(ctx, "runner.set", {id: "codex", max_tasks: 2})).not.toHaveProperty("migrated");
  backup(path);
});

test("account.add migrates and reports its backup through the API", async () => {
  const {ctx, path} = fixture();
  expect(await callOp(ctx, "account.add", {kind: "codex", name: "work"})).toMatchObject({account: {name: "work"}, migrated: {backup: path + ".pre-accounts.bak"}});
  expect(loadStrategy(ctx).accounts.work.kind).toBe("codex");
  backup(path);
});

test("endpoint addition migrates legacy settings before saving the connection", async () => {
  const {ctx, path} = fixture();
  expect(await callOp(ctx, "account.add", {kind: "endpoint", name: "local", base_url: "http://localhost:1234/v1", key_source: "none", models: [{id: "model", context: 128000, output: 16000, tools: true}], usage: "unmetered", test: false})).toMatchObject({account: {name: "local"}, migrated: {backup: path + ".pre-accounts.bak"}});
  expect(loadStrategy(ctx).accounts.local.connection?.models[0].id).toBe("model");
  backup(path);
});

test("current settings edit without migration or backup", async () => {
  const {ctx, path} = fixture("planner: claude-code\naccounts: {claude: {kind: claude}, codex: {kind: codex}}\nrouting: [{default: [codex]}]\n");
  expect(await callOp(ctx, "runner.set", {id: "codex", max_tasks: 4})).toEqual({id: "codex", warnings: []});
  expect(existsSync(path + ".pre-accounts.bak")).toBe(false);
});

test("a change between loading and migration returns conflict without overwriting", async () => {
  const {ctx, path} = fixture(), changed = legacy + "# concurrent edit\n";
  const original = migrations.migrateStrategy;
  const spy = spyOn(migrations, "migrateStrategy").mockImplementation((path, expected) => {
    writeFileSync(path, changed);
    return original(path, expected);
  });
  try {
    await expect(callOp(ctx, "runner.set", {id: "codex", max_tasks: 3})).rejects.toMatchObject({code: "conflict"});
    expect(readFileSync(path, "utf8")).toBe(changed);
    expect(existsSync(path + ".pre-accounts.bak")).toBe(false);
  } finally { spy.mockRestore(); }
});

test("a change after migration returns conflict before the edit writes", () => {
  const {ctx, path} = fixture(), prepared = ensureAccounts(ctx);
  const changed = readFileSync(path, "utf8") + "# concurrent edit\n";
  writeFileSync(path, changed);
  expect(() => prepared.edit(doc => doc.setIn(["runners", "codex", "max_tasks"], 3))).toThrow(expect.objectContaining({code: "conflict"}));
  expect(readFileSync(path, "utf8")).toBe(changed);
});

test("unmigratable settings return invalid_input and preserve both files", async () => {
  const {ctx, path} = fixture();
  writeFileSync(path + ".pre-accounts.bak", "previous backup");
  await expect(callOp(ctx, "runner.set", {id: "codex", max_tasks: 3})).rejects.toMatchObject({code: "invalid_input", message: expect.not.stringContaining("pacer config migrate")});
  expect(readFileSync(path, "utf8")).toBe(legacy);
  expect(readFileSync(path + ".pre-accounts.bak", "utf8")).toBe("previous backup");
});

test("executor set prints the existing migration output once", async () => {
  const {ctx} = fixture();
  const result = await executorCommand(["set", "codex", "--max-tasks", "2"], ctx);
  expect(result.code).toBe(0);
  expect(result.out.match(/Backup:/g)).toHaveLength(1);
});

test("endpoint adoption edits an existing legacy provider and preserves the original", async () => {
  const text = legacy.replace("providers: {codex: {usage: quota}}", "providers: {codex: {usage: quota}, local: {via: opencode, model: external/model, usage: unmetered}}");
  const {ctx, path} = fixture(text);
  const folder = join(ctx.home, ".config", "opencode");
  mkdirSync(folder, {recursive: true});
  writeFileSync(join(folder, "opencode.json"), JSON.stringify({provider: {external: {options: {baseURL: "http://localhost:1234/v1"}, models: {model: {}}}}}));
  expect(await callOp(ctx, "account.adopt", {name: "local", key_source: "none"})).toMatchObject({account: {name: "local"}, migrated: {backup: path + ".pre-accounts.bak"}});
  expect(loadStrategy(ctx).accounts.local.connection?.base_url).toBe("http://localhost:1234/v1");
  expect(readFileSync(path + ".pre-accounts.bak", "utf8")).toBe(text);
});

test("a concurrent change during migration preserves the changed file and original backup", async () => {
  const { StrategyDoc } = await import("../src/config/edit");
  const {ctx, path} = fixture(), changed = legacy + "# changed during conversion\n";
  const original = StrategyDoc.prototype.toString;
  const spy = spyOn(StrategyDoc.prototype, "toString").mockImplementation(function(this: InstanceType<typeof StrategyDoc>) {
    writeFileSync(path, changed);
    return original.call(this);
  });
  try {
    await expect(callOp(ctx, "runner.set", {id: "codex", max_tasks: 3})).rejects.toMatchObject({code: "conflict"});
    expect(readFileSync(path, "utf8")).toBe(changed);
    backup(path);
  } finally { spy.mockRestore(); }
});

test("a concurrent change inside the edit returns conflict without a partial write", async () => {
  const {ctx, path} = fixture(), prepared = ensureAccounts(ctx);
  const changed = readFileSync(path, "utf8") + "# changed during edit\n";
  await expect(prepared.edit(doc => {
    doc.setIn(["runners", "codex", "max_tasks"], 3);
    writeFileSync(path, changed);
  })).rejects.toThrow(expect.objectContaining({code: "conflict"}));
  expect(readFileSync(path, "utf8")).toBe(changed);
});
