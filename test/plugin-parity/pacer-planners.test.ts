/**
 * Parity scenarios for `pacer-planners` (M3 C12b). The driver acts as the host
 * over stdio and answers every `capability.*` request from the per-scenario
 * `answers`, so the TypeScript and Rust processes run the same planner traffic.
 * The Rust side only runs when `PACER_TEST_FRONT_DOOR` points at a `pacer`
 * built from this branch; without it the test compares the TS transcript to
 * itself.
 */
import { describe, expect, test } from "bun:test";
import { parity, rustArgv, type Answer, type Step } from "./driver";

const ID = "pacer-planners";
const HOME = "/home/test";
const FOLDER = "/home/test/.codex";

const answers: Record<string, Answer> = {
  "capability.fs.read": () => ({ missing: true }),
  "capability.fs.list": () => ({ files: [] }),
  "capability.planner.run": () => ({ code: 0, stdout: "", stderr: "" }),
  "capability.process.spawn": () => ({
    code: 0,
    stdout: "claude-code 2.1.0 (Claude Code)",
    stderr: "",
  }),
};

const env = {
  now: 1700000000,
  pacerArgv: ["/usr/local/bin/pacer"],
  folder: FOLDER,
  plannerKey: "codex-key",
  configEnv: {},
  mcp: false,
};

describe("pacer-planners parity (TypeScript vs Rust)", () => {
  const detect: Step = {
    method: "planner.detect",
    params: {
      agent: "claude-code",
      binary: { path: "/usr/local/bin/claude", name: "claude" },
      probe: { argv: ["/usr/local/bin/claude", "--version"], timeoutMs: 5000 },
    },
  };
  const check: Step = {
    method: "planner.check",
    params: {
      files: [
        { path: "/home/test/.codex/AGENTS.md", action: "edited", afterHash: null, undo: [{ kind: "block", style: "md" }] },
      ],
    },
  };
  const preview: Step = {
    method: "planner.preview",
    params: { agent: "codex", home: HOME, env, prior: null },
  };
  const plan: Step = {
    method: "planner.plan",
    params: {
      agent: "codex",
      home: HOME,
      binary: null,
      env,
      prior: null,
    },
  };

  test("detect / check / preview / plan transcripts match", async () => {
    const { ts, rust } = await parity(ID, [detect, check, preview, plan], answers, {
      features: ["plannerInstallTransactions", "chunkedResults"],
    });
    expect(ts.exit).toBe(0);
    expect(ts.steps.length).toBe(4);

    const detected = ts.steps[0]!.result as Record<string, unknown>;
    expect(detected.version).toBe("2.1.0");
    expect(detected.found).toBe(true);
    expect(detected.install_hint).toBe("npm install -g @anthropic-ai/claude-code");

    const checked = ts.steps[1]!.result as Record<string, unknown>;
    expect(Array.isArray(checked.files)).toBe(true);

    const previewed = ts.steps[2]!.result as Record<string, unknown>;
    expect(previewed.undo).toBe("pacer uninstall codex-key");
    expect((previewed.changes as unknown[]).length).toBeGreaterThan(0);

    const planned = ts.steps[3]!.result as Record<string, unknown>;
    expect(Array.isArray(planned.files)).toBe(true);
    expect(Array.isArray((planned.record as Record<string, unknown>).files)).toBe(true);

    expect(rust).toEqual(ts);
  });

  test.skipIf(!rustArgv(ID))("Rust front door is byte-exact on the same scenario", async () => {
    const { ts, rust } = await parity(ID, [detect, check, preview, plan], answers);
    expect(rust).toEqual(ts);
  });
});
