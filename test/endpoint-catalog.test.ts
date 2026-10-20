import {expect, test} from "bun:test";
import {existsSync, readFileSync, writeFileSync, mkdirSync} from "node:fs";
import {join} from "node:path";
import {CATALOG_URL, loadCatalog, parseCatalog, readCachedCatalog} from "../src/endpoints/catalog";
import {fakeCtx} from "./helpers";

const raw = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "models-dev-sample.json"), "utf8"));
const ok = (calls: string[] = []) => (async (url: string) => { calls.push(url); return Response.json(raw); }) as unknown as typeof fetch;

test("parseCatalog keeps the fields pacer uses and skips malformed providers", () => {
  const p = parseCatalog(raw);
  expect(Object.keys(p).sort()).toEqual(["lmstudio", "openrouter", "volcengine-coding-plan"]);
  expect(p.openrouter.models.find(m => m.id === "qwen/qwen3-coder")).toEqual({id: "qwen/qwen3-coder", name: "Qwen3 Coder", toolCall: true, input: ["text"], output: ["text"], context: 262144, outputLimit: 65536, costIn: 0.22, costOut: 0.95, release: "2025-07-23"});
  expect(p["volcengine-coding-plan"].models.find(m => m.id === "doubao-embedding")).toMatchObject({costIn: null, release: null, output: ["embedding"]});
});

test("loadCatalog fetches once and serves the 24 h cache", async () => {
  const ctx = fakeCtx(), calls: string[] = [];
  const first = await loadCatalog(ctx, {fetch: ok(calls)});
  expect(first?.stale).toBe(false);
  expect(existsSync(join(ctx.pacerHome, "cache", "models.json"))).toBe(true);
  const second = await loadCatalog(ctx, {fetch: ok(calls)});
  expect(calls).toEqual([CATALOG_URL]);
  expect(second?.providers.openrouter.name).toBe("OpenRouter");
});

test("an old cache is refreshed; a failed refresh serves it as stale", async () => {
  const ctx = fakeCtx();
  await loadCatalog(ctx, {fetch: ok()});
  ctx.now += 25 * 3600;
  const failing = (async () => { throw Error("offline"); }) as unknown as typeof fetch;
  const stale = await loadCatalog(ctx, {fetch: failing});
  expect(stale?.stale).toBe(true);
  expect(stale?.providers.openrouter).toBeDefined();
});

test("no cache and no network returns null; readCachedCatalog never fetches", async () => {
  const ctx = fakeCtx();
  expect(await loadCatalog(ctx, {fetch: (async () => new Response("x", {status: 500})) as unknown as typeof fetch})).toBeNull();
  expect(readCachedCatalog(ctx)).toBeNull();
  mkdirSync(join(ctx.pacerHome, "cache"), {recursive: true});
  writeFileSync(join(ctx.pacerHome, "cache", "models.json"), "{not json");
  expect(readCachedCatalog(ctx)).toBeNull();
});
