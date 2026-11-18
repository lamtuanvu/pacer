import { expect, test } from "bun:test";
import { displayModel, modelWarning } from "../app/src/model/executor-models";
import type { AvailableModels } from "../src/models/available";

const known: AvailableModels = { runner: "r", source: "opencode", fetchedAt: 0, models: [{ id: "zhipu/glm-4.7" }, { id: "zhipu/glm-4.7-air" }] };
const labeled: AvailableModels = { ...known, provider: "Zhipu" };
const unknown: AvailableModels = { runner: "r", source: "none", fetchedAt: 0, models: null };

test("displayModel strips the provider runner prefix", () => {
  expect(displayModel("zhipu/glm-4.7")).toBe("glm-4.7");
  expect(displayModel("openrouter/qwen/qwen3-coder")).toBe("qwen/qwen3-coder");
  expect(displayModel("pacer-go/kimi-k3")).toBe("kimi-k3");
  expect(displayModel("kimi-k3")).toBe("kimi-k3");
});

test("modelWarning names the provider when an offered default stops being served", () => {
  expect(modelWarning(known, "zhipu/glm-4.5", "Go")).toBe("glm-4.5 is no longer offered by Go");
  expect(modelWarning(known, "zhipu/glm-4.7", "Go")).toBeNull();
  expect(modelWarning(unknown, "zhipu/glm-4.5", "Go")).toBeNull();
  expect(modelWarning(known, null, "Go")).toBeNull();
});

test("modelWarning prefers the listing's provider label over the caller's fallback", () => {
  expect(modelWarning(labeled, "zhipu/glm-4.5", "Go")).toBe("glm-4.5 is no longer offered by Zhipu");
});

import { suggestTier, editModels } from "../app/src/model/executor-models";
import type { RunnerModels } from "../src/core/runner-models";
const draft: RunnerModels = { runner: "r", revision: "v1", default: "a", models: [{ id: "a", tier: "unknown" }] };
test("suggestTier uses output price thresholds and requires a cost", () => {
  expect([0.99, 1, 4.99, 5].map(costOut => suggestTier({ id: "a", costOut }))).toEqual(["small", "medium", "medium", "frontier"]);
  expect(suggestTier({ id: "a" })).toBeNull();
  expect(suggestTier({ id: "a", costOut: null })).toBeNull();
});
test("accepting a suggestion sets the tier", () => {
  expect(editModels(draft, { type: "tier", id: "a", tier: "medium" }).models).toEqual([{ id: "a", tier: "medium" }]);
  expect(draft.models[0].tier).toBe("unknown");
});
test("add, remove and default keep a valid local draft", () => {
  const added = editModels(draft, { type: "add", id: "b" });
  expect(added.models[1]).toEqual({ id: "b", tier: "unknown" });
  expect(editModels(added, { type: "add", id: "b" })).toEqual(added);
  expect(editModels(added, { type: "default", id: "b" }).default).toBe("b");
  expect(editModels(added, { type: "default", id: "absent" })).toEqual(added);
  expect(editModels(added, { type: "remove", id: "a" }).default).toBe("b");
});

test("the first declaration preserves and seeds an existing default", () => {
  const empty = { ...draft, default: "kimi-k2.7-code", models: [] };
  expect(editModels(empty, { type: "add", id: "glm-5.3-flash" })).toEqual({
    ...empty,
    models: [{ id: "kimi-k2.7-code", tier: "unknown" }, { id: "glm-5.3-flash", tier: "unknown" }],
  });
  expect(empty.models).toEqual([]);
  expect(editModels(empty, { type: "add", id: empty.default }).models).toEqual([
    { id: empty.default, tier: "unknown" },
  ]);
});

test("the first declaration becomes the default only when none exists", () => {
  for (const currentDefault of [null, ""]) {
    expect(editModels({ ...draft, default: currentDefault, models: [] }, { type: "add", id: "glm-5.3-flash" })).toEqual({
      ...draft,
      default: "glm-5.3-flash",
      models: [{ id: "glm-5.3-flash", tier: "unknown" }],
    });
  }
});

test("replace keeps the row metadata and moves its default in one edit", () => {
  const source: RunnerModels = {...draft, models: [{id: "a", tier: "frontier", strengths: ["review"], tools: true}, {id: "b", tier: "small"}]};
  expect(editModels(source, {type: "replace", id: "a", with: "c"})).toEqual({
    ...source, default: "c", models: [{...source.models[0], id: "c"}, source.models[1]],
  });
  expect(editModels(source, {type: "replace", id: "b", with: "c"}).default).toBe("a");
  expect(editModels(source, {type: "replace", id: "a", with: "b"})).toEqual(source);
  expect(editModels(source, {type: "replace", id: "a", with: " "})).toEqual(source);
});
