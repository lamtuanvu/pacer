/** TypeScript oracle for routing edits, source bytes and durable side effects. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callOp } from "../../src/api/ops";
import { fakeCtx } from "../../test/helpers";

const root = join(import.meta.dir, "../../test/fixtures/routing-set");
export const goldenPath = join(root, "goldens.json");
const block = "# keep layout\naccounts:\n  personal: {kind: claude}\n  codex: {kind: codex}\nplanner: claude-code\nrouting:\n  - default: [codex] # keep rule\npacing: {order: [codex], policy: priority}\n";
const twoRules = block.replace("  - default: [codex] # keep rule", "  - kinds: [debug] # kinds comment\n    executors: [codex] # executors comment\n  - default: [codex] # default comment");
const flow = "# keep flow\naccounts: {personal: {kind: claude}, codex: {kind: codex}}\nplanner: claude-code\nrouting: [{default: [codex]}] # flow comment\npacing: {order: [codex], policy: priority}\n";

const cases = [
  { id: "same-length-block", yaml: block, rules: [{ executors: ["codex", "claude-code"] }] },
  { id: "unchanged-default", yaml: block, rules: [{ executors: ["codex"] }] },
  { id: "add-rule-comments", yaml: twoRules, rules: [{ kinds: ["debug"], executors: ["claude-code"] }, { kinds: ["tests"], executors: ["codex"] }, { executors: ["codex"] }] },
  { id: "remove-rule-comments", yaml: twoRules, rules: [{ executors: ["claude-code"] }] },
  { id: "rename-default-to-executors", yaml: block, rules: [{ kinds: ["debug"], executors: ["codex"] }, { executors: ["claude-code"] }] },
  { id: "same-length-flow", yaml: flow, rules: [{ executors: ["claude-code"] }] },
  { id: "same-length-crlf", yaml: block.replaceAll("\n", "\r\n"), rules: [{ executors: ["claude-code"] }] },
  { id: "active-named", yaml: block, active: "research", rules: [{ executors: ["claude-code"] }] },
  { id: "invalid-order", yaml: block, rules: [{ executors: ["codex"] }, { kinds: ["debug"], executors: ["codex"] }] },
  { id: "unknown-executor", yaml: block, rules: [{ executors: ["invented"] }] },
  { id: "invalid-kind", yaml: block, rules: [{ kinds: ["bad-kind"], executors: ["codex"] }, { executors: ["codex"] }] },
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

export async function recordRoutingSet() {
  const output = [];
  for (const input of cases) {
    const home = mkdtempSync(join(tmpdir(), "pacer-routing-set-"));
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
      try { outcome = { result: await callOp(ctx, "routing.set", { rules: input.rules }) }; }
      catch (error) { const e = error as { code?: string; message?: string; hint?: string }; outcome = { error: { code: e.code, message: e.message, hint: e.hint } }; }
      const edited = join(pacerHome, "active" in input ? "strategies/research.yaml" : "strategy.yaml");
      const opencode = join(pacerHome, "opencode/opencode.json");
      output.push(normalize({
        id: input.id, initial: input.yaml, active: "active" in input ? input.active : "default", rules: input.rules,
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
    console.error("usage: bun scripts/golden/routing-set.ts [--check]"); process.exit(2);
  }
  const actual = JSON.stringify(await recordRoutingSet(), null, 2) + "\n";
  if (args[0] === "--check") {
    if (readFileSync(goldenPath, "utf8") !== actual) { console.error("routing.set goldens are stale"); process.exit(1); }
    console.log("checked TypeScript routing.set goldens");
  } else {
    mkdirSync(root, { recursive: true }); writeFileSync(goldenPath, actual);
    console.log("recorded TypeScript routing.set goldens");
  }
}
