import { expect, test } from "bun:test";
import * as ids from "../src/config/runner-id";
import { validateStrategy } from "../src/config/strategy";
import { delegate, validateInput } from "../src/tasks/api";
import { fakeCtx } from "./helpers";
const parse = (raw: unknown) => validateStrategy(raw, "strategy.yaml");
const base = { accounts: { plan: {kind: "claude"}, personal: {kind: "codex"}, work: {kind: "codex", home: "~/.codex-work"}, byteplus: {kind: "endpoint", usage: "unmetered", model: "api/model"}}, planner: "claude-code", routing: [{default: ["codex", "codex#work", "byteplus"]}], pacing: {order: ["byteplus", "codex"]} };
test("runner grammar parses optional account and host and rejects malformed parts", () => {
  for (const [id, agent, account, host] of [["codex", "codex", null, null], ["claude-code#work", "claude-code", "work", null], ["opencode#api@desktop", "opencode", "api", "desktop"], ["codex@desktop", "codex", null, "desktop"]] as const) expect(ids.parseRunnerId(id!)).toEqual({agent, account, host});
  for (const id of ["", "unknown", "Codex", "codex#", "codex@", "codex##work", "codex@host#work", "codex#work_name", "codex#-work", "codex#work@host@two", " codex"]) expect(ids.parseRunnerId(id)).toBeNull();
});
test("format omits default accounts and local host", () => {
  expect(ids.formatRunnerId({agent: "codex", account: "personal", host: null}, {codex: "personal"})).toBe("codex");
  expect(ids.formatRunnerId({agent: "codex", account: "work", host: "desktop"}, {codex: "personal"})).toBe("codex#work@desktop");
});
test("referenced runners resolve defaults, models and provider aliases", () => {
  const s = parse(base);
  expect(Object.keys(s.runners)).toEqual(["claude-code", "codex", "codex#work", "opencode#byteplus"]);
  expect(s.runners.codex.account).toBe("personal");
  expect(ids.resolveRunner(s, "byteplus")).toMatchObject({id: "opencode#byteplus", host: null, model: "api/model"});
  expect(s.routing[0].executors).toEqual(["codex", "codex#work", "opencode#byteplus"]);
  expect(s.pacing.order).toEqual(["opencode#byteplus", "codex"]);
  expect(ids.resolveRunner(s, "codex#personal")?.id).toBe("codex");
  expect(ids.resolveRunner(s, "missing")).toBeNull();
});
test("runner overrides account model and unquoted YAML ids round trip", () => {
  const raw = {...base, runners: {"opencode#byteplus": {model: "api/override"}}};
  const yaml = Bun.YAML.stringify(raw);
  expect(parse(Bun.YAML.parse(yaml)).runners["opencode#byteplus"].model).toBe("api/override");
  expect(parse(Bun.YAML.parse("accounts: {plan: {kind: claude}, byteplus: {kind: endpoint, usage: unmetered, model: api/model}}\nplanner: claude-code\nrouting: [{default: [opencode#byteplus]}]\n")).runners["opencode#byteplus"].id).toBe("opencode#byteplus");
});
test("remote runners and ambiguous or missing defaults are refused", () => {
  expect(() => parse({...base, routing: [{default: ["codex#work@desktop"]}]})).toThrow("unknown host desktop");
  expect(() => parse({...base, accounts: {...base.accounts, duplicate: {kind: "codex"}}})).toThrow("default");
  expect(() => parse({...base, accounts: {...base.accounts, personal: {kind: "codex", home: "~/.personal"}}})).toThrow("default");
});
test("executor aliases are validated and stored as canonical runner ids", () => {
  const s = parse(base); const ctx = fakeCtx();
  const input = {brief: {goal: "do work", repo: ctx.home}, executor: "byteplus"};
  expect(validateInput(s, input)).toEqual([]);
  expect(delegate(ctx, input, () => undefined, s).requestedExecutor).toBe("opencode#byteplus");
  expect(validateInput(s, {...input, executor: "claude-code#plan"}).join(";")).toContain("planner");
});
test("planner uses a declared runner model override", () => {
  const s = parse({accounts: {api: {kind: "endpoint", usage: "unmetered"}}, planner: "opencode#api", runners: {"opencode#api": {model: "api/override"}}, routing: [{default: ["opencode#api"]}]});
  expect(s.runners["opencode#api"].model).toBe("api/override");
});
test("explicit runner declarations cannot conceal a remote host or conflicting identity", () => {
  expect(() => parse({...base, runners: {"codex#work@desktop": {agent: "codex", account: "work"}}})).toThrow("unknown host desktop");
  expect(() => parse({...base, runners: {"codex#work": {agent: "claude-code", account: "plan"}}})).toThrow("identity");
});
test("canonical native ids retain their direct and Orca agent launchers", async () => {
  const {launchFor} = await import("../src/exec/launch");
  const {orcaAgentFor} = await import("../src/exec/orca/agents");
  const s = parse(base);
  expect(launchFor(s.providers["codex#work"], "task", "/repo", "/tasks", "t").argv[0]).toBe("codex");
  expect(orcaAgentFor(s.providers["codex#work"], "current")).toEqual({agent: "codex", model: null});
});
test("legacy classifier tier aliases follow canonical runners", async () => {
  const {classifierConfig} = await import("../src/config/classifier");
  const s = parse({...base, classifier: {tiers: {byteplus: "capable"}}});
  expect(classifierConfig(s).tiers["opencode#byteplus"]).toBe("capable");
});
test("legacy blocked executor aliases still constrain canonical runners", async () => {
  const {blockExecutor} = await import("../src/executors/blocked");
  const {computeStatus} = await import("../src/engine/status");
  const ctx = fakeCtx(); const s = parse(base);
  blockExecutor(ctx, "byteplus", undefined, "paused");
  expect((await computeStatus(ctx, s, {profile: null})).executors.excluded).toContainEqual(expect.objectContaining({id: "opencode#byteplus", account: "byteplus", reason: "Blocked by you"}));
  expect(() => delegate(ctx, {brief: {goal: "work", repo: ctx.home}, executor: "byteplus"}, () => undefined, s)).toThrow("Blocked by you");
});
test("canonical identities reject conflicting model declarations", () => {
  expect(() => parse({...base, runners: {"opencode#byteplus": {model: "api/one"}, byteplus: {agent: "opencode", account: "byteplus", model: "api/two"}}})).toThrow("conflicting");
});
test("referenced accounts and pacing-only ids obey grammar and agent pairings", () => {
  expect(() => parse({...base, accounts: {...base.accounts, bad_name: {kind: "endpoint", usage: "unmetered", model: "api/model"}}, routing: [{default: ["bad_name"]}], pacing: {order: []}})).toThrow("invalid runner id");
  expect(() => parse({...base, pacing: {order: ["codex#byteplus"]}})).toThrow("cannot use");
});
