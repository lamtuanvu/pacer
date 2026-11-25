/**
 * Golden texts for the Rust planners port (M3 C12b), transcribed from the
 * TypeScript installer so the Rust `tests/fixtures/texts.json` is byte-equal.
 * Run without flags to regenerate, with `--check` to verify.
 */
import { PACER_SKILL } from "../../examples/plugins/pacer-planners/skill";
import { codexMcpBlock } from "../../examples/plugins/pacer-planners/codex";
import {
  editClaudeSettings,
  editStatuslineScript,
} from "../../examples/plugins/pacer-planners/claude";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");
const target = resolve(
  root,
  "plugins-rs",
  "pacer-planners",
  "tests",
  "fixtures",
  "texts.json",
);

const ARGV = ["/usr/local/bin/pacer", "--account", "team"];
const command = ARGV.join(" ");

/** The golden set. Every value is compared byte-for-byte by the Rust tests. */
export function texts(): Record<string, string> {
  return {
    pacerSkill: PACER_SKILL,
    codexMcpBlock: codexMcpBlock(ARGV),
    statuslineScript: editStatuslineScript(
      '#!/bin/sh\ninput=$(cat)\nexit 0\n',
      command,
    )!,
    claudeSettings: editClaudeSettings(
      null,
      {
        session: `${command} msg hook session --planner claude-code`,
        stop: `${command} msg hook stop --planner claude-code`,
        prompt: `${command} msg hook prompt --planner claude-code`,
        guard: `${command} guard --planner claude-code`,
        statusline: `${command} statusline`,
      },
      "/home/test",
    ).text,
  };
}

if (import.meta.main) {
  const body = JSON.stringify(texts(), null, 2) + "\n";
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(target, "utf8");
    } catch {
      current = "<missing>";
    }
    if (current !== body) {
      console.error(`stale: ${target}`);
      process.exit(1);
    }
    console.log("planner texts OK");
  } else {
    writeFileSync(target, body);
    console.log(`wrote ${target}`);
  }
}

// Keep dirname referenced for parity with the other generators' shape.
void dirname;
