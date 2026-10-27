/** TypeScript oracle for bounded named strategy saving. */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callOp } from "../../src/api/ops";
import { fakeCtx } from "../../test/helpers";

const root = join(import.meta.dir, "../../test/fixtures/strategy-save");
export const goldenPath = join(root, "goldens.json");
export const defaultYaml = "# Base\nplanner: codex\naccounts: {personal: {kind: codex}}\nrouting: [{default: [codex]}]\n";
export const researchYaml = "# Research\nplanner: codex\naccounts: {personal: {kind: codex}}\npacing: {policy: even, planner_reserve: 25}\nrouting: [{default: [codex]}]\n";

function lines(path: string): unknown[] {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}
function normalized(value: unknown, pacerHome: string): unknown {
  if (Array.isArray(value)) return value.map(item => normalized(item, pacerHome));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, key === "id" && typeof item === "string" && /^1700000000-/.test(item) ? "<activity-id>" : normalized(item, pacerHome)]));
  return typeof value === "string" ? value.replaceAll(pacerHome, "$PACER_HOME") : value;
}

export async function recordStrategySave() {
  const cases = [
    { id: "create-default", name: "new-plan", draft: { from: "default" }, reason: "Copy base" },
    { id: "create-edited", name: "edited", draft: { from: "default", description: "Edited plan", set: { "pacing.policy": "even", "pacing.planner_reserve": 25, routing: [{ default: ["codex"] }] } }, reason: "Approved" },
    { id: "create-from-named", name: "copy", draft: { from: "research", set: { "pacing.planner_reserve": 30 } }, reason: "Copy research" },
    { id: "overwrite", name: "research", draft: { from: "default", set: { "pacing.planner_reserve": 30 } }, reason: "Replace", overwrite: true },
    { id: "duplicate", name: "research", draft: { from: "default" }, reason: "Duplicate" },
    { id: "active-overwrite", name: "research", draft: { from: "default" }, reason: "Active", overwrite: true, active: "research" },
    { id: "invalid-draft", name: "invalid", draft: { from: "default", set: { "pacing.policy": "bad" } }, reason: "Invalid" },
  ] as const;
  const output = [];
  for (const input of cases) {
    const home = mkdtempSync(join(tmpdir(), "pacer-strategy-save-"));
    try {
      const pacerHome = join(home, ".pacer"), strategies = join(pacerHome, "strategies");
      mkdirSync(strategies, { recursive: true, mode: 0o700 });
      writeFileSync(join(pacerHome, "strategy.yaml"), defaultYaml);
      writeFileSync(join(strategies, "research.yaml"), researchYaml);
      if ("active" in input) writeFileSync(join(pacerHome, "active"), `${input.active}\n`);
      const ctx = fakeCtx({ home, pacerHome, now: 1_700_000_000 });
      let outcome: unknown;
      try { outcome = { result: await callOp(ctx, "strategy.save", { name: input.name, draft: input.draft, reason: input.reason, overwrite: "overwrite" in input ? input.overwrite : undefined }) }; }
      catch (error) { const e = error as { code?: string; message?: string; hint?: string }; outcome = { error: { code: e.code, message: e.message, hint: e.hint } }; }
      const target = join(strategies, `${input.name}.yaml`);
      output.push(normalized({
        id: input.id, name: input.name, draft: input.draft, reason: input.reason, overwrite: "overwrite" in input ? input.overwrite : false,
        initial: { defaultYaml, researchYaml, active: "active" in input ? input.active : "default" },
        outcome, saved: existsSync(target) ? readFileSync(target, "utf8") : null,
        modes: { strategies: statSync(strategies).mode & 0o777, saved: existsSync(target) ? statSync(target).mode & 0o777 : null },
        activity: lines(join(pacerHome, "state/activity.jsonl")), outbox: lines(join(pacerHome, "link/outbox.jsonl")),
      }, pacerHome));
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
  return output;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== "--check")) {
    console.error("usage: bun scripts/golden/strategy-save.ts [--check]"); process.exit(2);
  }
  const actual = JSON.stringify(await recordStrategySave(), null, 2) + "\n";
  if (args[0] === "--check") {
    if (readFileSync(goldenPath, "utf8") !== actual) { console.error("Strategy save goldens are stale"); process.exit(1); }
    console.log("checked TypeScript strategy.save goldens");
  } else {
    mkdirSync(root, { recursive: true }); writeFileSync(goldenPath, actual);
    console.log("recorded TypeScript strategy.save goldens");
  }
}
