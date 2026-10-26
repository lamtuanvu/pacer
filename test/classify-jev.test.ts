import { createHttp } from "../packages/plugin-sdk/src/http";
import { createCallAuthority, type CallAuthority } from "../src/plugins/authority";
import { prepareHttpAuthority } from "../src/plugins/http-authority";
import { answerCapability } from "../src/plugins/host";
import { manifestSchema } from "../src/plugins/protocol";
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jevClassifier, jevRequest, mapJevAnswer } from "../plugins/pacer-classify/jev";
import { readSecrets, secret } from "../src/classify/secrets";
import type { Question } from "../src/classify/types";
import { fakeCtx } from "./helpers";


// Real SDK HTTP transport over the host capability broker; only owned loopback fixtures.
const owners: CallAuthority[] = [];
afterEach(async () => { await Promise.all(owners.splice(0).map(owner => owner.revoke())); });
function sdkHost(ctx = fakeCtx(), key: string | null = "test-key") {
  if (key !== null) ctx.env.TYPESAFE_API_KEY = key;
  const manifest = manifestSchema.parse({ id: "classifier-fixture", version: "1.0.0", publisher: "fixture", host: "^1.2", capabilities: [{ name: "net.http", scopes: ["127.0.0.1"] }, { name: "secrets.resolve" }] });
  const owner = createCallAuthority(ctx, { reads: [], commands: [], stores: [], http: { hosts: ["127.0.0.1"] } }, { deadlineMs: Date.now() + 10000, grants: ["net.http", "secrets.resolve"] });
  owners.push(owner);
  prepareHttpAuthority(owner, { declaredScopes: ["127.0.0.1"], explicitWildcardGrant: false });
  const fits = (_method: string, params: unknown) => Buffer.byteLength(JSON.stringify(params)) < 1048000;
  const transport = { features: ["httpBodyChunks"], requestFits: (params: unknown) => fits("", params), resultFits: (result: unknown) => fits("", result) };
  const call = (method: string, params: unknown) => answerCapability(ctx, { id: manifest.id, manifest }, method, params, owner, undefined, transport);
  return { http: createHttp({ call, fits, negotiated: () => true, signal: owner.signal }), secrets: { present: async (ref: string) => (await call("capability.secrets.resolve", { ref }) as { present: boolean }).present } };
}

const choice: Question = { type: "choice", id: "task_kind", instructions: "Choose kind", criteria: { docs: "Documentation", tests: "Tests" } };
const score: Question = { type: "score", id: "difficulty", instructions: "Rate reliability", min: 0, max: 1 };
const yesno: Question = { type: "yesno", id: "guard", instructions: "Execution work?" };
const choiceFixture = { model: "jev-latest", answers: { task_kind: { type: "choice", choice: "docs", probabilities: { docs: 0.8, tests: 0.2 }, confidence: 0.9 } }, usage: { input_tokens: 100, output_tokens: 20 } };
const scoreFixture = { model: "jev-latest", answers: { difficulty: { type: "score", score: 0.7 } }, usage: { input_tokens: 100, output_tokens: 20 } };
const probabilityFixture = { model: "jev-latest", answers: { guard: { type: "probability", probability: 0.3 } }, usage: { input_tokens: 100, output_tokens: 20 } };
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(stop => stop())); });

function serverFor(response: unknown) {
  const requests: { path: string; authorization: string | null; method: string; body: unknown }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    requests.push({ path: new URL(req.url).pathname, authorization: req.headers.get("authorization"), method: req.method, body: await req.json() });
    return Response.json(response);
  } });
  cleanup.push(() => server.stop(true));
  return { baseUrl: `http://127.0.0.1:${server.port}`, requests };
}
function adapter(baseUrl: string, overrides: Partial<Parameters<typeof jevClassifier>[0]> & { timeoutMs?: number; key?: string | null; ctx?: ReturnType<typeof fakeCtx> } = {}) {
  const { timeoutMs = 1000, key = "test-key", ctx = fakeCtx(), ...config } = overrides;
  const plugin = jevClassifier({ baseUrl, model: "jev-latest", keyRef: "secrets:TYPESAFE_API_KEY", usdPerMtokIn: null, usdPerMtokOut: null, ...config }, sdkHost(ctx, key));
  return { ...plugin, ask: (state: string, question: Question) => plugin.ask(state, question, timeoutMs) };
}
function secretsFile(contents: string, mode = 0o600) {
  const ctx = fakeCtx();
  cleanup.push(() => rmSync(ctx.home, { recursive: true, force: true }));
  mkdirSync(ctx.pacerHome, { recursive: true });
  const path = join(ctx.pacerHome, "secrets");
  writeFileSync(path, contents);
  chmodSync(path, mode);
  return { ctx, path };
}

for (const prefix of ["", "/typesafe/"]) {
  test(`posts authenticated Jev request through base ${prefix || "/"}`, async () => {
    const { baseUrl, requests } = serverFor(choiceFixture);
    let time = 10;
    const classifier = adapter(baseUrl + prefix, { nowMs: () => { const value = time; time += 25; return value; } });
    expect(classifier.id).toBe("jev");
    expect(classifier.external).toBe(true);
    expect(await classifier.ask("state", choice)).toEqual({ value: "docs", probabilities: { docs: 0.8, tests: 0.2 }, confidence: 0.9, latencyMs: 25 });
    expect(requests).toEqual([{ path: `${prefix ? "/typesafe" : ""}/v1/systemone`, authorization: "Bearer test-key", method: "POST", body: { state: "state", model: "jev-latest", questions: { task_kind: { type: "choice", instructions: "Choose kind", criteria: { docs: "Documentation", tests: "Tests" } } } } }]);
  });
}

test("builds score and probability question bodies", () => {
  expect(jevRequest("s", score, "custom")).toEqual({ state: "s", model: "custom", questions: { difficulty: { type: "score", instructions: "Rate reliability", criteria: { min: "0 is the lowest score", max: "1 is the highest score" } } } });
  expect(jevRequest("s", yesno, "custom")).toEqual({ state: "s", model: "custom", questions: { guard: { type: "probability", instructions: "Execution work?", criteria: { yes: "The answer is yes", no: "The answer is no" } } } });
});

test("maps assumed score response and clamps bounds", async () => {
  const { baseUrl } = serverFor(scoreFixture);
  expect(await adapter(baseUrl).ask("s", score)).toMatchObject({ value: 0.7, confidence: 0.5 });
  expect(mapJevAnswer(score, { type: "score", score: 2 }).value).toBe(1);
  expect(mapJevAnswer(score, { type: "score", score: -1 }).value).toBe(0);
});

test("maps assumed probability response with confidence and inclusive yes boundary", async () => {
  const { baseUrl } = serverFor(probabilityFixture);
  expect(await adapter(baseUrl).ask("s", yesno)).toMatchObject({ value: false, confidence: 0.7, probabilities: { yes: 0.3, no: 0.7 } });
  expect(mapJevAnswer(yesno, { type: "probability", probability: 0.5 }).value).toBe(true);
});

test("choice confidence defaults to the highest probability", () => {
  expect(mapJevAnswer(choice, { type: "choice", choice: "tests", probabilities: { docs: 0.2, tests: 0.8 } })).toMatchObject({ value: "tests", confidence: 0.8 });
});

test("rejects unknown choices and invalid numerical answers", () => {
  expect(() => mapJevAnswer(choice, { type: "choice", choice: "feature" })).toThrow();
  for (const probability of [-0.1, 1.1, NaN, "0.5"]) expect(() => mapJevAnswer(yesno, { type: "probability", probability })).toThrow();
  for (const value of [NaN, Infinity, "0.7"]) expect(() => mapJevAnswer(score, { type: "score", score: value })).toThrow();
});

test("computes usage cost only when both prices are set, including zero prices", async () => {
  const { baseUrl } = serverFor(choiceFixture);
  expect((await adapter(baseUrl, { usdPerMtokIn: 2, usdPerMtokOut: 5 }).ask("s", choice)).costUsd).toBeCloseTo(0.0003);
  expect((await adapter(baseUrl, { usdPerMtokIn: 0, usdPerMtokOut: 0 }).ask("s", choice)).costUsd).toBe(0);
  expect((await adapter(baseUrl, { usdPerMtokIn: 2 }).ask("s", choice)).costUsd).toBeUndefined();
  expect((await adapter(baseUrl, { usdPerMtokOut: 5 }).ask("s", choice)).costUsd).toBeUndefined();
});

test("does not invent a cost when usage is absent", async () => {
  const { baseUrl } = serverFor({ answers: choiceFixture.answers });
  expect((await adapter(baseUrl, { usdPerMtokIn: 2, usdPerMtokOut: 5 }).ask("s", choice)).costUsd).toBeUndefined();
});

test("missing key rejects before sending a request", async () => {
  const { baseUrl, requests } = serverFor(choiceFixture);
  await expect(adapter(baseUrl, { key: null }).ask("s", choice)).rejects.toThrow("TYPESAFE_API_KEY");
  expect(requests).toHaveLength(0);
});

test("missing answer id rejects", async () => {
  const { baseUrl } = serverFor({ answers: {} });
  await expect(adapter(baseUrl).ask("s", choice)).rejects.toThrow("Missing Jev answer");
});

test("host refuses mode 0644 secrets with chmod hint; plugin sees safe refusal and sends no request", async () => {
  const { ctx, path } = secretsFile("TYPESAFE_API_KEY=file-key\n", 0o644);
  expect(() => readSecrets(ctx)).toThrow(`must be mode 0600 (is 0644); run: chmod 600 ${path}`);
  const { baseUrl, requests } = serverFor(choiceFixture);
  await expect(adapter(baseUrl, { ctx, key: null }).ask("s", choice)).rejects.toThrow("secret reference could not be resolved");
  expect(requests).toHaveLength(0);
});

test("environment wins even over an insecure secrets file", () => {
  const { ctx } = secretsFile("TYPESAFE_API_KEY=file-key\n", 0o644);
  ctx.env.TYPESAFE_API_KEY = "env-key";
  expect(secret(ctx, "TYPESAFE_API_KEY")).toBe("env-key");
});

test("reads private KEY=VALUE secrets and missing files or keys return null", () => {
  const { ctx, path } = secretsFile("# comment\n\nTYPESAFE_API_KEY=file=key\nOTHER=value\n");
  expect(readSecrets(ctx)).toEqual({ TYPESAFE_API_KEY: "file=key", OTHER: "value" });
  ctx.env.TYPESAFE_API_KEY = "";
  expect(secret(ctx, "TYPESAFE_API_KEY")).toBe("file=key");
  expect(secret(ctx, "MISSING")).toBeNull();
  rmSync(path);
  expect(readSecrets(ctx)).toEqual({});
  expect(secret(ctx, "TYPESAFE_API_KEY")).toBeNull();
});


test("Jev HTTP errors omit an upstream body that echoes the API key", async () => {
  const key = "secret-test-key";
  const body = `Upstream unauthorized: ${key}`;
  const app = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(body, { status: 401 }) });
  cleanup.push(() => app.stop(true));
  const error = await adapter(app.url.href, { key }).ask("s", choice).catch((e) => e);
  expect(error).toBeInstanceOf(Error);
  expect(error.message).not.toContain(key);
  expect(error.message).not.toContain(body);
  expect(error).toMatchObject({ code: "capability_denied", message: "HTTP response exposed an injected credential" });
});

test("Jev parser errors never echo question identifiers containing the API key", async () => {
  const key = "secret-test-key";
  const { baseUrl } = serverFor({ answers: {} });
  const error = await adapter(baseUrl, { key }).ask("s", { ...choice, id: key + key }).catch((e) => e);
  expect(error).toBeInstanceOf(Error);
  expect(error.message).not.toContain(key);
  expect(error.message).toContain("Missing Jev answer");
});

for (const usage of ["bad", [], {}, { input_tokens: "100", output_tokens: 20 }, { input_tokens: 100, output_tokens: -1 }, { input_tokens: null, output_tokens: 20 }]) {
  test(`malformed usage ${JSON.stringify(usage)} preserves a valid Jev answer without cost`, async () => {
    const { baseUrl } = serverFor({ ...choiceFixture, usage });
    const answer = await adapter(baseUrl, { usdPerMtokIn: 2, usdPerMtokOut: 5 }).ask("s", choice);
    expect(answer).toMatchObject({ value: "docs", confidence: 0.9 });
    expect(answer.costUsd).toBeUndefined();
  });
}

test("Jev rejects a hung server within its short timeout budget", async () => {
  const app = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise<Response>(() => {}) });
  cleanup.push(() => app.stop(true));
  const start = performance.now();
  const error = await Promise.race([adapter(app.url.href, { timeoutMs: 20 }).ask("s", choice).catch((e) => e), Bun.sleep(3000).then(() => undefined)]);
  expect(error).toBeInstanceOf(Error);
  expect(performance.now() - start).toBeLessThan(3000);
}, 10000);

// A nonreflecting authenticated failure still preserves the provider status-only diagnostic.
test("Jev ordinary authenticated HTTP error remains status-only", async () => {
  const app = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("private upstream detail", { status: 401 }) });
  cleanup.push(() => app.stop(true));
  const error = await adapter(app.url.href).ask("s", choice).catch(error => error);
  expect(error.message).toBe("Jev HTTP 401");
  expect(error.message).not.toContain("private upstream detail");
});
