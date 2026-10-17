import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { toApiError } from "../src/api/protocol";
import { eventsSince } from "../src/api/events";
import { loadStrategy } from "../src/config/strategy";
import { fakeCtx } from "./helpers";

function configured() {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), '# keep layout\naccounts:\n  personal: {kind: claude}\n  codex: {kind: codex}\nplanner: claude-code\nrouting:\n  - default: [codex] # keep rule\npacing: {order: [codex], policy: priority}\n');
  return ctx;
}
async function error(p: Promise<unknown>) {
  try { await p; throw Error("expected failure"); } catch (e) { return toApiError(e); }
}

test("account and runner operations share configuration and publish matching events", async () => {
  const ctx = configured();
  const added = await callOp(ctx, "account.add", {kind: "codex", name: "work"}) as {account: {folder: string; signin_command: string}};
  expect(added.account).toMatchObject({name: "work", kind: "codex", folder: join(ctx.home, ".codex-work"), signin_command: expect.stringContaining("codex login")});
  expect(statSync(added.account.folder).mode & 0o777).toBe(0o700);
  expect(await callOp(ctx, "account.list", {})).toEqual(expect.arrayContaining([added.account]));
  expect(await callOp(ctx, "runner.add", {agent: "codex", account: "work"})).toMatchObject({id: "codex#work", job: {kind: "runner.check", state: "failed"}});
  expect((await error(callOp(ctx, "account.remove", {name: "work"}))).code).toBe("conflict");
  expect(await callOp(ctx, "runner.remove", {id: "codex#work"})).toEqual({removed: true});
  expect(await callOp(ctx, "account.remove", {name: "work", delete_home: true})).toEqual({removed: true});
  expect(existsSync(added.account.folder)).toBe(false);
  expect(eventsSince(ctx, 0).events.filter(e => e.type === "config").map(e => e.data)).toEqual(["accounts", "runners", "runners", "accounts"].map(area => ({area, at: ctx.now})));
});

test("claude accounts support explicit homes and never launch login", async () => {
  const ctx = configured(), home = join(ctx.home, "claude work");
  ctx.run = async () => { throw Error("must not spawn login"); };
  expect(await callOp(ctx, "account.add", {kind: "claude", name: "team", home})).toMatchObject({account: {folder: home, signin_command: expect.stringContaining("/login")}});
  await callOp(ctx, "account.remove", {name: "team"});
  expect(existsSync(home)).toBe(true);
});

test("bad names and in-use planner accounts refuse without writes or events", async () => {
  const ctx = configured(), path = join(ctx.pacerHome, "strategy.yaml"), before = readFileSync(path, "utf8");
  expect((await error(callOp(ctx, "account.add", {kind: "codex", name: "Bad/Name"}))).code).toBe("invalid_input");
  expect((await error(callOp(ctx, "account.remove", {name: "personal"}))).code).toBe("conflict");
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(eventsSince(ctx, 0).events).toEqual([]);
});

test("routing get and set validate references and order, preserve comments and publish once", async () => {
  const ctx = configured(), path = join(ctx.pacerHome, "strategy.yaml");
  expect(await callOp(ctx, "routing.get", {})).toEqual({rules: [{executors: ["codex"]}], available: expect.arrayContaining(["claude-code", "codex"])});
  for (const rules of [[{executors: ["invented"]}], [{executors: ["codex"]}, {kinds: ["debug"], executors: ["codex"]}], [{kinds: ["bad-kind"], executors: ["codex"]}, {executors: ["codex"]}]]) {
    const before = readFileSync(path, "utf8");
    expect((await error(callOp(ctx, "routing.set", {rules}))).code).toBe("invalid_input");
    expect(readFileSync(path, "utf8")).toBe(before);
  }
  expect(eventsSince(ctx, 0).events).toEqual([]);
  expect(await callOp(ctx, "routing.set", {rules: [{executors: ["codex", "claude-code"]}]})).toMatchObject({diff: expect.stringContaining("claude-code")});
  expect(readFileSync(path, "utf8")).toContain("# keep layout");
  expect(readFileSync(path, "utf8")).toContain("# keep rule");
  expect(loadStrategy(ctx).routing[0].executors).toEqual(["codex", "claude-code"]);
  expect(eventsSince(ctx, 0).events.filter(e => e.type === "config").map(e => e.data)).toEqual([{area: "routing", at: ctx.now}]);
});

test("account list never leaks email-shaped Orca identity or folder values", async () => {
  const ctx = configured(), path = join(ctx.pacerHome, "strategy.yaml"), root = join(ctx.home, "orca");
  ctx.env.ORCA_USER_DATA_PATH = root;
  mkdirSync(join(root, "codex-accounts", "private@example.invalid", "home"), {recursive: true});
  writeFileSync(path, readFileSync(path, "utf8").replace("  codex:", "  team: {kind: codex, orca_account: private@example.invalid}\n  codex:"));
  ctx.run = async () => ({code: 0, stderr: "", stdout: JSON.stringify({codex: {accounts: [{id: "private@example.invalid", label: "private@example.invalid"}]}, rateLimits: {}})});
  expect(JSON.stringify(await callOp(ctx, "account.list", {}))).not.toContain("@");
});

test("host operations reserve local and refuse removing a used alias", async () => {
  const ctx = configured();
  expect((await error(callOp(ctx, "host.add", {alias: "local", ssh: "box"}))).code).toBe("invalid_input");
  expect(await callOp(ctx, "host.add", {alias: "box", ssh: "box-ssh"})).toEqual({alias: "box"});
  expect(await callOp(ctx, "runner.add", {agent: "codex", host: "box"})).toMatchObject({id: "codex@box", job: {kind: "runner.check", state: "failed"}});
  expect((await error(callOp(ctx, "host.remove", {alias: "box"}))).code).toBe("conflict");
  await callOp(ctx, "runner.remove", {id: "codex@box"});
  expect(await callOp(ctx, "host.remove", {alias: "box"})).toEqual({removed: true});
  expect(eventsSince(ctx, 0).events.filter(e => e.type === "config").map(e => (e.data as {area: string}).area)).toEqual(["hosts", "runners", "runners", "hosts"]);
});

test("account list preserves remote runner ids while sanitizing emails", async () => {
  const ctx = configured();
  await callOp(ctx, "host.add", {alias: "box", ssh: "box-ssh"});
  await callOp(ctx, "runner.add", {agent: "codex", host: "box"});
  expect(await callOp(ctx, "account.list", {})).toEqual(expect.arrayContaining([expect.objectContaining({name: "codex", runners: ["codex", "codex@box"]})]));
});

test("account list orders inferred local runners before declared remote runners", async () => {
  const ctx = configured();
  await callOp(ctx, "host.add", {alias: "box", ssh: "box-ssh"});
  await callOp(ctx, "runner.add", {agent: "codex", host: "box", test: false});
  expect(await callOp(ctx, "account.list", {})).toEqual(expect.arrayContaining([expect.objectContaining({name: "codex", runners: ["codex", "codex@box"]})]));
});

test("routing changes preserve nested list comments when adding and removing rules", async () => {
  const ctx = configured(), path = join(ctx.pacerHome, "strategy.yaml");
  writeFileSync(path, readFileSync(path, "utf8").replace("  - default: [codex] # keep rule", "  - kinds: [debug] # kinds comment\n    executors: [codex] # executors comment\n  - default: [codex] # default comment"));
  await callOp(ctx, "routing.set", {rules: [{kinds: ["debug"], executors: ["claude-code"]}, {kinds: ["tests"], executors: ["codex"]}, {executors: ["codex"]}]});
  expect(readFileSync(path, "utf8")).toContain("# kinds comment");
  expect(readFileSync(path, "utf8")).toContain("# executors comment");
  expect(readFileSync(path, "utf8")).toContain("# default comment");
  await callOp(ctx, "routing.set", {rules: [{kinds: ["debug"], executors: ["codex"]}, {executors: ["claude-code"]}]});
  expect(loadStrategy(ctx).routing).toEqual([{kinds: ["debug"], executors: ["codex"]}, {kinds: null, executors: ["claude-code"]}]);
});

test("account API adds sign-in guidance without changing CLI JSON fields", async () => {
  const {accountCmd} = await import("../src/commands/accounts");
  const ctx = configured();
  const rows = JSON.parse((await accountCmd(["list", "--json"], ctx)).out);
  expect(rows.some((row: object) => Object.hasOwn(row, "signin_command"))).toBe(false);
});
