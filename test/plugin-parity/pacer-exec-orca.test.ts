/**
 * Parity scenarios for `pacer-exec-orca` (M3 C5). The driver acts as the host
 * over stdio and answers every `capability.orca.*` call this plugin makes from
 * the per-scenario `answers`, so the TypeScript and Rust processes run the same
 * scripted Orca supervisor traffic. The two transcripts are compared exactly.
 *
 * The Rust side only runs when PACER_TEST_FRONT_DOOR points at a `pacer`
 * built from this branch; without it the test is skipped. The
 * three-lookup uncertain-start loop ultimately depends on wall-clock sleeps and is
 * exercised by the crate harness, not here.
 */
import { describe, expect, test } from "bun:test";
import { parity, rustArgv, type Answer } from "./driver";
import type { Transcript } from "./driver";

/** The ordinary pre-start answers: live unset, provision succeeds. */
function onProvisionOk(): Record<string, Answer> {
  return {
    "capability.orca.liveAnswer": () => ({ kind: "none" }),
    "capability.orca.prepare": () => ({ ok: true }),
    "capability.orca.place": () => ({ ok: true }),
    "capability.orca.terminal": () => ({ ok: true }),
  };
}

const runParams = {
  task: { id: "t1", rev: 1 },
  attempt: 1,
  runDir: 1,
  orca: { executor: "codex", model: null, timeoutMs: 60000 },
};

/** For a zod parse error the JSON-RPC message carries the parser's text, which
 * differs between Node (zod) and Rust. The plan compares only the code. */
const normalize = (t: Transcript): Transcript => {
  const s = structuredClone(t);
  for (const step of s.steps) {
    const data = step.error?.data as { code?: string } | undefined;
    if (data?.code === "internal") step.error!.message = "<parse error>";
  }
  return s;
};

describe("pacer-exec-orca parity (TypeScript vs Rust)", () => {
  test.skipIf(!rustArgv("pacer-exec-orca"))(
    "live fallback returns before prepare",
    async () => {
      const { ts, rust } = await parity(
        "pacer-exec-orca",
        [{ method: "executor.run", params: runParams }],
        { "capability.orca.liveAnswer": () => ({ kind: "fallback", reason: "r" }) },
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-exec-orca"))(
    "live attached worker is supervised without starting",
    async () => {
      const { ts, rust } = await parity(
        "pacer-exec-orca",
        [{ method: "executor.run", params: runParams }],
        {
          "capability.orca.liveAnswer": () => ({ kind: "attached", dispatchId: "d" }),
          "capability.orca.wait": () => ({ kind: "done", outcome: "succeeded", subject: "s", body: "b" }),
          "capability.orca.settle": () => ({ ok: true }),
          "capability.orca.finish": () => ({ final: true }),
        },
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-exec-orca"))(
    "prepare refusal keeps the reason",
    async () => {
      const { ts, rust } = await parity(
        "pacer-exec-orca",
        [{ method: "executor.run", params: runParams }],
        {
          ...onProvisionOk(),
          "capability.orca.prepare": () => ({ ok: false, reason: "r", refuse: true }),
        },
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-exec-orca"))(
    "place failure abandons",
    async () => {
      const { ts, rust } = await parity(
        "pacer-exec-orca",
        [{ method: "executor.run", params: runParams }],
        {
          ...onProvisionOk(),
          "capability.orca.place": () => ({ ok: false, reason: "p" }),
          "capability.orca.abandon": () => ({ reason: "p2" }),
        },
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-exec-orca"))(
    "terminal failure abandons",
    async () => {
      const { ts, rust } = await parity(
        "pacer-exec-orca",
        [{ method: "executor.run", params: runParams }],
        {
          ...onProvisionOk(),
          "capability.orca.terminal": () => ({ ok: false, reason: "t" }),
          "capability.orca.abandon": () => ({ reason: "p2" }),
        },
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-exec-orca"))(
    "refused start abandons with code and message",
    async () => {
      const { ts, rust } = await parity(
        "pacer-exec-orca",
        [{ method: "executor.run", params: runParams }],
        {
          ...onProvisionOk(),
          "capability.orca.start": () => ({ kind: "refused", code: "E1", message: "m" }),
          "capability.orca.abandon": () => ({ reason: "p2" }),
        },
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-exec-orca"))(
    "failed start finishes without waiting, marking agent launch broken",
    async () => {
      const { ts, rust } = await parity(
        "pacer-exec-orca",
        [{ method: "executor.run", params: runParams }],
        {
          ...onProvisionOk(),
          "capability.orca.start": () => ({
            kind: "started", dispatchId: "d", state: "failed",
            stage: "s", failedStage: "agent launch", lastError: "e",
          }),
          "capability.orca.settle": () => ({ ok: true }),
          "capability.orca.finish": () => ({ ok: true, final: true }),
        },
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-exec-orca"))(
    "started worker is waited, settled and finished",
    async () => {
      const { ts, rust } = await parity(
        "pacer-exec-orca",
        [{ method: "executor.run", params: runParams }],
        {
          ...onProvisionOk(),
          "capability.orca.start": () => ({
            kind: "started", dispatchId: "d", state: "ready",
            stage: null, failedStage: null, lastError: null,
          }),
          "capability.orca.wait": () => ({ kind: "done", outcome: "succeeded", subject: "ok", body: "" }),
          "capability.orca.settle": () => ({ ok: true }),
          "capability.orca.finish": () => ({ ok: true, done: true }),
        },
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-exec-orca"))(
    "interactive needs-input keeps the worker alive",
    async () => {
      const interactive = {
        task: { id: "t1", rev: 1 }, attempt: 1, runDir: 1,
        orca: { executor: "codex", model: null, timeoutMs: 60000, session: "interactive" },
      };
      const { ts, rust } = await parity(
        "pacer-exec-orca",
        [{ method: "executor.run", params: interactive }],
        {
          ...onProvisionOk(),
          "capability.orca.start": () => ({
            kind: "started", dispatchId: "d", state: "ready",
            stage: null, failedStage: null, lastError: null,
          }),
          "capability.orca.wait": () => ({ kind: "settled", state: "needs_input", error: null }),
          "capability.orca.finish": () => ({ ok: true, final: true }),
        },
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-exec-orca"))(
    "executor.stop forwards only task and attempt",
    async () => {
      const { ts, rust } = await parity(
        "pacer-exec-orca",
        [{ method: "executor.stop", params: { taskId: "t1", attempt: 1, graceMs: 100 } }],
        { "capability.orca.stop": () => ({ code: 0, killed: true }) },
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-exec-orca"))(
    "executor.stop rejects an out-of-range graceMs (code only)",
    async () => {
      const { ts, rust } = await parity(
        "pacer-exec-orca",
        [{ method: "executor.stop", params: { taskId: "t1", attempt: 1, graceMs: 30000 } }],
        {},
        {},
        normalize,
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-exec-orca"))(
    "executor.sessionState names the orca host",
    async () => {
      const { ts, rust } = await parity(
        "pacer-exec-orca",
        [{ method: "executor.sessionState", params: { taskId: "t1", attempt: 1 } }],
        { "capability.orca.sessionState": () => ({ state: "running", handle: "h" }) },
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-exec-orca"))(
    "executor.available reports status",
    async () => {
      const { ts, rust } = await parity(
        "pacer-exec-orca",
        [{ method: "executor.available", params: {} }],
        { "capability.orca.status": () => ({ ready: true }) },
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );
});