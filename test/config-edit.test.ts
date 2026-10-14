import { expect, test } from "bun:test";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { editStrategy, type StrategyDoc } from "../src/config/edit";
import { tmpDir } from "./helpers";

const text = `# personal strategy
planner: codex # planner stays here
accounts:
  codex: {kind: codex} # default budget
runners:
  codex: {agent: codex, account: codex}
pacing: {policy: priority, planner_reserve: 15} # pace
routing:
  - default: [codex] # route
`;
function fixture() { const path = join(tmpDir(), "strategy.yaml"); writeFileSync(path, text); return path; }

test("scalar edits preserve comments, spacing and key order outside the edited value", () => {
  const path = fixture(); chmodSync(path, 0o600);
  const result = editStrategy(path, doc => doc.setIn(["pacing", "planner_reserve"], 20));
  expect(result.ok).toBe(true);
  expect(readFileSync(path, "utf8")).toBe(text.replace("planner_reserve: 15", "planner_reserve: 20"));
  if (result.ok) { expect(result.diff).toContain("-pacing:"); expect(result.diff).toContain("+pacing:"); }
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("mapping and list edits keep unrelated layout and validate the whole result", () => {
  const path = fixture();
  expect(editStrategy(path, doc => {
    doc.addMappingEntry("accounts", "local", { kind: "endpoint", usage: "unmetered" });
    doc.addMappingEntry("runners", "local", { agent: "opencode", account: "local", model: "ollama/qwen3" });
    doc.setList(["pacing", "order"], ["local", "codex"]);
    doc.setList(["routing", 0, "default"], ["local", "codex"]);
  }).ok).toBe(true);
  const updated = readFileSync(path, "utf8");
  expect(updated).toContain("codex: {kind: codex} # default budget");
  expect(updated).toContain("# route");
  expect(Bun.YAML.parse(updated)).toMatchObject({ pacing: { order: ["local", "codex"] } });
  expect(editStrategy(path, doc => {
    doc.setList(["pacing", "order"], ["codex"]);
    doc.setList(["routing", 0, "default"], ["codex"]);
    doc.removeMappingEntry("runners", "local");
    doc.removeMappingEntry("accounts", "local");
  }).ok).toBe(true);
  expect(Bun.YAML.parse(readFileSync(path, "utf8"))).not.toHaveProperty("accounts.local");
});

test("invalid edits and callback failures leave the original byte-identical", () => {
  const path = fixture();
  for (const change of [
    (doc: StrategyDoc) => doc.setIn(["pacing", "fill_threshold"], 101),
    (doc: StrategyDoc) => doc.removeMappingEntry("accounts", "codex"),
    () => { throw Error("aborted"); },
  ]) {
    expect(editStrategy(path, change).ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(text);
  }
  expect(editStrategy(path, () => {}).ok).toBe(true);
  expect(readFileSync(path, "utf8")).toBe(text);
});

test("inserting and removing a flow key keeps the original sibling spacing", () => {
  const path = fixture();
  expect(editStrategy(path, doc => doc.setIn(["pacing", "fill_threshold"], 95)).ok).toBe(true);
  expect(readFileSync(path, "utf8")).toBe(text.replace("planner_reserve: 15}", "planner_reserve: 15, fill_threshold: 95}"));
  expect(editStrategy(path, doc => doc.deleteIn(["pacing", "fill_threshold"])).ok).toBe(true);
  expect(readFileSync(path, "utf8")).toBe(text);
});

test("list edits keep comments on surviving block-list entries", () => {
  const path = fixture();
  const original = text.replace("pacing: {policy: priority, planner_reserve: 15} # pace", "pacing:\n  order:\n    - codex # default runner\n  policy: priority # pace");
  writeFileSync(path, original);
  expect(editStrategy(path, doc => doc.setList(["pacing", "order"], ["codex", "opencode"])).ok).toBe(true);
  const after = readFileSync(path, "utf8");
  expect(after).toContain("- codex # default runner");
  expect(after).toContain("  policy: priority # pace");
});
