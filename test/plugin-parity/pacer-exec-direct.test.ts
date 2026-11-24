/**
 * Parity scenarios for `pacer-exec-direct` (M3 C10). The driver acts as the
 * host over stdio and answers every `capability.*` call this plugin makes from
 * the per-scenario `answers`, so the TypeScript and Rust processes run the same
 * scripted direct-executor traffic. The two transcripts are compared exactly.
 *
 * The Rust side only runs when PACER_TEST_FRONT_DOOR points at a `pacer`
 * built from this branch; without it the test is skipped. Owned scenarios
 * use a first-poll exit so no real 200 ms sleep occurs, and `attempt.endedAt`
 * (wall clock) is normalized to `<time>` after asserting it is within ±60 s
 * of the test start.
 */
import { describe, expect, test } from "bun:test";
import { parity, rustArgv, type Answer } from "./driver";
import type { Transcript } from "./driver";

/** A role-shaped RFC-rev valid UUID for output handles. */
const UUID = "123e4567-e89b-12d3-a456-426614174000";

const effect = (extra: Record<string, unknown> = {}) => ({
  task: { id: "t1", rev: 1 },
  attempt: 1,
  runDir: 1,
  effect: { argv: ["codex", "exec"], cwd: "/w", timeoutMs: 1000, ...extra },
});

/** For zod parse errors the JSON-RPC message reflects the parser's text, which
 * differs between Node (zod) and Rust. The plan compares only the code. */
const normalizeParse = (t: Transcript): Transcript => {
  const s = structuredClone(t);
  for (const step of s.steps) {
    const data = step.error?.data as { code?: string } | undefined;
    if (data?.code === "internal") step.error!.message = "<parse error>";
  }
  return s;
};

/** `attempt.endedAt` is the wall clock; normalize it after sanity-checks. */
const normalizeTime = (t: Transcript): Transcript => {
  const s = structuredClone(t);
  const start = Date.now();
  for (const step of s.steps) {
    const a = (step.result as any)?.attempt;
    if (a && typeof a.endedAt === "number") {
      expect(Math.abs(a.endedAt * 1000 - start)).toBeLessThan(60_000);
      a.endedAt = "<time>";
    }
  }
  return normalizeParse(s);
};

const spawnOk: Record<string, Answer> = {
  "capability.process.spawn": () => ({ code: 0, timedOut: false, stderr: "" }),
};

describe("pacer-exec-direct parity (TypeScript vs Rust)", () => {
  test.skipIf(!rustArgv("pacer-exec-direct"))(
    "direct effect spawns the exact issued process",
    async () => {
      const { ts, rust } = await parity(
        "pacer-exec-direct",
        [{ method: "executor.run", params: effect({ env: { A: "1" }, secretEnv: { K: "secrets:k" } }) }],
        { ...spawnOk },
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-exec-direct"))(
    "stdin is forwarded only when present",
    async () => {
      const { ts, rust } = await parity(
        "pacer-exec-direct",
        [{ method: "executor.run", params: effect({ stdin: "2+2" }) }],
        { ...spawnOk },
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-exec-direct"))(
    "a nonzero exit reports the first 1024 stderr units",
    async () => {
      const { ts, rust } = await parity(
        "pacer-exec-direct",
        [{ method: "executor.run", params: effect() }],
        { "capability.process.spawn": () => ({ code: 2, timedOut: false, stderr: "e".repeat(3000) }) },
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-exec-direct"))(
    "output handles read the first stderr chunk by id",
    async () => {
      const { ts, rust } = await parity(
        "pacer-exec-direct",
        [{ method: "executor.run", params: effect() }],
        {
          "capability.process.spawn": () => ({
            code: 0, timedOut: false,
            output: { stdout: UUID, stderr: UUID },
          }),
          "capability.process.outputChunk": () => ({ base64: "c29tZSByZW1vdGUgZmVlZGJhY2s=" }),
        },
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-exec-direct"))(
    "a timed out run is failed",
    async () => {
      const { ts, rust } = await parity(
        "pacer-exec-direct",
        [{ method: "executor.run", params: effect() }],
        { "capability.process.spawn": () => ({ code: 0, timedOut: true, stderr: "" }) },
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-exec-direct"))(
    "a detached effect launches a run",
    async () => {
      const { ts, rust } = await parity(
        "pacer-exec-direct",
        [{ method: "executor.run", params: effect({ detached: true }) }],
        { "capability.process.startRun": () => ({ pid: 42 }) },
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-exec-direct"))(
    "an invalid effect is refused",
    async () => {
      const { ts, rust } = await parity(
        "pacer-exec-direct",
        [{ method: "executor.run", params: { task: { id: "t1", rev: 1 }, attempt: 1, runDir: 1 } }],
        {},
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-exec-direct"))(
    "a bad spawn result is internal (code only)",
    async () => {
      const { ts, rust } = await parity(
        "pacer-exec-direct",
        [{ method: "executor.run", params: effect() }],
        {
          "capability.process.spawn": () => ({
            code: 0, timedOut: false,
            output: { stdout: "x", stderr: UUID },
          }),
        },
        {},
        normalizeParse,
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-exec-direct"))(
    "stop forwards to the local capability",
    async () => {
      const { ts, rust } = await parity(
        "pacer-exec-direct",
        [{ method: "executor.stop", params: { taskId: "t1", attempt: 1, graceMs: 100 } }],
        { "capability.process.stopRun": () => ({ code: 0, killed: true }) },
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-exec-direct"))(
    "stop forwards to the remote capability",
    async () => {
      const { ts, rust } = await parity(
        "pacer-exec-direct",
        [{ method: "executor.stop", params: { taskId: "t1", attempt: 1, graceMs: 100, remote: true } }],
        { "capability.hosts.stopOwned": () => ({ code: 0, killed: true }) },
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-exec-direct"))(
    "stop rejects an out-of-range graceMs (code only)",
    async () => {
      const { ts, rust } = await parity(
        "pacer-exec-direct",
        [{ method: "executor.stop", params: { taskId: "t1", attempt: 1, graceMs: 25001 } }],
        {},
        {},
        normalizeParse,
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-exec-direct"))(
    "sessionState names the builtin host",
    async () => {
      const { ts, rust } = await parity(
        "pacer-exec-direct",
        [{ method: "executor.sessionState", params: { taskId: "t1", attempt: 1 } }],
        { "capability.process.inspectRun": () => ({ state: "running" }) },
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-exec-direct"))(
    "available is true",
    async () => {
      const { ts, rust } = await parity(
        "pacer-exec-direct",
        [{ method: "executor.available", params: {} }],
        {},
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-exec-direct"))(
    "owned claim-start-first-poll-exit outcome",
    async () => {
      const { ts, rust } = await parity(
        "pacer-exec-direct",
        [{
          method: "executor.run",
          params: {
            task: { id: "t-fixture", rev: 2 }, attempt: 1, runDir: 1,
            owned: { placement: "current", timeoutMs: 5000, executor: "codex", model: null },
          },
        }],
        {
          "capability.process.claimRun": () => ({
            task: { id: "t-fixture", rev: 3 }, attempt: 1, runDir: 1,
            dir: "/tmp/owned/1", workdir: "/tmp/repo", startedAt: 100,
            logFile: "/tmp/owned/1/stdout",
          }),
          "capability.process.startRun": () => ({ pid: 42 }),
          "capability.process.pollRun": () => ({ state: "exited", exitCode: 0 }),
          "capability.process.readRunOutput": () => ({
            stdoutBase64: Buffer.from("fixture complete\n").toString("base64"),
            stderrBase64: "",
          }),
        },
        {},
        normalizeTime,
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-exec-direct"))(
    "remote happy path",
    async () => {
      const { ts, rust } = await parity(
        "pacer-exec-direct",
        [{
          method: "executor.run",
          params: {
            task: { id: "t-fixture", rev: 2 }, attempt: 1, runDir: 1,
            remote: { timeoutMs: 5000, executor: "codex@box", model: null },
          },
        }],
        {
          "capability.hosts.prepareOwned": () => ({ worktree: "/home/x/worktree", branch: "pacer/t-fixture" }),
          "capability.hosts.claimOwned": () => ({ startedAt: 100, logFile: "/tmp/owned/1/stdout" }),
          "capability.hosts.startOwned": () => ({ pid: 42 }),
          "capability.hosts.pollOwned": () => ({ state: "exited", exitCode: 0 }),
          "capability.hosts.readOwnedOutput": () => ({
            stdoutBase64: Buffer.from("remote complete\n").toString("base64"),
            stderrBase64: "",
          }),
          "capability.hosts.transferOwned": () => ({ transferred: false }),
        },
        {},
        normalizeTime,
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );
});