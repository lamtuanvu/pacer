import { expect, test } from "bun:test";
import { blankWizard, nextStep, validateWizard, endpointParams } from "../app/src/model/wizard";
test("step machine skips connection for native agents", () => {
  expect(nextStep(2, "codex")).toBe(4);
  expect(nextStep(2, "opencode")).toBe(3);
  expect(validateWizard(2, { ...blankWizard, agent: "codex" })).toContain("account");
});
test("endpoint validation requires safe URL, key source and complete model limits", () => {
  const draft = { ...blankWizard, name: "local", base_url: "http://localhost:1234/v1", key_source: "none", models: JSON.stringify([{ id: "m", context: 100, output: 10, tools: true }]) };
  expect(validateWizard(3, draft)).toBeNull();
  expect(validateWizard(3, { ...draft, base_url: "file:///etc/passwd" })).toContain("URL");
  expect(validateWizard(3, { ...draft, models: '[{"id":"m"}]' })).toContain("limits");
  expect(validateWizard(3, { ...draft, key_source: "env", env_var: "bad name" })).toContain("variable");
  expect(endpointParams(draft, "secret")).toMatchObject({ kind: "endpoint", test: true });
  expect(JSON.stringify(blankWizard)).not.toContain("secret");
});
test("existing endpoint can proceed without creating another account", () => {
  expect(validateWizard(2, { ...blankWizard, agent: "opencode", account: "local" })).toBeNull();
});
test("key material is restricted to storage sources and never mutates the draft", () => {
  const draft = { ...blankWizard, models: '[{"id":"m","context":100,"output":10}]' };
  expect(endpointParams(draft, "secret").key).toBe("secret");
  expect(endpointParams({ ...draft, key_source: "env", env_var: "TOKEN" }, "secret").key).toBeUndefined();
  expect(endpointParams({ ...draft, key_source: "none" }, "secret").key).toBeUndefined();
  expect(JSON.stringify(draft)).not.toContain("secret");
});
