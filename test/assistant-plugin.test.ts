import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUNDLED } from "../plugins/bundled";
import { chatRequest, chatResult, respond, type RespondParams } from "../plugins/assistant/index";
import { assistantSecret } from "../src/assistant/service";
import { readSettings, writeSettings } from "../src/assistant/store";
import { PluginRegistry } from "../src/plugins/registry";
import { assistantRespondParams, EXTENSION_METHODS, PLUGIN_PROTOCOL_VERSION } from "../src/plugins/protocol";
import { fakeCtx } from "./helpers";

const KEY = ["sk", "-test-key"].join("");
const params: RespondParams = {
  conversationId: "conv-1", turnId: "turn-1", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "snapshot", arguments: {} }] }, { role: "tool", toolCallId: "c1", content: "<data>{}</data>" }],
  tools: [{ name: "snapshot", description: "d", parameters: { type: "object" } }],
  context: { system: "sys", backend: { kind: "endpoint", account: "ep", model: "m1", baseUrl: "http://models.test/v1/" } },
  limits: { maxOutputTokens: 500, maxToolRounds: 3, deadlineMs: 5000 },
};
const host = (key: string | null) => ({ call: async <T,>() => ({ value: key }) as T });
const fetchOk = (body: unknown, seen: { url?: string; init?: RequestInit } = {}) => (async (url: string, init: RequestInit) => { seen.url = url; seen.init = init; return Response.json(body); }) as unknown as typeof fetch;

describe("pacer-assistant plugin", () => {
  test("params match the protocol schema and the method has the 120 s ceiling", () => {
    expect(assistantRespondParams.safeParse(params).success).toBe(true);
    expect(EXTENSION_METHODS["assistant.respond"]!.deadlineMs).toBe(120_000);
    expect(PLUGIN_PROTOCOL_VERSION).toBe("1.7.0");
  });
  test("maps messages, tool calls and tools onto an OpenAI-compatible request", () => {
    const body = chatRequest(params) as any;
    expect(body.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(body.messages[2].tool_calls[0].function.name).toBe("snapshot");
    expect(body.messages[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "<data>{}</data>" });
    expect(body.tools).toHaveLength(1);
    expect((chatRequest({ ...params, limits: { ...params.limits, maxToolRounds: 0 } }) as any).tools).toBeUndefined();
  });
  test("reads the key through the host, sends it as a bearer header, and parses usage", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const out = await respond(params, host(KEY) as never, new AbortController().signal, fetchOk({ choices: [{ message: { content: "Hello", tool_calls: [{ id: "c9", function: { name: "budget", arguments: "{\"x\":1}" } }] } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }, seen));
    expect(seen.url).toBe("http://models.test/v1/chat/completions");
    expect((seen.init!.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(out).toEqual({ message: "Hello", toolCalls: [{ id: "c9", name: "budget", arguments: { x: 1 } }], usage: { input: 12, output: 3, coverage: "measured" } });
  });
  test("missing usage is reported as unknown coverage, not zero", () => {
    expect(chatResult({ choices: [{ message: { content: "x" } }] }).usage.coverage).toBe("unknown");
  });
  test("an HTTP error names the status only; the response body, which can echo the key, is never read", async () => {
    const bad = (async () => new Response(`invalid key ${KEY}`, { status: 401 })) as unknown as typeof fetch;
    const err = await respond(params, host(KEY) as never, new AbortController().signal, bad).catch(e => e as Error);
    expect(String(err.message)).toBe("The model endpoint answered HTTP 401.");
  });
});

describe("hosting", () => {
  test("only the assistant plugin resolves only the chosen account's key", async () => {
    const ctx = fakeCtx();
    await expect(assistantSecret(ctx, "pacer-assistant", "endpoint/ep")).rejects.toThrow(/not the assistant's account/);
    writeSettings(ctx, { runner: null, account: "ep", expect_rev: readSettings(ctx).rev });
    await expect(assistantSecret(ctx, "other-plugin", "endpoint/ep")).rejects.toThrow(/may not resolve/);
    await expect(assistantSecret(ctx, "pacer-assistant", "endpoint/other")).rejects.toThrow(/not the assistant's account/);
  });
  test("the bundled assistant plugin is registered, and an installed plugin contributing assistant is refused", () => {
    expect(BUNDLED.find(b => b.manifest.id === "pacer-assistant")?.manifest.contributes).toEqual({ assistant: {} });
    const ctx = fakeCtx();
    const dir = join(ctx.pacerHome, "plugins", "evil-assistant");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pacer-plugin.json"), JSON.stringify({ id: "evil-assistant", version: "1.0.0", publisher: "x", host: "^1", entry: "run.sh", contributes: { assistant: {} } }));
    const registry = new PluginRegistry({ bundled: BUNDLED, spawnBundled: () => { throw new Error("not spawned"); } });
    const info = registry.list(ctx).find(p => p.id === "evil-assistant");
    expect(info?.state).toBe("refused");
    expect(info?.error).toContain("only bundled plugins may serve the assistant");
  });
});
