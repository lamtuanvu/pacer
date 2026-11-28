import { describe, expect, test } from "bun:test";
import { createRedactor } from "../src/assistant/redact";
import { runAssistantTool } from "../src/assistant/service";
import type { AssistantToolState } from "../src/assistant/turn-tools";
import type { AssistantScope } from "../src/assistant/types";
import type { ReadOp } from "../src/assistant/tools";
import { fakeCtx } from "./helpers";

// B4-3 library slice. The Rust port lands behind the library exception and
// B4-4 wires `test.assistant.tool` into the front door. This file freezes the
// TypeScript half of the parity contract and, when a native driver built with
// `--features test-ops` is supplied through PACER_NATIVE_TOOL_DRIVER, runs the
// same cases through it and compares the two byte-for-byte.

const scope: AssistantScope = { kind: "dispatch", days: 7 };
const redactor = createRedactor(["sk-test-123"], "/sandbox/home");
const read: ReadOp = async (_ctx, op, params) => {
  if (op === "snapshot.get") {
    return { snapshot: { counts: { open: 2 }, attention: [], mode: "normal", pause: null, planner: "claude-code" } };
  }
  if (op === "dispatch.tree") return { id: params.id, title: "ota: stale plan", state: "failed" };
  return { items: [] };
};
const state = (max = 6): AssistantToolState => ({
  cards: [], notes: [], toolLog: [], seenTasks: new Set(), rounds: { used: 0, max },
});

type Case = { name: string; call: { id: string; name: string; arguments: Record<string, unknown> }; expected: { ok: boolean; content: string } };
const cases: Case[] = [
  {
    name: "snapshot result is delimited data",
    call: { id: "c1", name: "snapshot", arguments: {} },
    expected: {
      ok: true,
      content: '<data tool="snapshot">\n{"counts":{"open":2},"attention":[],"mode":"normal","pause":null,"planner":"claude-code"}\n</data>',
    },
  },
  {
    name: "an unknown tool fails closed",
    call: { id: "c2", name: "run_shell", arguments: {} },
    expected: { ok: false, content: '<data tool="run_shell">\n{"error":"Unknown tool run_shell."}\n</data>' },
  },
  {
    name: "invalid arguments fail closed",
    call: { id: "c3", name: "task_get", arguments: {} },
    expected: { ok: false, content: '<data tool="task_get">\n{"error":"Invalid tool arguments."}\n</data>' },
  },
];

async function runNative(call: Case["call"]): Promise<{ ok: boolean; content: string } | null> {
  const driver = process.env.PACER_NATIVE_TOOL_DRIVER;
  if (!driver) return null;
  const process_ = Bun.spawn([driver, JSON.stringify(call)], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(process_.stdout).text();
  const code = await process_.exited;
  if (code !== 0) throw new Error(`native driver exited ${code}`);
  return JSON.parse(out) as { ok: boolean; content: string };
}

describe("native assistant tool parity", () => {
  for (const item of cases) {
    test(item.name, async () => {
      const toolState = state();
      const result = await runAssistantTool(fakeCtx(), item.call, {
        read, scope, redactor, cards: { task: () => null }, state: toolState,
      });
      expect({ ok: result.ok, content: result.content }).toEqual(item.expected);
      const native = await runNative(item.call);
      if (native) expect(native).toEqual(item.expected);
    });
  }

  test("one shared round budget refuses the call past its limit", async () => {
    const toolState = state(1);
    await runAssistantTool(fakeCtx(), cases[0].call, { read, scope, redactor, cards: { task: () => null }, state: toolState });
    await expect(runAssistantTool(fakeCtx(), cases[0].call, { read, scope, redactor, cards: { task: () => null }, state: toolState }))
      .rejects.toThrow(/tool-call budget/);
  });

  test("the native driver remains UNVERIFIED until B4-4 wires test.assistant.tool", () => {
    // A driver built with `--features test-ops` is optional in this library
    // slice; B4-4 connects it to the front door and runs the same goldens.
    expect(process.env.PACER_NATIVE_TOOL_DRIVER ? "wired" : "unverified").toBeTruthy();
  });
});
