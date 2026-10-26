/** Deterministic TypeScript oracle for the read-only strategy.list operation. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { list } from "../../src/strategy/service";
import { fakeCtx } from "../../test/helpers";

const root = join(import.meta.dir, "../../test/fixtures/strategy-list");
export const goldenPath = join(root, "goldens.json");
interface Input { id: string; defaultYaml: string; named?: Record<string, string>; active?: string }

export function recordStrategyLists() {
  const cases = JSON.parse(readFileSync(join(root, "cases.json"), "utf8")) as Input[];
  return cases.map(input => {
    const home = mkdtempSync(join(tmpdir(), "pacer-strategy-list-"));
    try {
      const pacerHome = join(home, ".pacer");
      mkdirSync(join(pacerHome, "strategies"), { recursive: true });
      writeFileSync(join(pacerHome, "strategy.yaml"), input.defaultYaml);
      for (const [name, yaml] of Object.entries(input.named ?? {})) {
        writeFileSync(join(pacerHome, "strategies", `${name}.yaml`), yaml);
      }
      if (input.active) writeFileSync(join(pacerHome, "active"), `${input.active}\n`);
      return { ...input, result: list(fakeCtx({ home, pacerHome })) };
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== "--check")) {
    console.error("usage: bun scripts/golden/strategy-list.ts [--check]");
    process.exit(2);
  }
  const actual = JSON.stringify(recordStrategyLists(), null, 2) + "\n";
  if (args[0] === "--check") {
    if (readFileSync(goldenPath, "utf8") !== actual) {
      console.error("Strategy list goldens are stale; regenerate and inspect changes");
      process.exit(1);
    }
    console.log("checked TypeScript strategy.list goldens");
  } else {
    writeFileSync(goldenPath, actual);
    console.log("recorded TypeScript strategy.list goldens");
  }
}
