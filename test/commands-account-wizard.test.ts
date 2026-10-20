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
// Rejects the OpenCode-picker's catalog and local-probe lookups (models.dev, 127.0.0.1:11434/1234) so the
// picker always offers only "Enter a URL yourself", keeping these endpoint-wizard scripts deterministic.
const listed = async (url: string) => /models\.dev|127\.0\.0\.1:(11434|1234)/.test(url) ? Promise.reject(Error("blocked in tests")) : Response.json({data: [{id: "model-a", context_length: 262144, max_output_tokens: 32768}]});
function script(answers: string[], overrides: AccountDeps = {}) {
  const questions: string[] = [], printed: string[] = [];
  const deps: AccountDeps = {
    prompt: async q => { questions.push(q); if (!answers.length) throw Error(`unexpected prompt: ${q}`); return answers.shift()!; },
    promptSecret: async () => secret, print: line => { printed.push(line); }, fetch: listed, ...overrides,
  };
  return {deps, questions, printed};
}

test("wizard re-asks an invalid weekly token budget and treats a blank answer as no cap", async () => {
  const ctx = setup();
  const s = script(["3", "1", "work", "http://test.invalid/v1", "", "1", "metered", "nope", "50M", "n"]);
  const result = await accountCmd(["add"], ctx, s.deps);
  expect(result.err).toBe(""); expect(result.code).toBe(0);
  const printed = s.printed.join("\n");
  expect(printed).not.toContain("model limits");
  expect(printed).toContain("weekly token budget");
  expect(s.questions.filter(q => q.startsWith("Weekly token budget"))).toHaveLength(2);
  expect(loadStrategy(ctx).accounts.work.weeklyTokens).toBe(50e6);
});

test("wizard treats a blank weekly token budget as no cap when there is no current one", async () => {
  const ctx = setup();
  const s = script(["3", "1", "work", "http://test.invalid/v1", "", "1", "metered", "", "n"]);
  const result = await accountCmd(["add"], ctx, s.deps);
  expect(result.err).toBe(""); expect(result.code).toBe(0);
  expect(loadStrategy(ctx).accounts.work.weeklyTokens).toBeNull();
});

test("wizard treats a blank quota source as arkcli and re-asks an invalid one", async () => {
  const ctx = setup();
  const blank = script(["3", "1", "work", "http://test.invalid/v1", "", "1", "quota", "", "n"]);
  const result = await accountCmd(["add"], ctx, blank.deps);
  expect(result.err).toBe(""); expect(result.code).toBe(0);
  expect(loadStrategy(ctx).accounts.work.quotaSource).toBe("arkcli");
  const other = setup();
  const invalid = script(["3", "1", "work", "http://test.invalid/v1", "", "1", "quota", "other", "arkcli", "n"]);
  expect((await accountCmd(["add"], other, invalid.deps)).code).toBe(0);
  expect(invalid.printed.join("\n")).toContain("Quota source must be arkcli");
  expect(loadStrategy(other).accounts.work.quotaSource).toBe("arkcli");
});

test("wizard warns without blocking when arkcli is not installed", async () => {
  const ctx = setup(); ctx.which = () => null;
  const s = script(["3", "1", "work", "http://test.invalid/v1", "", "1", "quota", "", "n"]);
  expect((await accountCmd(["add"], ctx, s.deps)).code).toBe(0);
  expect(s.printed.join("\n")).toContain("arkcli is not on PATH");
});

test("wizard re-asks an invalid usage instead of aborting", async () => {
  const ctx = setup();
  const s = script(["3", "1", "work", "http://test.invalid/v1", "", "1", "bogus", "unmetered", "n"]);
  const result = await accountCmd(["add"], ctx, s.deps);
  expect(result.err).toBe(""); expect(result.code).toBe(0);
  expect(s.printed.join("\n")).toContain("Usage must be quota, metered or unmetered");
  expect(loadStrategy(ctx).accounts.work.usage).toBe("unmetered");
});

test("interactive add re-asks an invalid kind or an invalid or taken account name", async () => {
  const ctx = setup();
  const s = script(["9", "3", "1", "Bad/Name", "codex", "work", "http://test.invalid/v1", "", "1", "unmetered", "n"]);
  const result = await accountCmd(["add"], ctx, s.deps);
  expect(result.err).toBe(""); expect(result.code).toBe(0);
  expect(s.questions.filter(q => q.startsWith("What do you want to add"))).toHaveLength(2);
  expect(s.questions.filter(q => q.startsWith("Name"))).toHaveLength(3);
  expect(loadStrategy(ctx).accounts.work.connection).toBeDefined();
});

test("interactive endpoint add asks for key storage and honors file and env choices", async () => {
  const ctx = setup();
  const s = script(["3", "1", "work", "http://test.invalid/v1", "vault", "file", "1", "unmetered", "n"]);
  const result = await accountCmd(["add"], ctx, s.deps);
  expect(result.err).toBe(""); expect(result.code).toBe(0);
  const storage = s.questions.filter(q => q.startsWith("Key storage"));
  expect(storage).toHaveLength(2);
  expect(storage[0]).toContain(process.platform === "darwin" ? "[keychain]" : "[file]");
  expect(s.printed.join("\n")).toContain("Key storage must be");
  expect(loadStrategy(ctx).accounts.work.connection!.key).toBe("file");
  expect(readFileSync(join(ctx.pacerHome, "secrets/work.key"), "utf8")).toBe(secret);

  const env = setup(); env.env.WORK_TOKEN = secret; let hidden = 0;
  const e = script(["3", "1", "work", "http://test.invalid/v1", "env:WORK_TOKEN", "1", "unmetered", "n"], {promptSecret: async () => { hidden++; return secret; }});
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
  const s = script(["3", "1", "work", "http://test.invalid/v1", "", "1", "unmetered", "n"], {print: undefined});
  calls.length = 0;
  console.log = (...args: unknown[]) => { calls.push(args); };
  try { await accountCmd(["add"], wizard, s.deps); }
  finally { console.log = original; }
  expect(calls.some(call => String(call[0]).startsWith("Backup:"))).toBe(true);
  for (const call of calls) expect(call).toHaveLength(1);
});

// Discovered models whose names are blank pass the wizard's questions and fail only at save.
// Only the entered URL answers, so the provider picker finds no local servers.
const blankNames = async (input: string | URL | Request) => {
  if (!String(input instanceof Request ? input.url : input).startsWith("http://localhost/")) throw new Error("connection refused");
  return Response.json({data: [
    {id: "model-a", display_name: " ", context_length: 128000, max_output_tokens: 16000},
    {id: "model-b", display_name: "  ", context_length: 128000, max_output_tokens: 16000},
  ]});
};

test("interactive endpoint save shows every line of a validation error", async () => {
  const ctx = setup();
  const s = script(["3", "1", "work", "http://localhost/v1", "none", "1,2", "unmetered", "n"], {fetch: blankNames});
  const result = await accountCmd(["add"], ctx, s.deps);
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("invalid strategy");
  expect(result.err).toContain("models.0.name must be non-empty");
  expect(result.err).toContain("models.1.name must be non-empty");
});

test("endpoint API operations return every line of a validation error", async () => {
  const ctx = setup();
  const {callOp} = await import("../src/api/ops");
  const models = [{id: "model-a", name: " ", context: 128000, output: 16000, tools: true}, {id: "model-b", name: "  ", context: 128000, output: 16000, tools: true}];
  const error = await callOp(ctx, "account.add", {kind: "endpoint", name: "work", base_url: "http://localhost/v1", key_source: "none", models, usage: "unmetered", test: false}).then(() => null, (e: Error) => e);
  expect(error?.message).toContain("models.0.name must be non-empty");
  expect(error?.message).toContain("models.1.name must be non-empty");
});

// Embedding, image and speech models cannot run an executor, so the URL path hides them as the picker does.
const mixed = async (url: string) => /models\.dev|127\.0\.0\.1:(11434|1234)/.test(url) ? Promise.reject(Error("blocked in tests")) : Response.json({data: [
  {id: "nomic-embed-text:latest", context_length: 8192, max_output_tokens: 8192},
  {id: "qwen3-coder", context_length: 262144, max_output_tokens: 32768},
]});
const embeddingsOnly = async (url: string) => /models\.dev|127\.0\.0\.1:(11434|1234)/.test(url) ? Promise.reject(Error("blocked in tests")) : Response.json({data: [
  {id: "nomic-embed-text:latest", context_length: 8192, max_output_tokens: 8192},
]});

test("the URL path hides models that cannot run an executor and says so", async () => {
  const ctx = setup();
  const s = script(["3", "1", "work", "http://test.invalid/v1", "none", "1", "unmetered", "n"], {fetch: mixed as never});
  expect((await accountCmd(["add"], ctx, s.deps)).code).toBe(0);
  expect(s.printed).toContain("1. qwen3-coder · 262144 context");
  expect(s.printed.some(l => l.includes("nomic-embed-text"))).toBe(false);
  expect(s.printed).toContain("Hid 1 model that cannot run an executor (embeddings, images or speech).");
  expect(loadStrategy(ctx).runners["opencode#work"].model).toBe("pacer-work/qwen3-coder");
});

test("when every listed model is hidden, the URL path asks for model ids", async () => {
  const ctx = setup();
  const s = script(["3", "1", "work", "http://test.invalid/v1", "none", "my-model", "", "", "unmetered", "n"], {fetch: embeddingsOnly as never});
  expect((await accountCmd(["add"], ctx, s.deps)).code).toBe(0);
  expect(s.printed).toContain("None of this endpoint's models can run an executor. Enter model ids.");
  expect(s.questions).toContain("Model ids (comma separated)");
});
