import { expect, test } from "bun:test";
import { ollamaClassifier, parseLocalAnswer, promptFor } from "../src/classify/ollama";
import type { Question } from "../src/classify/types";

const choice: Question = { type: "choice", id: "task_kind", instructions: "Choose the task kind", criteria: { tests: "Testing work", docs: "Documentation work" } };
const score: Question = { type: "score", id: "difficulty", instructions: "Rate reliability", min: 0, max: 1 };
const yesno: Question = { type: "yesno", id: "guard", instructions: "Is this execution work?" };
const state = '{"goal":"Add tests"}';
const options = { model: "qwen3.6-35b-a3b", timeoutMs: 1000, maxTokens: 512 };

for (const fixture of [
  { q: choice, field: "choice", property: { type: "string", enum: ["tests", "docs"] }, reply: { choice: "tests", confidence: 0.9 }, value: "tests" },
  { q: score, field: "score", property: { type: "number", minimum: 0, maximum: 1 }, reply: { score: 0.8, confidence: 0.9 }, value: 0.8 },
  { q: yesno, field: "answer", property: { type: "boolean" }, reply: { answer: false, confidence: 0.9 }, value: false },
]) {
  test(`${fixture.q.type} sends a structured OpenAI-compatible request and maps the reply`, async () => {
    let recorded: any;
    let path = "";
    let authorization: string | null = null;
    const app = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      recorded = await request.json();
      path = new URL(request.url).pathname;
      authorization = request.headers.get("authorization");
      return Response.json({ choices: [{ message: { content: JSON.stringify(fixture.reply) } }] });
    } });
    try {
      let time = 100;
      const adapter = ollamaClassifier({ ...options, baseUrl: `${app.url.href}v1///`, apiKey: "fake-key", nowMs: () => { time += 7; return time; } });
      expect(adapter.id).toBe("ollama");
      expect(await adapter.ask(state, fixture.q)).toEqual({ value: fixture.value, confidence: 0.9, latencyMs: 7, costUsd: 0 });
      expect(path).toBe("/v1/chat/completions");
      expect(authorization as string | null).toBe("Bearer fake-key");
      expect(recorded).toMatchObject({ model: "qwen3.6-35b-a3b", temperature: 0, stream: false, max_tokens: 512, response_format: { type: "json_schema", json_schema: { name: expect.any(String), schema: { type: "object", properties: { [fixture.field]: fixture.property, confidence: { type: "number", minimum: 0, maximum: 1 } }, required: [fixture.field, "confidence"] } } } });
      expect(recorded.response_format.json_schema).not.toHaveProperty("strict");
      expect(JSON.stringify(recorded.messages)).toContain(fixture.q.instructions);
      expect(recorded.messages.some((message: any) => message.content.includes(state))).toBe(true);
      if (fixture.q.type === "choice") expect(JSON.stringify(recorded.messages)).toContain("Testing work");
    } finally { app.stop(true); }
  });
}

test("a fenced JSON reply parses through the adapter", async () => {
  const app = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ choices: [{ message: { content: '```json\n{"choice":"docs","confidence":1}\n```' } }] }) });
  try { expect(await ollamaClassifier({ ...options, baseUrl: app.url.href }).ask(state, choice)).toMatchObject({ value: "docs", confidence: 1, costUsd: 0 }); }
  finally { app.stop(true); }
});

for (const fixture of [
  { name: "out-of-enum choice", q: choice, content: '{"choice":"feature","confidence":0.9}' },
  { name: "prose reply", q: choice, content: 'I recommend {"choice":"tests","confidence":0.9}' },
  { name: "out-of-range score", q: score, content: '{"score":1.1,"confidence":0.9}' },
  { name: "string score", q: score, content: '{"score":"0.8","confidence":0.9}' },
  { name: "non-boolean answer", q: yesno, content: '{"answer":"yes","confidence":0.9}' },
  { name: "missing confidence", q: yesno, content: '{"answer":true}' },
  { name: "out-of-range confidence", q: yesno, content: '{"answer":true,"confidence":-0.1}' },
  { name: "null reply", q: yesno, content: 'null' },
]) {
  test(`${fixture.name} throws`, () => {
    expect(() => parseLocalAnswer(fixture.q, fixture.content)).toThrow();
  });
}

test("HTTP 500 rejects", async () => {
  const app = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unavailable", { status: 500 }) });
  try { await expect(ollamaClassifier({ ...options, baseUrl: app.url.href }).ask(state, yesno)).rejects.toThrow("HTTP 500"); }
  finally { app.stop(true); }
});

test("connection refused rejects using a closed local port", async () => {
  const app = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const baseUrl = app.url.href;
  await app.stop(true);
  await expect(ollamaClassifier({ ...options, baseUrl }).ask(state, yesno)).rejects.toThrow();
});

test("external distinguishes loopback and localhost names from remote URLs", () => {
  for (const baseUrl of ["http://127.0.0.1:1234/v1", "http://localhost:1234/v1", "http://[::1]:1234/v1", "http://model.localhost/v1"]) {
    expect(ollamaClassifier({ ...options, baseUrl }).external).toBe(false);
  }
  expect(ollamaClassifier({ ...options, baseUrl: "https://models.example.com/v1" }).external).toBe(true);
});

test("prompt includes score bounds and requests structured JSON", () => {
  const prompt = promptFor(score, state);
  expect(prompt).toContain("Rate reliability");
  expect(prompt).toContain(state);
  expect(prompt).toContain("0");
  expect(prompt).toContain("1");
  expect(prompt).toContain("JSON");
});
