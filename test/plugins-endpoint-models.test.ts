import { expect, test } from "bun:test";
import type { HostClient } from "@pacer/plugin";
import { discoverModels } from "../plugins/pacer-endpoints/models";

const reply = (body: unknown, status = 200) => ({ status, headers: {}, body: JSON.stringify(body) });
for (const [name, body, expected] of [
  ["OpenAI", { data: [{ id: "a" }] }, { id: "a" }],
  ["vLLM", { data: [{ id: "a", max_model_len: 32768, max_output_tokens: 4096 }] }, { id: "a", context: 32768, output: 4096 }],
  ["LM Studio", { data: [{ id: "a", display_name: "A", max_context_length: 8192 }] }, { id: "a", name: "A", context: 8192 }],
  ["Ollama", { models: [{ model: "a", name: "A", model_info: { "llama.context_length": 4096 } }] }, { id: "a", name: "A", context: 4096 }],
] as const) test(`plugin discovers ${name} with only an endpoint key reference`, async () => {
  const http: HostClient["http"] = async request => {
    expect(request).toEqual({ url: "http://localhost/v1/models", method: "GET", timeoutMs: 10000, authorization: { secretRef: "endpoint:acme" } });
    expect(JSON.stringify(request)).not.toContain("test-secret");
    return reply(body);
  };
  expect(await discoverModels({ http }, { baseUrl: "http://localhost/v1/", keyRef: "endpoint:acme" })).toEqual({ listed: true, models: [expected] });
});
for (const [status, error, detail] of [
  [401, "refused", "The key was refused."], [403, "refused", "The key was refused."],
  [404, "not_listed", "This endpoint doesn't list models. Enter model ids."],
  [500, "http_error", "Model discovery failed (HTTP 500)."],
] as const) test(`plugin discovery HTTP ${status}`, async () => {
  const result = await discoverModels({ http: async () => ({ status, headers: {}, body: "secret" }) }, { baseUrl: "http://localhost" });
  expect(result).toEqual({ listed: false, error, detail });
  expect(JSON.stringify(result)).not.toContain("secret");
});
test("plugin unreachable and malformed responses expose fixed diagnostics only", async () => {
  for (const http of [async () => { throw Error("Authorization: Bearer private"); }, async () => reply({ unexpected: "private" }), async () => ({ status: 200, headers: {}, body: "private" })]) {
    const result = await discoverModels({ http }, { baseUrl: "http://localhost" });
    expect(result.listed).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private");
  }
});
test("plugin timeout bounds a nonresponsive host callback", async () => {
  expect(await discoverModels({ http: () => new Promise(() => {}) }, { baseUrl: "http://localhost", timeoutMs: 5 })).toEqual({ listed: false, error: "timeout", detail: "Model discovery timed out." });
});
test("invalid URL refuses before host effects, while no-key query and path semantics are preserved", async () => {
  let calls = 0;
  const http: HostClient["http"] = async request => {
    calls++;
    expect(request).toEqual({ url: "http://localhost/v1/models?x=1", method: "GET", timeoutMs: 3000 });
    return reply({ data: [] });
  };
  for (const baseUrl of ["file:///tmp/models", "http://user:pass@localhost/v1"]) expect(await discoverModels({ http }, { baseUrl })).toEqual({ listed: false, error: "invalid_url", detail: "Check the URL and try again." });
  expect(calls).toBe(0);
  expect(await discoverModels({ http }, { baseUrl: "http://localhost/v1/?x=1", keyRef: null, timeoutMs: 3000 })).toEqual({ listed: true, models: [] });
  expect(calls).toBe(1);
});
test("model precedence, first duplicate and safe integer metadata match existing discovery", async () => {
  const body = { data: [null, { id: " " }, { id: "a", model: "ignored", context_length: -1, max_model_len: 8192, max_output_tokens: 1.5, output_length: 128, tools: false }, { id: "a", tools: true }, { name: "fallback", context_window: Number.MAX_SAFE_INTEGER + 1 }] };
  expect(await discoverModels({ http: async () => reply(body) }, { baseUrl: "http://localhost" })).toEqual({ listed: true, models: [{ id: "a", context: 8192, output: 128, tools: false }, { id: "fallback", name: "fallback" }] });
});
test("plugin JSON decoding preserves Response.json leading BOM behavior", async () => {
  expect(await discoverModels({ http: async () => ({ status: 200, headers: {}, body: '\ufeff{"data":[{"id":"a"}]}' }) }, { baseUrl: "http://localhost" })).toEqual({ listed: true, models: [{ id: "a" }] });
});
test("plugin discovery reaches an owned loopback adapter without receiving the resolved key", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    expect(new URL(request.url).pathname).toBe("/v1/models");
    expect(request.headers.get("Authorization")).toBe("Bearer loopback-test-key");
    return Response.json({ data: [{ id: "local", context_length: 8192, max_output_tokens: 1024 }] });
  } });
  const http: HostClient["http"] = async request => {
    expect(request.authorization).toEqual({ secretRef: "endpoint:acme" });
    // Test-only adapter; production authority/key-store integration is not asserted.
    const response = await fetch(request.url, { headers: { Authorization: "Bearer loopback-test-key" } });
    return { status: response.status, headers: {}, body: await response.text() };
  };
  try {
    expect(await discoverModels({ http }, { baseUrl: `http://127.0.0.1:${server.port}/v1`, keyRef: "endpoint:acme" })).toEqual({ listed: true, models: [{ id: "local", context: 8192, output: 1024 }] });
  } finally { await server.stop(true); }
});

import { PluginError } from '@pacer/plugin';
test('typed host credential reflection preserves invalid-response diagnostic without inspecting messages', async () => {
  const failure=Object.assign(new PluginError('capability_denied','fixed host message'),{reason:'credential_reflection'});
  expect(await discoverModels({http:async()=>{throw failure;}},{baseUrl:'http://localhost',keyRef:'endpoint:acme'})).toEqual({listed:false,error:'invalid_response',detail:'The endpoint returned an invalid model list.'});
  for (const error of [new PluginError('capability_denied','HTTP response exposed an injected credential'),Object.assign(new PluginError('invalid_input','fixed'),{reason:'credential_reflection'}),Object.assign(new PluginError('capability_denied','fixed'),{reason:'unknown'})]) {
    expect(await discoverModels({http:async()=>{throw error;}},{baseUrl:'http://localhost'})).toEqual({listed:false,error:'unreachable',detail:'Endpoint unreachable. Check the URL and try again.'});
  }
});
