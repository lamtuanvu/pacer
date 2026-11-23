/**
 * Parity scenarios for `pacer-notify` (M3 C1): the same scripted host traffic
 * through the TypeScript CLI and the Rust front door must produce identical
 * transcripts (hello, capability-call sequence, step results). The Rust side
 * only runs when PACER_TEST_FRONT_DOOR points at a `pacer` built from this
 * branch; without it the test is skipped (parity is trivially TS == TS).
 */
import { describe, expect, test } from "bun:test";
import { parity, rustArgv } from "./driver";
import type { Answer, Step, Transcript } from "./driver";

const note = { key: "task:owned:1", title: "Task done", body: "fix login", url: "/app/#/review/owned" };

function configAnswer(platform: string): Answer {
  return () => ({ config: { platform, which: { osascript: "/untrusted/override" }, binary: "/untrusted/override" } });
}
const okSpawn: Answer = () => ({ code: 0, timedOut: false, stdout: "", stderr: "" });

const scenarios: { name: string; steps: Step[]; answers: Record<string, Answer>; hello?: { config?: unknown } }[] = [
  // 1. darwin deliver
  {
    name: "darwin deliver",
    steps: [{ method: "notifier.deliver", params: note }],
    answers: {
      "capability.config.get": configAnswer("darwin"),
      "capability.process.spawn": okSpawn,
    },
  },
  // 2. linux deliver
  {
    name: "linux deliver",
    steps: [{ method: "notifier.deliver", params: note }],
    answers: {
      "capability.config.get": configAnswer("linux"),
      "capability.process.spawn": okSpawn,
    },
  },
  // 3. win32 (unsupported platform: no spawn)
  {
    name: "win32",
    steps: [{ method: "notifier.deliver", params: note }],
    answers: {
      "capability.config.get": configAnswer("win32"),
    },
  },
  // 4. spawn {code:1}
  {
    name: "spawn code 1",
    steps: [{ method: "notifier.deliver", params: note }],
    answers: {
      "capability.config.get": configAnswer("linux"),
      "capability.process.spawn": () => ({ code: 1, timedOut: false }),
    },
  },
  // 5. spawn error — the answer rejects asynchronously so the driver can convert
  // it into a proper error reply (a synchronous throw would escape the driver's
  // uncaught handler and the capability call would never receive a reply).
  {
    name: "spawn error",
    steps: [{ method: "notifier.deliver", params: note }],
    answers: {
      "capability.config.get": configAnswer("darwin"),
      "capability.process.spawn": async () => { throw new Error("spawn exploded"); },
    },
  },
  // 6. params null (invalid input)
  {
    name: "params null",
    steps: [{ method: "notifier.deliver", params: null }],
    answers: {
      "capability.config.get": configAnswer("darwin"),
    },
  },
  // 7. config.get error — async reject (see scenario 5).
  {
    name: "config.get error",
    steps: [{ method: "notifier.deliver", params: note }],
    answers: {
      "capability.config.get": async () => { throw new Error("config unavailable"); },
    },
  },
  // 8. diagnostic.ping (unowned) — normalize the nondeterministic uptime.
  {
    name: "diagnostic.ping",
    steps: [{ method: "diagnostic.ping", params: {}, unowned: true }],
    answers: {},
  },
];

const normalize = (t: Transcript): Transcript => {
  const s = structuredClone(t);
  for (const step of s.steps) {
    if (
      step.result &&
      typeof step.result === "object" &&
      step.result !== null &&
      "uptimeS" in (step.result as Record<string, unknown>)
    ) {
      (step.result as Record<string, unknown>).uptimeS = 0;
    }
  }
  return s;
};

describe("pacer-notify parity (TypeScript vs Rust)", () => {
  for (const scenario of scenarios) {
    test.skipIf(!rustArgv("pacer-notify"))(
      `pacer-notify ${scenario.name} reproduces the TS transcript`,
      async () => {
        const { ts, rust } = await parity(
          "pacer-notify",
          scenario.steps,
          scenario.answers,
          {},
          normalize,
        );
        expect(rust).toEqual(ts);
      },
      30000,
    );
  }
});