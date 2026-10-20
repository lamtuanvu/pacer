import { expect, test } from "bun:test";
import { validateStrategy } from "../src/config/strategy";
import { projectReferences, resolveProjectSelection } from "../src/engine/project-routing";
const s = validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, codex: {}, cursor: {} } }, "/test");
test("project aliases become explicit account and host identities", () => {
  const refs = projectReferences(s, ["cursor", "codex"]);
  expect(refs).toEqual(["cursor#cursor@local", "codex#codex@local"]);
  expect(resolveProjectSelection(s, "repo", { repo: { rev: 4, executors: refs } })).toEqual({ repoKey: "repo", rev: 4, references: refs, executors: ["cursor", "codex"] });
  expect(resolveProjectSelection(s, "repo", { repo: { rev: 5, executors: null } })).toBeUndefined();
});
test("unknown, planner and duplicate aliases cannot be saved", () => {
  for (const ids of [["unknown"], ["claude-code"], ["codex", "codex#codex@local"], []]) expect(() => projectReferences(s, ids)).toThrow();
});
test("a different default account never inherits another account's project permission", () => {
  const refs = projectReferences(s, ["codex"]);
  const changed = structuredClone(s);
  changed.runners.codex.account = "other";
  changed.accounts.other = { ...s.accounts.codex, name: "other" };
  const p = resolveProjectSelection(changed, "repo", { repo: { rev: 1, executors: refs } });
  expect(p?.executors).toEqual(["codex#codex@local"]);
});
test("different accounts and hosts retain distinct positions", () => {
  const changed = structuredClone(s);
  changed.runners["codex@worker"] = { ...s.runners.codex, id: "codex@worker", host: "worker" };
  const refs = projectReferences(changed, ["codex@worker", "codex"]);
  expect(refs).toEqual(["codex#codex@worker", "codex#codex@local"]);
  expect(resolveProjectSelection(changed, "repo", { repo: { rev: 1, executors: refs } })?.executors).toEqual(["codex@worker", "codex"]);
});
