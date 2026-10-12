import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jevClassifier, jevRequest, mapJevAnswer } from "../src/classify/jev";
import { readSecrets, secret } from "../src/classify/secrets";
import type { Question } from "../src/classify/types";
import { fakeCtx } from "./helpers";

const choice: Question = { type: "choice", id: "task_kind", instructions: "Choose kind", criteria: { docs: "Documentation", tests: "Tests" } };
const score: Question = { type: "score", id: "difficulty", instructions: "Rate reliability", min: 0, max: 1 };
const yesno: Question = { type: "yesno", id: "guard", instructions: "Execution work?" };
const choiceFixture = { model: "jev-latest", answers: { task_kind: { type: "choice", choice: "docs", probabilities: { docs: 0.8, tests: 0.2 }, confidence: 0.9 } }, usage: { input_tokens: 100, output_tokens: 20 } };
const scoreFixture = { model: "jev-latest", answers: { difficulty: { type: "score", score: 0.7 } }, usage: { input_tokens: 100, output_tokens: 20 } };
const probabilityFixture = { model: "jev-latest", answers: { guard: { type: "probability", probability: 0.3 } }, usage: { input_tokens: 100, output_tokens: 20 } };
const cleanup: (() => void)[] = [];
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); });

function serverFor(response: unknown) {
  const requests: { path: string; authorization: string | null; method: string; body: unknown }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    requests.push({ path: new URL(req.url).pathname, authorization: req.headers.get("authorization"), method: req.method, body: await req.json() });
    return Response.json(response);
  } });
  cleanup.push(() => server.stop(true));
  return { baseUrl: `http://127.0.0.1:${server.port}`, requests };
}
function adapter(baseUrl: string, overrides: Partial<Parameters<typeof jevClassifier>[0]> = {}) {
  return jevClassifier({ baseUrl, model: "jev-latest", apiKey: () => "test-key", keyName: "TYPESAFE_API_KEY", timeoutMs: 1000, usdPerMtokIn: null, usdPerMtokOut: null, ...overrides });
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
  await expect(adapter(baseUrl, { apiKey: () => null }).ask("s", choice)).rejects.toThrow("TYPESAFE_API_KEY");
  expect(requests).toHaveLength(0);
});

test("missing answer id rejects", async () => {
  const { baseUrl } = serverFor({ answers: {} });
  await expect(adapter(baseUrl).ask("s", choice)).rejects.toThrow("task_kind");
});

test("refuses mode 0644 secrets with chmod hint and sends no request", async () => {
  const { ctx, path } = secretsFile("TYPESAFE_API_KEY=file-key\n", 0o644);
  expect(() => readSecrets(ctx)).toThrow(`must be mode 0600 (is 0644); run: chmod 600 ${path}`);
  const { baseUrl, requests } = serverFor(choiceFixture);
  await expect(adapter(baseUrl, { apiKey: () => secret(ctx, "TYPESAFE_API_KEY") }).ask("s", choice)).rejects.toThrow("chmod 600");
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
