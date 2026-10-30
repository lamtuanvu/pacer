import { expect, test } from "bun:test";
import { discoverModels } from "./endpoint-discovery-fixtures";

for (const [name, body, expected] of [
  ["OpenAI", {data: [{id: "a"}]}, {id: "a"}],
  ["vLLM", {data: [{id: "a", max_model_len: 32768, max_output_tokens: 4096}]}, {id: "a", context: 32768, output: 4096}],
  ["LM Studio", {data: [{id: "a", display_name: "A", max_context_length: 8192}]}, {id: "a", name: "A", context: 8192}],
  ["Ollama", {models: [{model: "a", name: "A", model_info: {"llama.context_length": 4096}}]}, {id: "a", name: "A", context: 4096}],
] as const) test(`discovers ${name}`, async () => {
  const result = await discoverModels({baseUrl: "http://localhost/v1/", key: "test-secret", fetch: (async (url, init) => {
    expect(String(url)).toBe("http://localhost/v1/models");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-secret");
    return Response.json(body);
  })});
  expect(result).toEqual({listed: true, models: [expected]});
});
for (const [status, error] of [[401, "refused"], [403, "refused"], [404, "not_listed"], [500, "http_error"]] as const) test(`discovery HTTP ${status}`, async () => {
  const r = await discoverModels({baseUrl: "http://localhost", fetch: (async () => new Response("secret", {status}))});
  expect(r).toMatchObject({listed: false, error}); expect(JSON.stringify(r)).not.toContain("secret");
});
test("unreachable and invalid responses never expose errors or bodies", async () => {
  for (const fn of [async () => {throw Error("Authorization: Bearer private");}, async () => Response.json({unexpected: "private"}), async () => new Response("private")]) {
    const r = await discoverModels({baseUrl: "http://localhost", fetch: fn});
    expect(r.listed).toBe(false); expect(JSON.stringify(r)).not.toContain("private");
  }
});
test("timeout also bounds an unresponsive injected fetch", async () => {
  expect(await discoverModels({baseUrl: "http://localhost", timeoutMs: 5, fetch: (() => new Promise(() => {}))})).toMatchObject({listed: false, error: "timeout"});
});
test("discovery calls a loopback OpenAI-compatible server", async () => {
  const server = Bun.serve({hostname: "127.0.0.1", port: 0, fetch(request) {
    expect(new URL(request.url).pathname).toBe("/v1/models");
    expect(request.headers.get("Authorization")).toBe("Bearer loopback-test-key");
    return Response.json({data: [{id: "local", context_length: 8192, max_output_tokens: 1024}]});
  }});
  try {
    expect(await discoverModels({baseUrl: `http://127.0.0.1:${server.port}/v1`, key: "loopback-test-key"})).toEqual({listed: true, models: [{id: "local", context: 8192, output: 1024}]});
  } finally { await server.stop(true); }
});


test("host model discovery uses explicit discovery dependency, not catalog fetch", async () => {
  const { listModels } = await import("../src/core/endpoints");
  const { fakeCtx } = await import("./helpers");
  const calls: unknown[] = [];
  const result = await listModels(fakeCtx(), { base_url: "file:///not-requested" }, {
    discover: async (_ctx, input) => { calls.push(input); return { listed: true, models: [{ id: "owned-result" }] }; },
    fetch: async () => { throw Error("catalog fetch must not be used"); },
  });
  expect(result).toEqual({ listed: true, models: [{ id: "owned-result" }] });
  expect(calls).toEqual([{ baseUrl: "file:///not-requested", key: null }]);
});


test("local detection and setup retain explicit 1s and 3s discovery budgets", async () => {
  const { fakeCtx } = await import("./helpers");
  const { detectCandidates } = await import("../src/endpoints/detect");
  const { setupModels } = await import("../src/core/opencode-setup");
  const inputs: { baseUrl: string; timeoutMs?: number }[] = [];
  const discover = async (_ctx: unknown, input: { baseUrl: string; timeoutMs?: number }) => {
    inputs.push(input);
    return { listed: false as const, error: "unreachable", detail: "owned fixture" };
  };
  const ctx = fakeCtx({ which: () => null });
  await detectCandidates(ctx, { discover, catalog: null, accounts: {} });
  await setupModels(ctx, { provider: "ollama", group: "local", base_url: "http://127.0.0.1:11434/v1" }, { catalog: null, discover });
  expect(inputs.map(input => input.timeoutMs)).toEqual([1000, 1000, 3000]);
});
