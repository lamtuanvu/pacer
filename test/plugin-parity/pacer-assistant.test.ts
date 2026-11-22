/**
 * Parity scenarios for `pacer-assistant` (M3 C4). The driver cannot inject a
 * transport into the TS process, so each scenario runs a loopback OpenAI stub
 * (`openai-stub.ts`) that both the TypeScript and Rust plugin processes reach
 * directly. The stub records the request body and Authorization header; the
 * test compares the two request shapes as parsed JSON and asserts the
 * transcripts are identical.
 *
 * The Rust side only runs when PACER_TEST_FRONT_DOOR points at a `pacer`
 * built from this branch; without it the test is skipped.
 */
import { describe, expect, test } from "bun:test";
import { parity, rustArgv } from "./driver";
import type { Step, Transcript } from "./driver";
import { start, type Stub, type StubOptions } from "./openai-stub";

const WITH_TOOLS = JSON.stringify({
  choices: [
    {
      message: {
        content: "Hello",
        tool_calls: [{ id: "c9", function: { name: "budget", arguments: '{"x":1}' } }],
      },
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 3 },
});

function respondParams(url: string, opts: { deadlineMs?: number; maxToolRounds?: number } = {}) {
  return {
    conversationId: "conv-1",
    turnId: "turn-1",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "snapshot", arguments: {} }] },
      { role: "tool", toolCallId: "c1", content: "<data>{}</data>" },
    ],
    tools: [{ name: "snapshot", description: "d", parameters: { type: "object" } }],
    context: {
      system: "sys",
      backend: { kind: "endpoint", account: "ep", model: "m1", baseUrl: url },
    },
    limits: {
      maxOutputTokens: 256,
      maxToolRounds: opts.maxToolRounds ?? 2,
      deadlineMs: opts.deadlineMs ?? 5000,
    },
  };
}

const secretAnswer = () => ({ value: "sk-test-key" });

const scenarios: {
  name: string;
  stub: StubOptions;
  deadlineMs?: number;
  assert?: (t: Transcript, stub: Stub) => void;
}[] = [
  // 1. 200 with tools and usage.
  { name: "200 with tools", stub: { status: 200, body: WITH_TOOLS } },
  // 2. 200 without usage (unknown coverage).
  { name: "200 without usage", stub: { status: 200 } },
  // 3. 401 — the status is named; the echoable body is discarded.
  { name: "401", stub: { status: 401, body: "invalid key sk-test-key" } },
  // 4. A body that is not JSON → internal; only the error code is compared.
  { name: "non-JSON body", stub: { status: 200, body: "this is not json" } },
  // 5. A hung endpoint with a 200 ms deadline → plugin_timeout.
  { name: "hung 200ms", stub: { status: 200, hang: true }, deadlineMs: 200 },
];

// For a non-JSON body the JSON-RPC message carries the parser's text, which
// differs between Node and Rust. The plan compares only the code.
const normalize = (t: Transcript): Transcript => {
  const s = structuredClone(t);
  for (const step of s.steps) {
    const data = step.error?.data as { code?: string } | undefined;
    if (data?.code === "internal") step.error!.message = "<parse error>";
  }
  return s;
};

describe("pacer-assistant parity (TypeScript vs Rust)", () => {
  for (const scenario of scenarios) {
    test.skipIf(!rustArgv("pacer-assistant"))(
      `pacer-assistant ${scenario.name} reproduces the TS transcript`,
      async () => {
        const stub = start(scenario.stub);
        try {
          const params = respondParams(stub.url, { deadlineMs: scenario.deadlineMs });
          const { ts, rust } = await parity(
            "pacer-assistant",
            [{ method: "assistant.respond", params }] as Step[],
            { "capability.secrets.resolve": secretAnswer },
            {},
            normalize,
          );
          expect(rust).toEqual(ts);
          // Both processes posted identical request bodies (TS then Rust, in
          // drive order) with the resolved key as the Authorization header.
          expect(stub.bodies[0]).toEqual(stub.bodies[1]);
          expect(stub.authHeaders[0]).toBe("Bearer sk-test-key");
          expect(stub.authHeaders[1]).toBe("Bearer sk-test-key");
        } finally {
          stub.stop();
        }
      },
      30000,
    );
  }
});