/** TypeScript oracle for named/default strategy activation and durable events. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callOp } from "../../src/api/ops";
import { fakeCtx } from "../../test/helpers";

const root = join(import.meta.dir, "../../test/fixtures/strategy-use");
export const goldenPath = join(root, "goldens.json");
const defaultYaml = "# Main work\nplanner: codex\naccounts: {personal: {kind: codex}}\nrouting: [{default: [codex]}]\n";
const researchYaml = "# Research mode\nplanner: codex\naccounts: {personal: {kind: codex}}\npacing: {policy: even, planner_reserve: 25}\nrouting: [{default: [codex]}]\n";

function lines(path: string): any[] {
  try { return readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch { return []; }
}

function normalize(value: any): any {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "id" && typeof item === "string" && /^1700000000-/.test(item) ? "<activity-id>" : normalize(item)]));
  }
  return value;
}

export async function recordStrategyUse() {
  const cases = [{ id: "activate-research", initial: "default", target: "research" }, { id: "return-default", initial: "research", target: "default" }] as const;
  const output = [];
  for (const input of cases) {
    const home = mkdtempSync(join(tmpdir(), "pacer-strategy-use-"));
    try {
      const pacerHome = join(home, ".pacer");
      mkdirSync(join(pacerHome, "strategies"), { recursive: true });
      writeFileSync(join(pacerHome, "strategy.yaml"), defaultYaml);
      writeFileSync(join(pacerHome, "strategies/research.yaml"), researchYaml);
      if (input.initial === "research") writeFileSync(join(pacerHome, "active"), "research\n");
      const ctx = fakeCtx({ home, pacerHome, now: 1_700_000_000 });
      const result = await callOp(ctx, "strategy.use", { name: input.target }) as { name: string; path: string };
      const active = input.target === "default" ? null : readFileSync(join(pacerHome, "active"), "utf8");
      const activity = lines(join(pacerHome, "state/activity.jsonl"));
      const outbox = lines(join(pacerHome, "link/outbox.jsonl"));
      const latest = JSON.parse(readFileSync(join(pacerHome, "link/latest.json"), "utf8"));
      output.push({
        ...input, defaultYaml, researchYaml,
        result: { ...result, path: String(result.path).replace(pacerHome, "$PACER_HOME") },
        active,
        activity: normalize(activity),
        outbox: normalize(outbox),
        latest: normalize(latest),
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
  return output;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== "--check")) {
    console.error("usage: bun scripts/golden/strategy-use.ts [--check]");
    process.exit(2);
  }
  const actual = JSON.stringify(await recordStrategyUse(), null, 2) + "\n";
  if (args[0] === "--check") {
    if (readFileSync(goldenPath, "utf8") !== actual) {
      console.error("Strategy use goldens are stale; regenerate and inspect changes");
      process.exit(1);
    }
    console.log("checked TypeScript strategy.use goldens");
  } else {
    writeFileSync(goldenPath, actual);
    console.log("recorded TypeScript strategy.use goldens");
  }
}
