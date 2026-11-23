/**
 * Parity scenarios for `pacer-agent-session` (M3 C3): the same scripted host
 * traffic through the TypeScript CLI and the Rust front door must produce
 * identical transcripts for `agentSession.*`. The Rust side only runs when
 * PACER_TEST_FRONT_DOOR points at a `pacer` built from this branch; without it
 * the test is skipped (parity is trivially TS == TS).
 *
 * `identity` for a fresh claude-code session returns `crypto.randomUUID()` in
 * TypeScript and a fresh v4 UUID in Rust: the specific value is
 * nondeterministic, so any `kind: "assigned"` step id is normalized to
 * `"<uuid>"`. Everything else is byte-deterministic, including OpenCode's
 * `reporting.source` (the golden opencode-report template) via a fresh
 * `newSessionId` prepare.
 */
import { describe, expect, test } from "bun:test";
import { parity, rustArgv } from "./driver";
import type { Step, Transcript } from "./driver";

const CODEX_HELP =
  "--config --cd --sandbox --add-dir --model --image --dangerously-bypass-hook-trust --no-daemon";
const CLAUDE_HELP = "--session-id --resume --add-dir --model --settings";
const OPENCODE_HELP = "--standalone --session --prompt";

const IMAGE = { name: "screen.png", mime: "image/png", size: 1, path: "/tmp/files/image" };
const BASE = {
  request: "--dangerous $(echo hi)\n日本語",
  workspace: "/tmp/repo",
  runDir: "/tmp/run",
  attachments: [],
} as const;

const scenarios: { name: string; steps: Step[] }[] = [
  // 1. delegation control: every agent, both opencode major versions.
  {
    name: "delegationControl",
    steps: [
      { method: "agentSession.delegationControl", params: { agent: "claude-code", version: "2.1.281" } },
      { method: "agentSession.delegationControl", params: { agent: "codex", version: "0.166.0" } },
      { method: "agentSession.delegationControl", params: { agent: "cursor", version: "2026.01.28" } },
      { method: "agentSession.delegationControl", params: { agent: "opencode", version: "1.4.0" } },
      { method: "agentSession.delegationControl", params: { agent: "opencode", version: "2.1.2" } },
      { method: "agentSession.delegationControl", params: { agent: "unknown", version: "1" } },
    ],
  },
  // 2. capabilities: token inspection, not substring matching.
  {
    name: "capabilities",
    steps: [
      { method: "agentSession.capabilities", params: { agent: "codex", version: "0.166.0", help: CODEX_HELP } },
      { method: "agentSession.capabilities", params: { agent: "claude-code", version: "2.1.281", help: CLAUDE_HELP } },
      { method: "agentSession.capabilities", params: { agent: "opencode", version: "2.1.2", help: OPENCODE_HELP, apiHelp: OPENCODE_HELP } },
      { method: "agentSession.capabilities", params: { agent: "codex", version: "0.166.0", help: "--config --cd --model --image" } },
      { method: "agentSession.capabilities", params: { agent: "cursor", version: "1" } },
    ],
  },
  // 3. prepare codex: fresh session with a launch image attachment.
  {
    name: "prepare codex fresh image",
    steps: [
      {
        method: "agentSession.prepare",
        params: { ...BASE, agent: "codex", version: "0.166.0", help: CODEX_HELP, model: "chosen", attachmentDir: "/tmp/files", attachments: [{ ...IMAGE }] },
      },
    ],
  },
  // 4. prepare codex: resumed identity, no prompt or attachments.
  {
    name: "prepare codex resume",
    steps: [
      {
        method: "agentSession.prepare",
        params: { ...BASE, agent: "codex", version: "0.166.0", help: CODEX_HELP, resumeHelp: CODEX_HELP, sessionId: "01a15fa2-5a28-7bb0-9b62-6a4434975b55", attachments: [{ ...IMAGE }] },
      },
    ],
  },
  // 5. prepare claude-code: assigned fresh identity via newSessionId.
  {
    name: "prepare claude fresh",
    steps: [
      {
        method: "agentSession.prepare",
        params: { ...BASE, agent: "claude-code", version: "2.1.281", newSessionId: "01a15fa2-5a28-7bb0-9b62-6a4434975b55", model: "sonnet", attachmentDir: "/tmp/files", attachments: [{ ...IMAGE }] },
      },
    ],
  },
  // 6. prepare opencode with a fresh identity: reporting.source must be byte-equal.
  {
    name: "prepare opencode with report",
    steps: [
      {
        method: "agentSession.prepare",
        params: { ...BASE, agent: "opencode", version: "2.1.2", newSessionId: "ses_native", model: "provider/model" },
      },
    ],
  },
  // 7. attachment: codex launch image is native; codex live is a reference.
  {
    name: "attachment",
    steps: [
      { method: "agentSession.attachment", params: { agent: "codex", version: "0.166.0", workspace: "/tmp/repo", phase: "launch", attachment: { ...IMAGE } } },
      { method: "agentSession.attachment", params: { agent: "codex", version: "0.166.0", workspace: "/tmp/repo", phase: "live", attachment: { ...IMAGE } } },
    ],
  },
  // 8. identity: opencode create (with and without model), opencode session.get, codex none.
  {
    name: "identity deterministic",
    steps: [
      { method: "agentSession.identity", params: { agent: "opencode", version: "2.1.2", taskId: "task" } },
      { method: "agentSession.identity", params: { agent: "opencode", version: "2.1.2", taskId: "task", model: "p/m" } },
      { method: "agentSession.identity", params: { agent: "opencode", version: "2.1.2", taskId: "task", sessionId: "ses_exact" } },
      { method: "agentSession.identity", params: { agent: "codex", version: "0.166.0" } },
    ],
  },
  // 9. identity: claude-code assigns a fresh random v4 UUID (normalized to "<uuid>").
  {
    name: "identity claude assigned",
    steps: [
      { method: "agentSession.identity", params: { agent: "claude-code", version: "2.1.281", taskId: "task" } },
      { method: "agentSession.identity", params: { agent: "claude-code", version: "2.1.281", taskId: "task", sessionId: "010f0f8f-2a3b-4c5d-8e9f-0a1b2c3d4e5f" } },
    ],
  },
];

const normalize = (t: Transcript): Transcript => {
  const s = structuredClone(t);
  for (const step of s.steps) {
    const r = step.result;
    if (r && typeof r === "object" && "kind" in (r as Record<string, unknown>) && (r as Record<string, unknown>).kind === "assigned") {
      (r as Record<string, unknown>).id = "<uuid>";
    }
  }
  return s;
};

describe("pacer-agent-session parity (TypeScript vs Rust)", () => {
  for (const scenario of scenarios) {
    test.skipIf(!rustArgv("pacer-agent-session"))(
      `pacer-agent-session ${scenario.name} reproduces the TS transcript`,
      async () => {
        const { ts, rust } = await parity(
          "pacer-agent-session",
          scenario.steps,
          {},
          {},
          normalize,
        );
        expect(rust).toEqual(ts);
      },
      30000,
    );
  }
});