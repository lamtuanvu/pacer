/** TypeScript oracle for runner configuration edits and durable effects. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callOp } from "../../src/api/ops";
import { fakeCtx } from "../../test/helpers";

const root = join(import.meta.dir, "../../test/fixtures/runner-config");
export const goldenPath = join(root, "goldens.json");
const implicit = "# keep layout\nplanner: claude-code\naccounts:\n  personal: {kind: claude}\n  codex: {kind: codex}\n  cursor: {kind: cursor}\nrouting:\n  - default: [codex, cursor] # keep rule\npacing: {order: [codex, cursor], policy: priority}\n";
const explicit = implicit.replace("routing:\n", "runners:\n  codex: {enabled: true} # keep runner\nrouting:\n");
const one = implicit.replace("[codex, cursor]", "[codex]");
const cases = [
  { id: "reorder-implicit", yaml: implicit, op: "runner.reorder", params: { ids: ["cursor", "codex"] } },
  { id: "reorder-explicit", yaml: explicit, op: "runner.reorder", params: { ids: ["cursor", "codex"] } },
  { id: "reorder-named", yaml: implicit, active: "research", op: "runner.reorder", params: { ids: ["cursor", "codex"] } },
  { id: "reorder-invalid", yaml: implicit, op: "runner.reorder", params: { ids: ["codex"] } },
  { id: "set-disabled", yaml: explicit, op: "runner.set", params: { id: "codex", enabled: false } },
  { id: "set-model-null", yaml: explicit.replace("enabled: true", "model: initial"), op: "runner.set", params: { id: "codex", model: null } },
  { id: "set-max-tasks", yaml: explicit, op: "runner.set", params: { id: "codex", max_tasks: 3 } },
  { id: "set-rank", yaml: explicit, op: "runner.set", params: { id: "codex", rank: 1 } },
  { id: "set-planner-refusal", yaml: explicit, op: "runner.set", params: { id: "claude-code", enabled: false } },
  { id: "set-warning", yaml: one.replace("routing:\n", "runners:\n  codex: {enabled: true}\nrouting:\n"), op: "runner.set", params: { id: "codex", enabled: false } },
  { id: "set-warning-planner", yaml: explicit.replace("[codex, cursor] # keep rule", "[claude-code, codex] # keep rule"), op: "runner.set", params: { id: "codex", enabled: false } },
] as const;

function lines(path: string): unknown[] {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}
function normalize(value: unknown, pacerHome: string): unknown {
  if (Array.isArray(value)) return value.map(item => normalize(item, pacerHome));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, key === "id" && typeof item === "string" && /^1700000000-/.test(item) ? "<activity-id>" : normalize(item, pacerHome)]));
  return typeof value === "string" ? value.replaceAll(pacerHome, "$PACER_HOME") : value;
}

export async function recordRunnerConfig() {
  const output = [];
  for (const input of cases) {
    const home = mkdtempSync(join(tmpdir(), "pacer-runner-config-"));
    try {
      const pacerHome = join(home, ".pacer");
      mkdirSync(pacerHome, { recursive: true, mode: 0o700 });
      writeFileSync(join(pacerHome, "strategy.yaml"), input.yaml, { mode: 0o600 });
      if ("active" in input) {
        mkdirSync(join(pacerHome, "strategies"), { mode: 0o700 });
        writeFileSync(join(pacerHome, "strategies/research.yaml"), input.yaml, { mode: 0o600 });
        writeFileSync(join(pacerHome, "active"), `${input.active}\n`, { mode: 0o600 });
      }
      const ctx = fakeCtx({ home, pacerHome, now: 1_700_000_000 });
      let outcome: unknown;
      try { outcome = { result: await callOp(ctx, input.op, input.params) }; }
      catch (error) { const e = error as { code?: string; message?: string; hint?: string }; outcome = { error: { code: e.code, message: e.message, hint: e.hint } }; }
      const edited = join(pacerHome, "active" in input ? "strategies/research.yaml" : "strategy.yaml");
      const opencode = join(pacerHome, "opencode/opencode.json");
      output.push(normalize({
        id: input.id, initial: input.yaml, active: "active" in input ? input.active : "default", op: input.op, params: input.params,
        outcome, edited: readFileSync(edited, "utf8"), mode: statSync(edited).mode & 0o777,
        opencode: existsSync(opencode) ? readFileSync(opencode, "utf8") : null,
        activity: lines(join(pacerHome, "state/activity.jsonl")), outbox: lines(join(pacerHome, "link/outbox.jsonl")),
      }, pacerHome));
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
  return output;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== "--check")) {
    console.error("usage: bun scripts/golden/runner-config.ts [--check]"); process.exit(2);
  }
  const actual = JSON.stringify(await recordRunnerConfig(), null, 2) + "\n";
  if (args[0] === "--check") {
    if (readFileSync(goldenPath, "utf8") !== actual) { console.error("runner config goldens are stale"); process.exit(1); }
    console.log("checked TypeScript runner config goldens");
  } else {
    mkdirSync(root, { recursive: true }); writeFileSync(goldenPath, actual);
    console.log("recorded TypeScript runner config goldens");
  }
}
