/** Deterministic TypeScript oracle for M2 strategy YAML parse and validation. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StrategyError, validateStrategy } from "../../src/config/strategy";

interface Input { id: string; yaml: string; name?: string }
export interface StrategyLoadGolden extends Input {
  path: string;
  result?: Record<string, unknown>;
  error?: { kind: "yaml" | "strategy"; message: string; problems?: string[] };
}
const fixtureDir = join(import.meta.dir, "../../test/fixtures/strategy-load");
export const strategyLoadGoldenPath = join(fixtureDir, "goldens.json");

export function recordStrategyLoads(): StrategyLoadGolden[] {
  const cases = JSON.parse(readFileSync(join(fixtureDir, "cases.json"), "utf8")) as Input[];
  return cases.map(input => {
    const path = "$HOME/strategy.yaml";
    const output: StrategyLoadGolden = { ...input, path };
    let raw: unknown;
    try { raw = Bun.YAML.parse(input.yaml); }
    catch (error) {
      output.error = { kind: "yaml", message: error instanceof Error ? error.message : String(error) };
      return output;
    }
    try {
      output.result = JSON.parse(JSON.stringify(validateStrategy(raw, path, input.name ?? "default"))) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof StrategyError) output.error = { kind: "strategy", message: error.message, problems: error.problems };
      else throw error;
    }
    return output;
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== "--check")) {
    console.error("usage: bun scripts/golden/strategy-load.ts [--check]");
    process.exit(2);
  }
  const actual = JSON.stringify(recordStrategyLoads(), null, 2) + "\n";
  if (args[0] === "--check") {
    if (readFileSync(strategyLoadGoldenPath, "utf8") !== actual) {
      console.error("Strategy load goldens are stale; regenerate and inspect changes");
      process.exit(1);
    }
    console.log("checked TypeScript strategy load/validation goldens (Rust parity unverified)");
  } else {
    writeFileSync(strategyLoadGoldenPath, actual);
    console.log("recorded TypeScript strategy load/validation goldens");
  }
}
