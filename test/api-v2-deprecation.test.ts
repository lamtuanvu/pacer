import { afterEach, expect, test } from "bun:test";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { V2_HEADERS, V2_REMOVAL_RELEASE, isV2Path } from "../src/api/deprecation";
import { helloBody } from "../src/api/protocol";
import { v2Hello } from "../src/api/v2-compat";
import { startServer } from "../src/serve/http";
import { fakeCtx } from "./helpers";

let stop: (() => void | Promise<void>) | undefined;
afterEach(async () => { await stop?.(); stop = undefined; });

async function serve() {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
  const s = startServer(() => ctx, { port: 0, sseIntervalMs: 50, tailMs: 50, pumpMs: 0 });
  stop = s.stop;
  return { url: `http://127.0.0.1:${s.port}`, h: { authorization: `Bearer ${s.token}` } };
}

test("isV2Path matches /v2 and its children only", () => {
  expect(["/v2", "/v2/hello", "/v2/ops/task.list"].map(isV2Path)).toEqual([true, true, true]);
  expect(["/v3/hello", "/v20/x", "/app/v2"].map(isV2Path)).toEqual([false, false, false]);
});

test("every /v2 response carries Deprecation, Sunset and a successor link; /v3 does not", async () => {
  const { url, h } = await serve();
  for (const path of ["/v2/hello", "/v2/snapshot", "/v2/ops/nope"]) {
    const res = await fetch(`${url}${path}`, {
      headers: h,
      method: path.includes("/ops/") ? "POST" : "GET",
      body: path.includes("/ops/") ? "{}" : undefined,
    });
    expect(res.headers.get("deprecation")).toBe(V2_HEADERS.Deprecation);
    expect(res.headers.get("sunset")).toBe(V2_HEADERS.Sunset);
    expect(res.headers.get("link")).toBe(V2_HEADERS.Link);
  }
  expect((await fetch(`${url}/v3/hello`, { headers: h })).headers.get("deprecation")).toBeNull();
});

test("hello names the removal release", () => {
  expect(helloBody().previousRemovedIn).toBe(V2_REMOVAL_RELEASE);
  expect(v2Hello().removedIn).toBe(V2_REMOVAL_RELEASE);
});

test("Rust and TypeScript use the same header values", () => {
  const rust = readFileSync(join(import.meta.dir, "..", "crates/server/src/serve/deprecation.rs"), "utf8");
  for (const [name, value] of [
    ["V2_DEPRECATION", V2_HEADERS.Deprecation],
    ["V2_SUNSET", V2_HEADERS.Sunset],
    ["V2_LINK", V2_HEADERS.Link],
    ["V2_REMOVAL_RELEASE", V2_REMOVAL_RELEASE],
  ] as const) {
    expect(rust).toContain(`pub const ${name}: &str = ${JSON.stringify(value)};`);
  }
});
