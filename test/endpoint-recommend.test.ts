import {expect, test} from "bun:test";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {parseCatalog} from "../src/endpoints/catalog";
import {classify, filterModelIds, idChoice, recommend, toChoice, usableModels} from "../src/endpoints/recommend";

const catalog = parseCatalog(JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "models-dev-sample.json"), "utf8")));

test("usable models need tool calling and text in and out", () => {
  expect(usableModels(catalog.openrouter.models).map(m => m.id).sort()).toEqual(["qwen/qwen3-coder", "z-ai/glm-5.3"]);
  expect(usableModels(catalog["volcengine-coding-plan"].models).map(m => m.id)).toEqual(["doubao-seed-code"]);
});

test("recommend prefers coding models, then context, then recency", () => {
  const {pick, rest} = recommend(usableModels(catalog.openrouter.models).map(toChoice));
  expect(pick?.id).toBe("qwen/qwen3-coder");
  expect(rest.map(m => m.id)).toEqual(["z-ai/glm-5.3"]);
  expect(recommend([])).toEqual({pick: null, rest: []});
});

test("id filtering drops non-chat models when the catalog has no entry", () => {
  expect(filterModelIds(["qwen3-coder:30b", "nomic-embed-text", "flux-image-1", "whisper-large", "kokoro-tts", "llava-vision", "gpt-oss:20b"]))
    .toEqual(["qwen3-coder:30b", "gpt-oss:20b"]);
  expect(idChoice("gpt-oss:20b")).toEqual({id: "gpt-oss:20b", context: 128000, output: 16000, tools: true, costIn: null, costOut: null});
});

test("recommend breaks ties by context, then by recency", () => {
  const small = {...idChoice("small"), context: 50000};
  const big = {...idChoice("big"), context: 100000};
  expect(recommend([small, big]).pick?.id).toBe("big");

  const older = {...idChoice("older"), context: 80000};
  const newer = {...idChoice("newer"), context: 80000};
  expect(recommend([older, newer], {older: "2023-01-01", newer: "2024-01-01"}).pick?.id).toBe("newer");
});

const noPricingModel = {id: "m1", name: "M1", toolCall: true, input: ["text"], output: ["text"], context: 128000, outputLimit: 16000, costIn: null, costOut: null, release: null};
const freeModel = {id: "m1", name: "M1", toolCall: true, input: ["text"], output: ["text"], context: 128000, outputLimit: 16000, costIn: 0, costOut: 0, release: null};

for (const [name, provider, cat, expected] of [
  ["local servers", {id: "ollama", local: true}, undefined, {usage: "unmetered", known: true}],
  ["BytePlus coding-plan alias", {id: "coding-plan"}, undefined, {usage: "quota", quota_source: "arkcli", known: true}],
  ["coding plan with an ark reader", {id: "volcengine-coding-plan"}, catalog["volcengine-coding-plan"], {usage: "quota", quota_source: "arkcli", known: true}],
  ["coding plan without a reader", {id: "zhipuai-coding-plan"}, {id: "zhipuai-coding-plan", name: "Z", env: [], api: null, models: []} as any, {usage: "quota", known: true}],
  ["pay per token", {id: "openrouter"}, catalog.openrouter, {usage: "metered", known: true}],
  ["unknown provider", {id: "terastor"}, undefined, {usage: "metered", known: false}],
  ["catalog entry with no pricing data on any model", {id: "nopricing"}, {id: "nopricing", name: "N", env: [], api: null, models: [noPricingModel]} as any, {usage: "metered", known: false}],
  ["$0-cost provider without the -coding-plan suffix", {id: "freeplan"}, {id: "freeplan", name: "F", env: [], api: null, models: [freeModel]} as any, {usage: "quota", known: true}],
] as const) test(`classify: ${name}`, () => {
  expect(classify(provider, cat)).toEqual(expected as never);
});
