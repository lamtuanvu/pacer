/** Deterministic TypeScript oracle for the read-only strategy.show operation. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { show } from "../../src/strategy/service";
import { fakeCtx } from "../../test/helpers";

const root = join(import.meta.dir, "../../test/fixtures/strategy-list");
export const goldenPath = join(root, "show-goldens.json");
interface Input { id: string; defaultYaml: string; named?: Record<string, string>; active?: string }

export function recordStrategyShows() {
  const cases = JSON.parse(readFileSync(join(root, "cases.json"), "utf8")) as Input[];
  return cases.flatMap(input => {
    const home = mkdtempSync(join(tmpdir(), "pacer-strategy-show-"));
    try {
      const pacerHome = join(home, ".pacer");
      mkdirSync(join(pacerHome, "strategies"), { recursive: true });
      writeFileSync(join(pacerHome, "strategy.yaml"), input.defaultYaml);
      for (const [name, yaml] of Object.entries(input.named ?? {})) {
        writeFileSync(join(pacerHome, "strategies", `${name}.yaml`), yaml);
      }
      if (input.active) writeFileSync(join(pacerHome, "active"), `${input.active}\n`);
      return ["default", ...Object.keys(input.named ?? {})].map(name => {
        try { return { ...input, name, result: show(fakeCtx({ home, pacerHome }), name) }; }
        catch { return { ...input, name, result: null }; }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== "--check")) {
    console.error("usage: bun scripts/golden/strategy-show.ts [--check]");
    process.exit(2);
  }
  const actual = JSON.stringify(recordStrategyShows(), null, 2) + "\n";
  if (args[0] === "--check") {
    if (readFileSync(goldenPath, "utf8") !== actual) {
      console.error("Strategy show goldens are stale; regenerate and inspect changes");
      process.exit(1);
    }
    console.log("checked TypeScript strategy.show goldens");
  } else {
    writeFileSync(goldenPath, actual);
    console.log("recorded TypeScript strategy.show goldens");
  }
}
