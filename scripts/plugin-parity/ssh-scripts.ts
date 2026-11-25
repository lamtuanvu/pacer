/**
 * Script-bundle generator for `pacer-bundled-ssh` (M3 C11).
 *
 * Imports the TypeScript `*_SCRIPT` template literals from
 * `plugins/pacer-ssh/probe.ts` and writes `plugins-rs/pacer-ssh/tests/
 * fixtures/scripts.json` as a JSON object keyed by the script name
 * (`PROBE`, `CHECK_REPO`, …), byte-equal to the Rust `*_SCRIPT` consts.
 * The JSON string values are the runtime script text (`\\n` → `\n`), so the
 * Rust side can execute the exact program the host pins; `scripts_golden.rs`
 * asserts the key set, and `scripts_exec.rs` runs the values.
 *
 * Never hand-edit the generated file; run this script (or `bun run scripts/
 * plugin-parity/ssh-scripts.ts --check`) after changing a script.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  PROBE_SCRIPT,
  CHECK_REPO_SCRIPT,
  BUNDLE_OUT_SCRIPT,
  PREFLIGHT_SCRIPT,
  SET_IDENTITY_SCRIPT,
  CLEAN_SCRIPT,
  STOP_SCRIPT,
  PREPARE_SCRIPT,
  PREPARE_RECOVER_SCRIPT,
  REPORT_SCRIPT,
  SESSION_FILES_SCRIPT,
  START_SCRIPT,
  READ_FROM_SCRIPT,
  BINARY_SCRIPT,
  SESSION_PIPE_SCRIPT,
  QUESTION_SCRIPT,
  CODEX_USAGE_SCRIPT,
} from "../../examples/plugins/pacer-ssh/probe";

const repoRoot = resolve(import.meta.dir, "..", "..");
const fixture = resolve(repoRoot, "plugins-rs", "pacer-ssh", "tests", "fixtures", "scripts.json");

/** The exact script key order, matching `scripts_golden.rs` `SCRIPT_KEYS`. */
const keys = [
  "PROBE",
  "CHECK_REPO",
  "BUNDLE_OUT",
  "PREFLIGHT",
  "SET_IDENTITY",
  "CLEAN",
  "STOP",
  "PREPARE",
  "PREPARE_RECOVER",
  "REPORT",
  "SESSION_FILES",
  "START",
  "READ_FROM",
  "BINARY",
  "SESSION_PIPE",
  "QUESTION",
  "CODEX_USAGE",
] as const;

const scripts: Record<string, string> = {
  PROBE: PROBE_SCRIPT,
  CHECK_REPO: CHECK_REPO_SCRIPT,
  BUNDLE_OUT: BUNDLE_OUT_SCRIPT,
  PREFLIGHT: PREFLIGHT_SCRIPT,
  SET_IDENTITY: SET_IDENTITY_SCRIPT,
  CLEAN: CLEAN_SCRIPT,
  STOP: STOP_SCRIPT,
  PREPARE: PREPARE_SCRIPT,
  PREPARE_RECOVER: PREPARE_RECOVER_SCRIPT,
  REPORT: REPORT_SCRIPT,
  SESSION_FILES: SESSION_FILES_SCRIPT,
  START: START_SCRIPT,
  READ_FROM: READ_FROM_SCRIPT,
  BINARY: BINARY_SCRIPT,
  SESSION_PIPE: SESSION_PIPE_SCRIPT,
  QUESTION: QUESTION_SCRIPT,
  CODEX_USAGE: CODEX_USAGE_SCRIPT,
};

/** Pretty-printed script-bundle text, written and asserted byte-equal. */
function bundleText(): string {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = scripts[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`script key ${key} is empty or missing`);
    }
    out[key] = value;
  }
  return JSON.stringify(out, null, 2) + "\n";
}

function check(): string[] {
  if (!existsSync(fixture) || readFileSync(fixture, "utf8") !== bundleText()) {
    return [fixture];
  }
  return [];
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    const stale = check();
    for (const path of stale) console.error(`stale: ${path}`);
    if (stale.length > 0) process.exit(1);
  } else {
    writeFileSync(fixture, bundleText());
    console.log(`wrote ${fixture}`);
  }
}