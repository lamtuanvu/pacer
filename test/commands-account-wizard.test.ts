// Regression tests for interactive account/endpoint wizard defects found in live validation.
import {expect, test} from "bun:test";
import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {accountCmd, type AccountDeps} from "../src/commands/accounts";
import {loadStrategy} from "../src/config/strategy";
import * as endpointState from "../src/endpoints/state";
import {fakeCtx} from "./helpers";

const secret = "sk-endpoint-wizard-private-value";
function setup() {
  let stored: string | null = null;
  const ctx = fakeCtx({run: async (argv, _timeout, options) => {
    if (argv[0] !== "security") return {code: 127, stdout: "", stderr: ""};
    if (argv[1] === "-i") stored = Buffer.from(options!.stdin!.match(/-X ([0-9a-f]+)/)![1], "hex").toString();
    return {code: argv[1] === "find-generic-password" && !stored ? 44 : 0, stdout: argv.includes("-w") ? stored ?? "" : "", stderr: ""};
  }});
  ctx.env = {HOME: ctx.home, PACER_HOME: ctx.pacerHome, PATH: process.env.PATH};
  mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "accounts:\n  personal: {kind: claude}\n  codex: {kind: codex}\nplanner: claude-code\nrouting:\n  - default: [codex]\n");
  return ctx;
}
const listed = async () => Response.json({data: [{id: "model-a", context_length: 262144, max_output_tokens: 32768}]});
function script(answers: string[], overrides: AccountDeps = {}) {
  const questions: string[] = [], printed: string[] = [];
  const deps: AccountDeps = {
    prompt: async q => { questions.push(q); if (!answers.length) throw Error(`unexpected prompt: ${q}`); return answers.shift()!; },
    promptSecret: async () => secret, print: line => { printed.push(line); }, fetch: listed, ...overrides,
  };
  return {deps, questions, printed};
}

test("wizard re-asks a blank or invalid weekly token budget and keeps prior answers", async () => {
  const ctx = setup();
  const s = script(["3", "work", "http://test.invalid/v1", "", "1", "metered", "", "nope", "50M", "n"]);
  const result = await accountCmd(["add"], ctx, s.deps);
  expect(result.err).toBe(""); expect(result.code).toBe(0);
  const printed = s.printed.join("\n");
  expect(printed).not.toContain("model limits");
  expect(printed).toContain("weekly token budget");
  expect(s.questions.filter(q => q.startsWith("Weekly token budget"))).toHaveLength(3);
  expect(loadStrategy(ctx).accounts.work.weeklyTokens).toBe(50e6);
});

test("wizard treats a blank quota source as arkcli and re-asks an invalid one", async () => {
  const ctx = setup();
  const blank = script(["3", "work", "http://test.invalid/v1", "", "1", "quota", "", "n"]);
  const result = await accountCmd(["add"], ctx, blank.deps);
  expect(result.err).toBe(""); expect(result.code).toBe(0);
  expect(loadStrategy(ctx).accounts.work.quotaSource).toBe("arkcli");
  const other = setup();
  const invalid = script(["3", "work", "http://test.invalid/v1", "", "1", "quota", "other", "arkcli", "n"]);
  expect((await accountCmd(["add"], other, invalid.deps)).code).toBe(0);
  expect(invalid.printed.join("\n")).toContain("Quota source must be arkcli");
  expect(loadStrategy(other).accounts.work.quotaSource).toBe("arkcli");
});

test("wizard warns without blocking when arkcli is not installed", async () => {
  const ctx = setup(); ctx.which = () => null;
  const s = script(["3", "work", "http://test.invalid/v1", "", "1", "quota", "", "n"]);
  expect((await accountCmd(["add"], ctx, s.deps)).code).toBe(0);
  expect(s.printed.join("\n")).toContain("arkcli is not on PATH");
});

test("wizard re-asks an invalid usage instead of aborting", async () => {
  const ctx = setup();
  const s = script(["3", "work", "http://test.invalid/v1", "", "1", "bogus", "unmetered", "n"]);
  const result = await accountCmd(["add"], ctx, s.deps);
  expect(result.err).toBe(""); expect(result.code).toBe(0);
  expect(s.printed.join("\n")).toContain("Usage must be quota, metered or unmetered");
  expect(loadStrategy(ctx).accounts.work.usage).toBe("unmetered");
});

test("interactive add re-asks an invalid kind or an invalid or taken account name", async () => {
  const ctx = setup();
  const s = script(["9", "3", "Bad/Name", "codex", "work", "http://test.invalid/v1", "", "1", "unmetered", "n"]);
  const result = await accountCmd(["add"], ctx, s.deps);
  expect(result.err).toBe(""); expect(result.code).toBe(0);
  expect(s.questions.filter(q => q.startsWith("What do you want to add"))).toHaveLength(2);
  expect(s.questions.filter(q => q.startsWith("Name"))).toHaveLength(3);
  expect(loadStrategy(ctx).accounts.work.connection).toBeDefined();
});

test("interactive endpoint add asks for key storage and honors file and env choices", async () => {
  const ctx = setup();
  const s = script(["3", "work", "http://test.invalid/v1", "vault", "file", "1", "unmetered", "n"]);
  const result = await accountCmd(["add"], ctx, s.deps);
  expect(result.err).toBe(""); expect(result.code).toBe(0);
  const storage = s.questions.filter(q => q.startsWith("Key storage"));
  expect(storage).toHaveLength(2);
  expect(storage[0]).toContain(process.platform === "darwin" ? "[keychain]" : "[file]");
  expect(s.printed.join("\n")).toContain("Key storage must be");
  expect(loadStrategy(ctx).accounts.work.connection!.key).toBe("file");
  expect(readFileSync(join(ctx.pacerHome, "secrets/work.key"), "utf8")).toBe(secret);

  const env = setup(); env.env.WORK_TOKEN = secret; let hidden = 0;
  const e = script(["3", "work", "http://test.invalid/v1", "env:WORK_TOKEN", "1", "unmetered", "n"], {promptSecret: async () => { hidden++; return secret; }});
  expect((await accountCmd(["add"], env, e.deps)).code).toBe(0);
  expect(hidden).toBe(0); expect(loadStrategy(env).accounts.work.connection!.key).toBe("env:WORK_TOKEN");
});

test("endpoint validation errors keep their full multi-line reason", async () => {
  const ctx = setup();
  const result = await accountCmd(["add", "endpoint", "work", "--base-url", "http://localhost/v1", "--key", "none", "--models", "m", "--usage", "quota", "--quota-source", "other", "--no-test"], ctx);
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("quota_source");
});

test("redactEndpointMessage keeps every line while redacting secrets", () => {
  const {redactEndpointError, redactEndpointMessage} = endpointState as typeof endpointState & {redactEndpointMessage: (text: string, secrets?: string[]) => string};
  const text = `invalid strategy /tmp/s.yaml:\n  - account work: quota usage needs quota_source: arkcli\n  - Authorization: Bearer ${secret}`;
  const full = redactEndpointMessage(text, [secret]);
  expect(full).toContain("quota_source: arkcli"); expect(full).not.toContain(secret);
  expect(redactEndpointError(text, [secret])).toBe("invalid strategy /tmp/s.yaml:");
});

test("migration notices print one line per console.log call", async () => {
  const calls: unknown[][] = []; const original = console.log;
  const legacy = "planner: claude-code\nproviders: {codex: {}}\n";
  const ctx = setup(); writeFileSync(join(ctx.pacerHome, "strategy.yaml"), legacy);
  console.log = (...args: unknown[]) => { calls.push(args); };
  try { expect((await accountCmd(["add", "claude", "work", "--no-login"], ctx)).code).toBe(0); }
  finally { console.log = original; }
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) expect(call).toHaveLength(1);

  const wizard = setup(); writeFileSync(join(wizard.pacerHome, "strategy.yaml"), legacy);
  const s = script(["3", "work", "http://test.invalid/v1", "", "1", "unmetered", "n"], {print: undefined});
  calls.length = 0;
  console.log = (...args: unknown[]) => { calls.push(args); };
  try { await accountCmd(["add"], wizard, s.deps); }
  finally { console.log = original; }
  expect(calls.some(call => String(call[0]).startsWith("Backup:"))).toBe(true);
  for (const call of calls) expect(call).toHaveLength(1);
});
