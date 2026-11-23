/**
 * Parity scenarios for `pacer-endpoints` (M3 C8): the same scripted host
 * traffic through the TypeScript CLI and the Rust front door must produce
 * identical transcripts (hello, capability-call sequence, step results). The
 * Rust side only runs when PACER_TEST_FRONT_DOOR points at a `pacer` built
 * from this branch; without it the test is skipped.
 *
 * Both `pacer-endpoints` (TS) and `pacer-bundled-endpoints` (Rust) serve
 * `endpoint.models`, `endpoint.launchEnv` and `endpoint.test` through the
 * same capability protocol (`capability.net.http`, `capability.fs.*`,
 * `capability.process.spawn`), so one set of deterministic answers drives both
 * doors to identical transcripts.
 */
import { describe, expect, test } from "bun:test";
import { parity, rustArgv } from "./driver";
import type { Answer, Step } from "./driver";

/** Deterministic answers for one scenario; fs paths tracked in memory. */
function answersFor(): Record<string, Answer> {
  const written: Record<string, string> = {};
  const spawns: Record<string, number> = { git: 0, opencode: 0 };
  return {
    "capability.net.http": (params: any) => {
      if (params.url === "https://acme.example/models") {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            data: [
              { id: "gpt-5", name: "gpt-5", context_length: 128000, max_output_tokens: 8192, tools: true },
            ],
          }),
        };
      }
      if (params.url === "https://forge.example/models") {
        return { status: 404, headers: {}, body: "" };
      }
      return { status: 500, headers: {}, body: "" };
    },
    "capability.fs.write": (params: any) => {
      written[params.path] = params.text;
      return { ok: true };
    },
    "capability.fs.mkdir": () => ({ ok: true }),
    "capability.fs.read": (params: any) => {
      const text = written[`${params.path}`];
      if (params.path.endsWith("/hello.txt")) {
        // The test task writes hello.txt into the disposable repo.
        written[params.path] = "ok";
        return { text: "ok" };
      }
      return text === undefined ? { missing: true } : { text };
    },
    "capability.process.spawn": (params: any) => {
      const argv = params.argv?.join?.(" ") ?? "";
      const kind = argv.startsWith("git ") ? "git" : argv.startsWith("opencode ") ? "opencode" : "other";
      spawns[kind] += 1;
      if (kind === "other") return { code: 1, timedOut: false, stderr: "unexpected" };
      return { code: 0, timedOut: false, stdout: "", stderr: "" };
    },
  };
}

const account = {
  name: "acme",
  baseUrl: "https://acme.example",
  keyRef: "ref-1",
  models: [{ id: "gpt-5", name: "gpt-5", context: 128000, output: 8192, tools: true }],
};

const scenarios: { name: string; steps: Step[] }[] = [
  {
    name: "models listed",
    steps: [
      {
        method: "endpoint.models",
        params: { baseUrl: "https://acme.example", keyRef: "ref-1" },
      },
    ],
  },
  {
    name: "models not listed",
    steps: [
      { method: "endpoint.models", params: { baseUrl: "https://forge.example", keyRef: null } },
    ],
  },
  {
    name: "launchEnv writes config and returns secretEnv",
    steps: [
      {
        method: "endpoint.launchEnv",
        params: {
          pacerHome: "/home/u/.pacer",
          account,
          accounts: [account],
        },
      },
    ],
  },
  {
    name: "launchEnv with no account yields empty secretEnv",
    steps: [
      {
        method: "endpoint.launchEnv",
        params: { pacerHome: "/home/u/.pacer", account: null, accounts: [] },
      },
    ],
  },
  {
    name: "test task ready",
    steps: [
      {
        method: "endpoint.test",
        params: {
          pacerHome: "/home/u/.pacer",
          account,
          accounts: [account],
          runner: { id: "opencode", model: "gpt-5" },
          repository: "/tmp/repo",
          env: { BASE: "1" },
          checkedAt: "2026-01-01",
        },
      },
    ],
  },
];

describe("pacer-endpoints parity (TypeScript vs Rust)", () => {
  for (const scenario of scenarios) {
    test.skipIf(!rustArgv("pacer-endpoints"))(
      `pacer-endpoints ${scenario.name} reproduces the TS transcript`,
      async () => {
        const { ts, rust } = await parity(
          "pacer-endpoints",
          scenario.steps,
          answersFor(),
          {},
        );
        expect(rust).toEqual(ts);
      },
      60000,
    );
  }
});