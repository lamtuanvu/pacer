/** TypeScript oracle for named strategy removal and refusal behavior. */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callOp } from "../../src/api/ops";
import { fakeCtx } from "../../test/helpers";

const root = join(import.meta.dir, "../../test/fixtures/strategy-remove");
export const goldenPath = join(root, "goldens.json");
const defaultYaml = "# Main work\nplanner: codex\naccounts: {personal: {kind: codex}}\nrouting: [{default: [codex]}]\n";
const researchYaml = "# Research mode\nplanner: codex\naccounts: {personal: {kind: codex}}\npacing: {policy: even, planner_reserve: 25}\nrouting: [{default: [codex]}]\n";

function jsonLines(path: string): unknown[] {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, key === "id" && typeof item === "string" && /^1700000000-/.test(item) ? "<activity-id>" : normalize(item)]));
  return value;
}

export async function recordStrategyRemove() {
  const cases = [
    { id: "inactive-named", initial: "default", target: "research" },
    { id: "active-named", initial: "research", target: "research" },
    { id: "default-protected", initial: "default", target: "default" },
    { id: "missing-named", initial: "default", target: "missing" },
  ] as const;
  const output = [];
  for (const input of cases) {
    const home = mkdtempSync(join(tmpdir(), "pacer-strategy-remove-"));
    try {
      const pacerHome = join(home, ".pacer");
      mkdirSync(join(pacerHome, "strategies"), { recursive: true });
      writeFileSync(join(pacerHome, "strategy.yaml"), defaultYaml);
      writeFileSync(join(pacerHome, "strategies/research.yaml"), researchYaml);
      if (input.initial === "research") writeFileSync(join(pacerHome, "active"), "research\n");
      const ctx = fakeCtx({ home, pacerHome, now: 1_700_000_000 });
      let outcome: unknown;
      try { outcome = { result: await callOp(ctx, "strategy.remove", { name: input.target }) }; }
      catch (error) {
        const e = error as { code?: string; message?: string; hint?: string };
        outcome = { error: { code: e.code, message: e.message?.replaceAll(pacerHome, "$PACER_HOME"), hint: e.hint } };
      }
      output.push({
        ...input, defaultYaml, researchYaml, outcome,
        remaining: existsSync(join(pacerHome, "strategies/research.yaml")) ? readFileSync(join(pacerHome, "strategies/research.yaml"), "utf8") : null,
        active: existsSync(join(pacerHome, "active")) ? readFileSync(join(pacerHome, "active"), "utf8") : null,
        activity: normalize(jsonLines(join(pacerHome, "state/activity.jsonl"))),
        outbox: normalize(jsonLines(join(pacerHome, "link/outbox.jsonl"))),
        latest: existsSync(join(pacerHome, "link/latest.json")) ? normalize(JSON.parse(readFileSync(join(pacerHome, "link/latest.json"), "utf8"))) : null,
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
  return output;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== "--check")) {
    console.error("usage: bun scripts/golden/strategy-remove.ts [--check]");
    process.exit(2);
  }
  const actual = JSON.stringify(await recordStrategyRemove(), null, 2) + "\n";
  if (args[0] === "--check") {
    if (readFileSync(goldenPath, "utf8") !== actual) {
      console.error("Strategy remove goldens are stale; regenerate and inspect changes");
      process.exit(1);
    }
    console.log("checked TypeScript strategy.remove goldens");
  } else {
    mkdirSync(root, { recursive: true });
    writeFileSync(goldenPath, actual);
    console.log("recorded TypeScript strategy.remove goldens");
  }
}
