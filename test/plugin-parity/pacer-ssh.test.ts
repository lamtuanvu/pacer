/**
 * Parity scenarios for `pacer-ssh` (M3 C11). The driver acts as the host over
 * stdio and answers every `capability.*`/stream request from the per-scenario
 * `answers`, so the TypeScript and Rust processes ported from
 * `plugins/pacer-ssh` run the same scripted host traffic. The two transcripts
 * are compared exactly.
 *
 * `hostRunner.open` returns a random (dashed-less 32-hex) session id that the
 * plugin registers and every later step must reference. `parity` is given a
 * `bind` that copies the session out of the first step's result into the
 * `params.session` of each later step, and `normalizeSession` rewrites every
 * transcript's session value to `"<session>"` so the random ids compare equal.
 *
 * The Rust side only runs when PACER_TEST_FRONT_DOOR points at a `pacer`
 * built from this branch; without it the test is skipped.
 */
import { describe, expect, test } from "bun:test";
import { drive, parity, rustArgv, tsArgv, type Answer, type Step, type StepRecord, type Transcript } from "./driver";

const TARGET = "host.example.com";
const CONTROL = "/tmp/ssh-%r/cm-%C";
const RUN_D = "/home/host/.pacer-remote/runs/t-20261124-000000-abcd/1";
const NONCE = "123e4567-e89b-12d3-a456-426614174000";
const SHA = "a".repeat(64);
const HANDLE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const STREAM_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";

/** A framed spawn answer (`probe_payload` strips the marker). */
const spawnOk: Answer = () => ({ code: 0, stdout: "__PACER_BEGIN__\nok", stderr: "", timedOut: false });

const spawnAnswers: Record<string, Answer> = { "capability.process.spawn": spawnOk };

/**
 * Copy the session id returned by the first `hostRunner.open` step into the
 * `params.session` of each later step, so TS and Rust each reference their own
 * real (random) session id.
 */
function bindSession(step: Step, results: StepRecord[]): Step {
  if (!step.params || typeof step.params !== "object" || !("session" in (step.params as object))) return step;
  const session = (results[0]?.result as { session?: string } | undefined)?.session;
  if (!session) return step;
  return { ...step, params: { ...(step.params as object), session } };
}

/** Replace the random session (dashed-less 32-hex) with `<session>`. */
function normalizeSession(t: Transcript): Transcript {
  const sessions = new Set<string>();
  const collect = (v: unknown): void => {
    if (typeof v === "string") { if (/^[a-f0-9]{32}$/.test(v)) sessions.add(v); return; }
    if (Array.isArray(v)) { for (const item of v) collect(item); return; }
    if (v && typeof v === "object") { for (const value of Object.values(v)) collect(value); }
  };
  for (const s of t.steps) collect(s.result);
  const replace = (v: unknown): unknown => {
    if (typeof v === "string") return sessions.has(v) ? "<session>" : v;
    if (Array.isArray(v)) return v.map(replace);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, value] of Object.entries(v)) out[k] = replace(value);
      return out;
    }
    return v;
  };
  return {
    ...t,
    steps: t.steps.map((s) => ({ ...s, result: s.result === undefined ? undefined : replace(s.result) })),
    calls: t.calls.map((c) => ({ ...c, params: replace(c.params) })),
    notifications: t.notifications.map((n) => ({ ...n, params: replace(n.params) })),
  };
}

/**
 * Like `parity`, but builds a fresh `answers` object per side so a scenario
 * that needs per-drive state (e.g. a scripted read queue) starts clean on
 * each process. Without a front door the Rust side is the TS transcript.
 */
async function parityFresh(
  id: string,
  steps: Step[],
  answerFactory: () => Record<string, Answer>,
  normalize: (t: Transcript) => Transcript = (t) => t,
  bind: (step: Step, results: StepRecord[]) => Step = (s) => s,
): Promise<{ ts: Transcript; rust: Transcript }> {
  const ts = await drive(tsArgv(id), id, steps, answerFactory(), {}, undefined, bind);
  const door = rustArgv(id);
  const rust = door ? await drive(door, id, steps, answerFactory(), {}, undefined, bind) : ts;
  return { ts: normalize(ts), rust: normalize(rust) };
}

describe("pacer-ssh parity (TypeScript vs Rust)", () => {
  test.skipIf(!rustArgv("pacer-ssh"))(
    "check surfaces the probe facts only",
    async () => {
      const facts = "__PACER_BEGIN__\nos=linux\narch=x86_64\nglibc=2.35\ngit=2.39\nsetsid=1\n"
        + "script=1\ntail=1\ncodex=1\nclaude=1\nexists=1\n";
      const { ts, rust } = await parity(
        "pacer-ssh",
        [{ method: "hostRunner.check", params: { alias: "box", sshTarget: TARGET, controlPath: CONTROL } }],
        { "capability.process.spawn": () => ({ code: 0, stdout: facts, stderr: "", timedOut: false }) },
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-ssh"))(
    "open then run the five host-issued scripts",
    async () => {
      const steps: Step[] = [
        { method: "hostRunner.open", params: { alias: "box", sshTarget: TARGET, controlPath: CONTROL } },
        { method: "hostRunner.run", params: { session: "<open>", script: "PROBE", args: [], timeoutMs: 10_000, maxBytes: 4096 } },
        { method: "hostRunner.run", params: { session: "<open>", script: "CHECK_REPO", args: ["~/repo", "check"], timeoutMs: 10_000, maxBytes: 4096 } },
        { method: "hostRunner.run", params: { session: "<open>", script: "SESSION_FILES", args: [RUN_D], timeoutMs: 10_000, maxBytes: 4096 } },
        { method: "hostRunner.run", params: { session: "<open>", script: "READ_FROM", args: [RUN_D, "session.raw", "0", "262144", "hex"], timeoutMs: 10_000, maxBytes: 524_288 } },
        { method: "hostRunner.run", params: { session: "<open>", script: "BINARY", args: [SHA, "check"], timeoutMs: 10_000, maxBytes: 4096 } },
      ];
      const { ts, rust } = await parity("pacer-ssh", steps, spawnAnswers, {}, normalizeSession, bindSession);
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-ssh"))(
    "open then fetch a staged bundle",
    async () => {
      const steps: Step[] = [
        { method: "hostRunner.open", params: { alias: "box", sshTarget: TARGET, controlPath: CONTROL } },
        { method: "hostRunner.fetch", params: { session: "<open>", script: "BUNDLE_OUT", args: [RUN_D, SHA, "pacer/main"], timeoutMs: 30_000, maxBytes: 1_048_576 } },
      ];
      const { ts, rust } = await parity(
        "pacer-ssh",
        steps,
        { "capability.process.stageBundle": () => ({ handle: "12345678-1234-4123-8123-123456789abc", bytes: 15, sha256: SHA }) },
        {},
        normalizeSession,
        bindSession,
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-ssh"))(
    "open then upload and close",
    async () => {
      const steps: Step[] = [
        { method: "hostRunner.open", params: { alias: "box", sshTarget: TARGET, controlPath: CONTROL } },
        { method: "hostRunner.upload", params: { session: "<open>", script: "BINARY", args: [SHA, "upload"], completionNonce: NONCE, timeoutMs: 60_000, maxBytes: 4096 } },
        { method: "hostRunner.close", params: { session: "<open>" } },
      ];
      const { ts, rust } = await parity("pacer-ssh", steps, spawnAnswers, {}, normalizeSession, bindSession);
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-ssh"))(
    "open then stream a deterministic full session",
    async () => {
      const steps: Step[] = [
        { method: "hostRunner.open", params: { alias: "box", sshTarget: TARGET, controlPath: CONTROL } },
        {
          method: "hostRunner.stream",
          params: { session: "<open>", script: "SESSION_PIPE", args: [RUN_D], streamId: STREAM_ID, timeoutMs: 60_000, maxBytes: 65_536 },
        },
      ];
      const readQueue = () => [
        { base64: Buffer.from("login chatter\n__PACER_BE").toString("base64"), eof: false },
        { base64: Buffer.from("GIN__\nhello").toString("base64"), eof: false },
      ];
      const { ts, rust } = await parityFresh(
        "pacer-ssh",
        steps,
        () => {
          const queue = readQueue();
          return {
            "capability.process.duplex.open": () => ({ handle: HANDLE }),
            "capability.process.duplex.read": () => queue.shift() ?? { base64: "", eof: true },
            "capability.process.duplex.close": () => ({ ok: true, code: 0, signal: null, terminated: false }),
            "$/streamAck": (params) => ({ seq: (params as { seq: number }).seq }),
          };
        },
        normalizeSession,
        bindSession,
      );
      expect(rust).toEqual(ts);
      // The deterministic happy path delivers exactly the framed payload bytes.
      const stream = ts.steps[1]?.result as { code?: number; bytes?: number } | undefined;
      expect(stream?.code).toBe(0);
      expect(stream?.bytes).toBe(5);
    },
    30000,
  );
});