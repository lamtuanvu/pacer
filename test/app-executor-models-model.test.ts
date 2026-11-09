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
