/**
 * Golden recorder for the `status --line` port (T3 step 1).
 *
 * Builds a deterministic list of status-line inputs — the UI snapshot fixture and
 * the variants covered by test/render-line.test.ts, plus the `Status`-shaped
 * (`generatedAt`-present) path — and records, for each, the rendered line and
 * the raw fields at widths 120/60/40/20 with color on and off.
 *
 * Output: crates/cli/tests/golden/status-line.json (deterministic).
 * The Rust port (crates/cli/src/status_line) must reproduce these byte for byte.
 *
 * Run with TZ=Asia/Ho_Chi_Minh:
 *   TZ=Asia/Ho_Chi_Minh bun scripts/golden/status-line.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lineFields, renderLine } from "../../src/render/line";
import type { ClientSnapshot } from "../../src/view-model/snapshot";
import type { Status } from "../../src/engine/status";
import fixture from "../../test/fixtures/ui/snapshot.json";

const repoRoot = join(import.meta.dir, "..", "..");
const outDir = join(repoRoot, "crates", "cli", "tests", "golden");
export const statusLineGoldenPath = join(outDir, "status-line.json");
const outPath = statusLineGoldenPath;

const snapshot = () => structuredClone(fixture) as ClientSnapshot;
const planner = (s: ClientSnapshot) => s.planner!;
const counts = (s: ClientSnapshot) => s.counts!;

/** UI snapshot fixture (default). */
const base = snapshot();

/** Null planner usage → "usage unknown". */
const nullUsage = snapshot();
planner(nullUsage).usedPct = null;
planner(nullUsage).pacePct = null;

/** Mode only when non-normal; needs nothing at zero attention. */
const relaxed = snapshot();
planner(relaxed).mode = "relaxed";
counts(relaxed).attention = 0;

/** Verdict ahead → warn tick, "ahead" caption. */
const ahead = snapshot();
planner(ahead).verdict = "ahead";

/** Verdict out, still with resetsAt → "out · back …". */
const outWithResets = snapshot();
planner(outWithResets).verdict = "out";

/** Verdict out without resetsAt → "out · back reset unknown". */
const outNoResets = snapshot();
planner(outNoResets).verdict = "out";
planner(outNoResets).resetsAt = null;

/** Codex uses its shared identity and colour. */
const codex = snapshot();
planner(codex).agent = "codex";

/** Invalid counts stay unknown. */
const invalidCounts = snapshot();
counts(invalidCounts).running = -1;
counts(invalidCounts).attention = NaN;

/** `Status`-shaped input: the `generatedAt`-present branch of lineFields.
 *  Mirrors the snapshot scenario for the installed agent status-bar capture path. */
// Recorded as a loose, older Status shape on purpose: the renderer must tolerate it.
const statusInput = {
  generatedAt: 1800000000,
  strategy: "default",
  planner: "claude-code",
  mode: "normal",
  disabled: false,
  paused: null,
  modeHold: null,
  calendarPace: true,
  providers: [
    {
      id: "claude-code", agent: "claude-code", usage: "quota", installed: true, stale: false,
      verdict: "behind", windows: [],
      binding: { usedPct: 63, pace: 77, resetsAt: 1800259200, name: "weekly", lengthS: 604800, paced: true, source: "native", capturedAt: 1800000000 },
    },
  ],
  executors: { ranked: [], excluded: [] },
} as unknown as Status;

interface Input { label: string; value: ClientSnapshot | Status | null }
const inputs: Input[] = [
  { label: "fixture", value: base },
  { label: "null-usage", value: nullUsage },
  { label: "relaxed-zero-attention", value: relaxed },
  { label: "verdict-ahead", value: ahead },
  { label: "verdict-out-with-resetsAt", value: outWithResets },
  { label: "verdict-out-no-resetsAt", value: outNoResets },
  { label: "codex-agent", value: codex },
  { label: "invalid-counts", value: invalidCounts },
  { label: "null-input", value: null },
  { label: "status-shaped", value: statusInput },
];

const widths = [120, 60, 40, 20];
const colors = [true, false];

/** The golden cases, as the TypeScript renderer produces them now. */
export function recordStatusLine(): unknown[] {
  const cases: unknown[] = [];
  for (const { value } of inputs) {
    const fields = lineFields(value);
    for (const width of widths) {
      for (const color of colors) {
        cases.push({ input: value, width, color, out: renderLine(value, { width, color }), fields });
      }
    }
  }
  return cases;
}

if (import.meta.main) {
  const cases = recordStatusLine();
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, JSON.stringify(cases, null, 1) + "\n");
  console.log(`wrote ${cases.length} cases to ${outPath}`);
}
