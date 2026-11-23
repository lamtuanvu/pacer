/**
 * Parity scenarios for `assistant-executor` (M3 C9): the same scripted host
 * traffic through the TypeScript CLI and the Rust front door must produce
 * identical transcripts (hello, `assistant.reply` step results, the
 * `capability.process.spawn` call trace). The Rust side only runs when
 * PACER_TEST_FRONT_DOOR points at a `pacer` built from this branch; without
 * it the test is skipped (parity is trivially TS == TS).
 */
import { describe, expect, test } from "bun:test";
import { parity, rustArgv } from "./driver";
import type { Answer, Step, Transcript } from "./driver";

/**
 * An opencode JSONL answer with `text` (optionally an error event), keyed to
 * the host's ask-mode protocol so the parser can read it independently of any
 * installed CLI.
 */
type OpenCodeEvent =
  | { type: "step_start"; sessionID: string; part: Record<string, unknown> }
  | { type: "text"; sessionID: string; part: { text: string } }
  | { type: "step_finish"; sessionID: string; part: { tokens: { input: number; output: number } } }
  | { type: "error"; sessionID: string; error: { type: string; message: string } };

function opencodeCommands(text: string, withError = false): string {
  const events: OpenCodeEvent[] = [
    { type: "step_start", sessionID: "ses_1", part: {} },
    { type: "text", sessionID: "ses_1", part: { text } },
    { type: "step_finish", sessionID: "ses_1", part: { tokens: { input: 10, output: 2 } } },
  ];
  if (withError) events.push({ type: "error", sessionID: "ses_1", error: { type: "run", message: "boom" } });
  return events.map((e) => JSON.stringify(e)).join("\n");
}

const okAcp: Answer = () => ({ code: 0, timeoutMs: 0, stdout: opencodeCommands("Hello", false), timedOut: false });

const baseExecutor = {
  command: { argv: ["opencode", "acp"], cwd: "/ask", env: {}, stdin: "hi", timeoutMs: 30000 },
};

const scenarios: {
  name: string;
  step: Step;
  answers: Record<string, Answer>;
  normalize?: (t: Transcript) => Transcript;
}[] = [
  // 1. no executor payload → invalid_input, no spawn.
  {
    name: "missing executor",
    step: { method: "assistant.reply", params: {} },
    answers: {},
  },
  // 2. opencode acp turn binds config+grant secret refs and returns text/session/usage.
  {
    name: "opencode acp success",
    step: {
      method: "assistant.reply",
      params: {
        session: "ses_old",
        executor: {
          configRef: "secrets:assistantAskConfig",
          grantRef: "secrets:assistantGrant",
          ...baseExecutor,
        },
      },
    },
    answers: { "capability.process.spawn": okAcp },
  },
  // 3. codex turns bind only the grant secret ref.
  {
    name: "codex success",
    step: {
      method: "assistant.reply",
      params: {
        executor: {
          configRef: "secrets:assistantAskConfig",
          command: { argv: ["codex"], cwd: "/ask", env: {}, stdin: "hi", timeoutMs: 30000 },
        },
      },
    },
    answers: {
      "capability.process.spawn": () => ({
        code: 0,
        timedOut: false,
        stdout: JSON.stringify({ codex: true, text: "Hello over codex", session: "th_1" }),
      }),
    },
  },
  // 4. claude run with a missing expected init surface → plugin_refused.
  {
    name: "claude missing init surface",
    step: {
      method: "assistant.reply",
      params: {
        executor: {
          grantRef: "secrets:assistantGrant",
          command: {
            argv: ["claude", "-p", "--mcp-config", '{"mcpServers":{"pacer":{}}}'],
            cwd: "/ask",
            env: { CLAUDE_CONFIG_DIR: "/home/work" },
            stdin: "hi",
            timeoutMs: 30000,
          },
        },
      },
    },
    answers: { "capability.process.spawn": () => ({ code: 0, stdout: "{}", timedOut: false }) },
  },
  // 5. buffered stdout is read via outputChunk in chunks until empty.
  {
    name: "outputChunk reads until empty",
    step: { method: "assistant.reply", params: { executor: baseExecutor } },
    answers: {
      "capability.process.spawn": () => ({ code: 0, timedOut: false, output: { stdout: "handle-1" } }),
      "capability.process.outputChunk": () => {
        // A single empty chunk → the plugin finishes reading the empty handle.
        return { base64: "" };
      },
    },
  },
  // 6. a failed resume with a stored session runs the host's fallback command.
  {
    name: "resume failure runs fallback",
    step: {
      method: "assistant.reply",
      params: {
        session: "ses_gone",
        executor: {
          command: { argv: ["opencode", "acp"], cwd: "/ask", env: {}, stdin: "resume", timeoutMs: 30000 },
          fallback: { argv: ["opencode", "acp"], cwd: "/ask", env: {}, stdin: "seed", timeoutMs: 30000 },
        },
      },
    },
    answers: {
      "capability.process.spawn": (params: any) =>
        params?.stdin === "seed"
          ? { code: 0, stdout: opencodeCommands("recovered", false), timedOut: false }
          : { code: 5, stdout: opencodeCommands("", false), timedOut: false },
    },
  },
  // 7. no stored session → the fallback is never run (exit 5).
  {
    name: "no session no fallback",
    step: {
      method: "assistant.reply",
      params: {
        executor: {
          command: { argv: ["opencode", "acp"], cwd: "/ask", env: {}, stdin: "hi", timeoutMs: 30000 },
          fallback: { argv: ["opencode", "acp"], cwd: "/ask", env: {}, stdin: "seed", timeoutMs: 30000 },
        },
      },
    },
    answers: { "capability.process.spawn": () => ({ code: 5, stdout: opencodeCommands("", false), timedOut: false }) },
  },
  // 8. a timed out run is a plugin_timeout.
  {
    name: "timeout is plugin_timeout",
    step: { method: "assistant.reply", params: { executor: baseExecutor } },
    answers: { "capability.process.spawn": () => ({ code: 0, stdout: "", timedOut: true }) },
  },
  // 9. a claude error refuses the turn even when text arrived.
  {
    name: "claude error refuses even with text",
    step: {
      method: "assistant.reply",
      params: {
        executor: {
          command: { argv: ["claude"], cwd: "/ask", env: {}, stdin: "hi", timeoutMs: 30000 },
        },
      },
    },
    answers: {
      "capability.process.spawn": () => ({
        code: 0,
        timedOut: false,
        stdout: JSON.stringify({
          claudeControl: true,
          text: "answer text",
          error: "a Claude hook lifecycle event ran",
          toolsHealthy: false,
        }),
      }),
    },
  },
  // 10. no text is unavailable, naming the exit code.
  {
    name: "no text is unavailable",
    step: { method: "assistant.reply", params: { executor: baseExecutor } },
    answers: {
      "capability.process.spawn": () => ({
        code: 0,
        timedOut: false,
        stdout: JSON.stringify({ type: "step_finish", part: {} }),
      }),
    },
  },
  // 11. acp tools are capped at 64.
  {
    name: "tools capped at 64",
    step: { method: "assistant.reply", params: { executor: baseExecutor } },
    answers: {
      "capability.process.spawn": () => {
        const tools = Array.from({ length: 66 }, (_, i) => ({ tool: `t${i}`, status: "completed" }));
        return {
          code: 0,
          timedOut: false,
          stdout: JSON.stringify({ acp: true, text: "done", session: "s", tools }),
        };
      },
    },
  },
  // 12. an opencode error event after text still answers (argv is not claude).
  {
    name: "opencode error event still answers",
    step: { method: "assistant.reply", params: { executor: baseExecutor } },
    answers: { "capability.process.spawn": () => ({ code: 0, timeoutMs: 0, stdout: opencodeCommands("Hello", true), timedOut: false }) },
  },
];

// The spawn call's env is a map of secret refs; drop nothing, but the driver
// records identical spawn params on both sides so no normalization is needed.
const normalize = (t: Transcript): Transcript => t;

describe("assistant-executor parity (TypeScript vs Rust)", () => {
  for (const scenario of scenarios) {
    test.skipIf(!rustArgv("assistant-executor"))(
      `assistant-executor ${scenario.name} reproduces the TS transcript`,
      async () => {
        const { ts, rust } = await parity(
          "assistant-executor",
          [scenario.step],
          scenario.answers,
          {},
          scenario.normalize ?? normalize,
        );
        expect(rust).toEqual(ts);
      },
      30000,
    );
  }
});