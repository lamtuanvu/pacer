/**
 * Parity scenarios for `pacer-usage` (M3 C7): the same scripted host traffic
 * through the TypeScript CLI and the Rust front door must produce identical
 * transcripts (hello, capability-call sequence, step results). The Rust side
 * only runs when PACER_TEST_FRONT_DOOR points at a `pacer` built from this
 * branch; without it the test is skipped (parity is trivially TS == TS).
 *
 * The driver acts as the host over stdio. Both the TS plugin and the Rust
 * `pacer-bundled-usage` serve `usage.read` through the same capability
 * protocol (`capability.fs.read/stat/list/readRange`, `capability.process.spawn`,
 * `capability.usage.state.*`), so a single set of deterministic answers here
 * drives both doors to identical transcripts.
 */
import { describe, expect, test } from "bun:test";
import { drive, parity, rustArgv } from "./driver";
import type { Answer, Step, Transcript } from "./driver";

/**
 * A deterministic, stateless in-memory filesystem. Both doors read the same
 * byte-identical content and reply with identical FileInfo, so the two
 * transcripts compare equal regardless of which runs first.
 */
interface FileInfo {
  path: string;
  size: number;
  mtimeMs: number;
  inode: number;
  device: number;
}

class FakeFs {
  constructor(private readonly files: Record<string, string>) {}

  info(path: string): FileInfo {
    const size = this.files[path]?.length ?? 0;
    // Fixed, deterministic identity per path (stable across both doors).
    return {
      path,
      size,
      mtimeMs: 1_000_000 + (hash(path) % 1000),
      inode: 1000 + (hash(path) % 500),
      device: 1,
    };
  }

  has(path: string): boolean {
    return path in this.files;
  }

  /** The raw text at `path`, or undefined when absent. */
  content(path: string): string | undefined {
    return this.files[path];
  }

  /** All known paths under the fake fs. */
  paths(): string[] {
    return Object.keys(this.files);
  }
}

/** A tiny FNV-1a so `info` is stable but distinct per path. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Answers for `capability.usage.state.*`: a deterministic, stateless store.
 * `begin` always returns the SAME seed snapshot (an empty codex cursor map, or
 * an empty cache for cached_fetch) so no state leaks from one door's run into
 * the next; both doors observe identical host behavior.
 */
function stateStoreAnswers(seed: string): Record<string, Answer> {
  const seedBytes = Buffer.from(seed, "utf8");
  const staged = { bytes: 0 };
  return {
    "capability.usage.state.begin": () => ({
      lease: "parity-lease",
      bytes: seedBytes.length,
      dirty: false,
    }),
    "capability.usage.state.readChunk": (params: any) => {
      const offset = params.offset ?? 0;
      const chunk = seedBytes.subarray(offset, offset + (params.length ?? 0));
      return { base64: Buffer.from(chunk).toString("base64") };
    },
    "capability.usage.state.stageChunk": (params: any) => {
      const b64 = params.base64 ?? "";
      staged.bytes += Buffer.from(b64, "base64").length;
      return { bytes: staged.bytes };
    },
    "capability.usage.state.commit": () => ({ saved: true }),
    "capability.usage.state.release": () => ({ ok: true }),
  };
}

/** Build the host answers for a run whose fake fs and spawn outputs are fixed. */
function answersFor(fs: FakeFs, spawns: Record<string, string>): Record<string, Answer> {
  const codexSeed = JSON.stringify({ version: 4, files: {} });
  return {
    ...stateStoreAnswers(codexSeed),
    "capability.fs.read": (params: any) => {
      const path = params.path;
      if (!fs.has(path)) return { missing: true };
      return { text: fs.content(path), mtime: fs.info(path).mtimeMs / 1000 };
    },
    "capability.fs.stat": (params: any) => {
      const path = params.path;
      if (!fs.has(path)) return { info: null };
      return { info: fs.info(path) };
    },
    "capability.fs.list": (params: any) => {
      const dir = params.dir;
      const glob = params.glob;
      const files = fs
        .paths()
        .filter((p) => p.startsWith(dir) && matchesGlob(p, glob))
        .map((p) => fs.info(p));
      return { files };
    },
    "capability.fs.readRange": (params: any) => {
      const path = params.path;
      if (!fs.has(path)) return { missing: true };
      const content = fs.content(path)!;
      const bytes = Buffer.from(content, "utf8").subarray(
        params.offset ?? 0,
        (params.offset ?? 0) + (params.length ?? 0),
      );
      return { base64: Buffer.from(bytes).toString("base64"), info: fs.info(path) };
    },
    "capability.process.spawn": (params: any) => {
      const argv = (params.argv ?? []).join(" ");
      return { code: 0, timedOut: false, stdout: spawns[argv] ?? "", stderr: "" };
    },
  };
}

/** Glob-to-regex for the fake fs path suffix (double-star crosses separators). */
function matchesGlob(path: string, glob: string): boolean {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      // `**/` (and trailing `**`) match across separators; single `*` does not.
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") {
          re += "/?";
          i++;
        }
      } else {
        re += "[^/]*";
      }
    } else if ("\\.^$+?()|{}[]".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(re + "$").test(path);
}

const now = 1791633600;

/** usage.read params for claude. */
function claudeStep(files: string[]): Step {
  return {
    method: "usage.read",
    params: {
      provider: "claude-code",
      usage: "quota",
      model: null,
      weeklyTokens: null,
      weeklyUsd: null,
      quotaSource: null,
      now,
      readOnly: true,
      refresh: false,
      resources: { claudeFiles: files, codexSessions: null },
    },
  };
}

const CLAUDE_A = "/home/u/.claude/state/budget/claude.json";
const CLAUDE_B = "/home/u/state/budget/claude.json";

const claudeSnapshot = (capturedAt: number, source: string) =>
  JSON.stringify({
    captured_at: capturedAt,
    source,
    seven_day: { used_percentage: 20, resets_at: now + 3600 },
    five_hour: { used_percentage: 5, resets_at: now + 300 },
  });

// ---- Scenarios ----
const scenarios: {
  name: string;
  steps: Step[];
  answers: Record<string, Answer>;
}[] = [
  // 1. claude no-files: every fs.read returns missing → no rate-limit error.
  {
    name: "claude no-files",
    steps: [claudeStep([CLAUDE_A, CLAUDE_B])],
    answers: answersFor(new FakeFs({}), {}),
  },
  // 2. claude two-files: newest non-future snapshot (B) wins, source session-log.
  {
    name: "claude two-files",
    steps: [claudeStep([CLAUDE_A, CLAUDE_B])],
    answers: answersFor(
      new FakeFs({
        [CLAUDE_A]: claudeSnapshot(now - 10, "status-line"), // older
        [CLAUDE_B]: claudeSnapshot(now - 5, "session-log"), // newer → wins
      }),
      {},
    ),
  },
  // 3. codex small log + append (cursor store): reads the rollout file.
  {
    name: "codex small-log",
    steps: [
      {
        method: "usage.read",
        params: {
          provider: "codex",
          usage: "quota",
          model: null,
          weeklyTokens: null,
          weeklyUsd: null,
          quotaSource: null,
          now: now + 60,
          readOnly: false,
          refresh: false,
          resources: { claudeFiles: [], codexSessions: "/home/u/.codex/sessions" },
        },
      },
    ],
    answers: answersFor(
      new FakeFs({
        "/home/u/.codex/sessions/rollout-a.jsonl":
          JSON.stringify({
            timestamp: now,
            payload: {
              rate_limits: {
                primary: {
                  used_percent: 40,
                  window_minutes: 10080,
                  resets_in_seconds: 3600,
                },
                credits: { has_credits: true, balance: "12.5" },
              },
            },
          }) + "\n",
      }),
      {},
    ),
  },
  // 4. codex-live: refresh forces the app-server probe, stdout id:2.
  {
    name: "codex-live spawn id:2",
    steps: [
      {
        method: "usage.read",
        params: {
          provider: "codex",
          usage: "quota",
          model: null,
          weeklyTokens: null,
          weeklyUsd: null,
          quotaSource: null,
          now,
          readOnly: true,
          refresh: true,
          resources: { claudeFiles: [], codexSessions: null },
        },
      },
    ],
    answers: answersFor(new FakeFs({}), {
      "codex -s read-only -a never app-server": JSON.stringify({
        id: 2,
        result: {
          rateLimits: {
            primary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: now + 7200 },
            secondary: { usedPercent: 10, windowDurationMins: 300, resetsAt: now + 600 },
          },
        },
      }),
    }),
  },
  // 5. arkcli rich: coding-plan subscription with session/weekly/monthly windows.
  {
    name: "arkcli rich",
    steps: [
      {
        method: "usage.read",
        params: {
          provider: "any",
          usage: "quota",
          model: null,
          weeklyTokens: null,
          weeklyUsd: null,
          quotaSource: "arkcli",
          now,
          readOnly: true,
          refresh: true,
          resources: { claudeFiles: [], codexSessions: null },
        },
      },
    ],
    answers: answersFor(new FakeFs({}), {
      "arkcli usage plan --product coding-plan": JSON.stringify({
        items: [
          {
            product: "coding-plan",
            subscribed: true,
            periods: [
              { label: "session", percent: 12, reset_at: now + 100 },
              { label: "weekly", percent: 30, reset_at: now + 200 },
              { label: "monthly", percent: 50, reset_at: "2026-03-31T00:00:00Z" },
            ],
          },
        ],
      }),
    }),
  },
  // 6. metered $: opencode stats with a dollar budget.
  {
    name: "metered dollar budget",
    steps: [
      {
        method: "usage.read",
        params: {
          provider: "opencode#paid",
          usage: "metered",
          model: "public/code",
          weeklyTokens: null,
          weeklyUsd: 100,
          quotaSource: null,
          now,
          readOnly: true,
          refresh: true,
          resources: { claudeFiles: [], codexSessions: null },
        },
      },
    ],
    answers: answersFor(new FakeFs({}), {
      "opencode stats --models --cost --json --days 7": JSON.stringify({
        models: [
          {
            model: { providerID: "public", id: "code" },
            tokens: { input: 10, output: 5, reasoning: 0 },
            cost: 25,
          },
        ],
      }),
    }),
  },
  // 7. reactive.
  {
    name: "reactive",
    steps: [
      {
        method: "usage.read",
        params: {
          provider: null,
          usage: "reactive",
          model: null,
          weeklyTokens: null,
          weeklyUsd: null,
          quotaSource: null,
          now,
          readOnly: true,
          refresh: false,
        },
      },
    ],
    answers: answersFor(new FakeFs({}), {}),
  },
  // 8. unmetered.
  {
    name: "unmetered",
    steps: [
      {
        method: "usage.read",
        params: {
          provider: null,
          usage: "unmetered",
          model: null,
          weeklyTokens: null,
          weeklyUsd: null,
          quotaSource: null,
          now,
          readOnly: true,
          refresh: false,
        },
      },
    ],
    answers: answersFor(new FakeFs({}), {}),
  },
  // 9. unknown provider → no quota source.
  {
    name: "unknown provider",
    steps: [
      {
        method: "usage.read",
        params: {
          provider: "other", // not claude-code / codex / arkcli
          usage: "quota",
          model: null,
          weeklyTokens: null,
          weeklyUsd: null,
          quotaSource: null,
          now,
          readOnly: true,
          refresh: false,
          resources: { claudeFiles: [], codexSessions: null },
        },
      },
    ],
    answers: answersFor(new FakeFs({}), {}),
  },
];

/** A codex rollout with many distinct same-time rate_limits → large result that
 * the plugin streams back via `$/resultChunk` (> 768 KiB). */
function largeRollout(count: number): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    lines.push(
      JSON.stringify({
        timestamp: now,
        payload: {
          rate_limits: {
            primary: { used_percent: (i % 100), window_minutes: 10080, resets_in_seconds: 3600 },
            marker: i, // makes each rate_limits unique → one alternative each
          },
        },
      }),
    );
  }
  // Seed line earlier so the newest window value differs from the alternatives.
  lines.push(
    JSON.stringify({
      timestamp: now - 1,
      payload: {
        rate_limits: { primary: { used_percent: 1, window_minutes: 10080, resets_in_seconds: 3600 } },
      },
    }),
  );
  return lines.join("\n") + "\n";
}

// ---- Large result via $/resultChunk ----
const LARGE = 4800; // >768 KiB once serialized as alternatives
scenarios.push({
  name: "codex large resultChunk",
  steps: [
    {
      method: "usage.read",
      params: {
        provider: "codex",
        usage: "quota",
        model: null,
        weeklyTokens: null,
        weeklyUsd: null,
        quotaSource: null,
        now: now + 60,
        readOnly: false,
        refresh: false,
        resources: { claudeFiles: [], codexSessions: "/home/u/.codex/sessions" },
      },
    },
  ],
  answers: answersFor(
    new FakeFs({
      "/home/u/.codex/sessions/rollout-large.jsonl": largeRollout(LARGE),
    }),
    {},
  ),
});

describe("pacer-usage parity (TypeScript vs Rust)", () => {
  for (const scenario of scenarios) {
    test.skipIf(!rustArgv("pacer-usage"))(
      `pacer-usage ${scenario.name} reproduces the TS transcript`,
      async () => {
        const { ts, rust } = await parity(
          "pacer-usage",
          scenario.steps,
          scenario.answers,
          {},
        );
        expect(rust).toEqual(ts);
      },
      60000,
    );
  }

  // Perf gate: 20x claude parity drives through the Rust door stay under budget.
  test.skipIf(!rustArgv("pacer-usage"))(
    "pacer-usage 20x claude p50/p95 stays under perf budget",
    async () => {
      const argv = rustArgv("pacer-usage")!;
      const answers = answersFor(
        new FakeFs({
          [CLAUDE_A]: claudeSnapshot(now - 10, "status-line"),
          [CLAUDE_B]: claudeSnapshot(now - 5, "session-log"),
        }),
        {},
      );
      const timings: number[] = [];
      for (let i = 0; i < 20; i++) {
        const t0 = performance.now();
        await drive(argv, "pacer-usage", [claudeStep([CLAUDE_A, CLAUDE_B])], answers, {});
        timings.push(performance.now() - t0);
      }
      timings.sort((a, b) => a - b);
      const p50 = timings[Math.floor(timings.length * 0.5)];
      const p95 = timings[Math.floor(timings.length * 0.95)];
      // Perf evidence (gate:m3 perf) recorded for the review report.
      console.log(`pacer-usage 20x claude perf p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms`);
      expect(p95).toBeLessThan(5000);
    },
    120000,
  );
});