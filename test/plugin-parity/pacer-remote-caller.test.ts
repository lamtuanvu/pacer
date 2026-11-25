/**
 * Parity scenarios for `pacer-remote-caller` (M3 C2): the same scripted host
 * traffic through the TypeScript CLI and the Rust front door must produce
 * identical transcripts (hello, capability-call sequence, step results). The
 * Rust side only runs when PACER_TEST_FRONT_DOOR points at a `pacer` built
 * from this branch; without it the test is skipped (parity is trivially
 * TS == TS).
 */
import { describe, expect, test } from "bun:test";
import { parity, rustArgv } from "./driver";
import type { Answer, Step, Transcript } from "./driver";
import { HostError } from "./driver";

const sessionAnswer: Answer = () => ({ session: "s1" });
const okRun: Answer = () => ({ code: 0, timedOut: false, stdout: "ok", stderr: "" });
const okClose: Answer = () => ({ ok: true });
const okFetch: Answer = () => ({ ok: true });

const scenarios: { name: string; steps: Step[]; answers: Record<string, Answer> }[] = [
  // 1. reachability success
  {
    name: "reachability reachable",
    steps: [{ method: "remoteCaller.reachability", params: { alias: "r1" } }],
    answers: {
      "capability.hosts.open": sessionAnswer,
      "capability.hosts.run": okRun,
      "capability.hosts.close": okClose,
    },
  },
  // 2. reachability unreachable (run code 1)
  {
    name: "reachability unreachable",
    steps: [{ method: "remoteCaller.reachability", params: { alias: "r1" } }],
    answers: {
      "capability.hosts.open": sessionAnswer,
      "capability.hosts.run": () => ({ code: 1, timedOut: false }),
      "capability.hosts.close": okClose,
    },
  },
  // 3. reachability with no alias (open {})
  {
    name: "reachability no alias",
    steps: [{ method: "remoteCaller.reachability", params: {} }],
    answers: {
      "capability.hosts.open": sessionAnswer,
      "capability.hosts.run": okRun,
      "capability.hosts.close": okClose,
    },
  },
  // 4. identity
  {
    name: "identity",
    steps: [
      { method: "remoteCaller.identity", params: { alias: "r1", path: "/a", name: "Ada", email: "a@x" } },
    ],
    answers: {
      "capability.hosts.open": sessionAnswer,
      "capability.hosts.run": okRun,
      "capability.hosts.close": okClose,
    },
  },
  // 5. questionRead
  {
    name: "questionRead",
    steps: [{ method: "remoteCaller.questionRead", params: { alias: "r1", path: "/q" } }],
    answers: {
      "capability.hosts.open": sessionAnswer,
      "capability.hosts.run": okRun,
      "capability.hosts.close": okClose,
    },
  },
  // 6. usageRead with home
  {
    name: "usageRead with home",
    steps: [{ method: "remoteCaller.usageRead", params: { alias: "r1", home: "/home/me" } }],
    answers: {
      "capability.hosts.open": sessionAnswer,
      "capability.hosts.run": okRun,
      "capability.hosts.close": okClose,
    },
  },
  // 7. usageRead without home (args [])
  {
    name: "usageRead no home",
    steps: [{ method: "remoteCaller.usageRead", params: { alias: "r1" } }],
    answers: {
      "capability.hosts.open": sessionAnswer,
      "capability.hosts.run": okRun,
      "capability.hosts.close": okClose,
    },
  },
  // 8. fetch success
  {
    name: "fetch ok",
    steps: [
      { method: "remoteCaller.fetch", params: { alias: "r1", timeoutMs: 5000, maxBytes: 2048 } },
    ],
    answers: {
      "capability.hosts.open": sessionAnswer,
      "capability.hosts.fetch": okFetch,
      "capability.hosts.close": okClose,
    },
  },
  // 9. fetch failure (preserves the original error)
  {
    name: "fetch error",
    steps: [{ method: "remoteCaller.fetch", params: { alias: "r1" } }],
    answers: {
      "capability.hosts.open": sessionAnswer,
      "capability.hosts.fetch": async () => { throw new HostError("net_unreachable", "remote host down"); },
      "capability.hosts.close": okClose,
    },
  },
  // 10. diagnostic.ping (unowned) — normalize the nondeterministic uptime.
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

describe("pacer-remote-caller parity (TypeScript vs Rust)", () => {
  for (const scenario of scenarios) {
    test.skipIf(!rustArgv("pacer-remote-caller"))(
      `pacer-remote-caller ${scenario.name} reproduces the TS transcript`,
      async () => {
        const { ts, rust } = await parity(
          "pacer-remote-caller",
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
