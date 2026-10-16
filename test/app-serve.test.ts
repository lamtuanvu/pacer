import { expect, test } from "bun:test";
import { appRoute, APP_HEADERS } from "../src/serve/app-routes";
import { APP_FILES } from "../src/app/assets.generated";
import { fakeCtx } from "./helpers";

test("app serves embedded HTML, JavaScript and CSS with content types and CSP", async () => {
  const ctx = fakeCtx();
  for (const [path, type] of [["", "text/html"], ["app.js", "text/javascript"], ["app.css", "text/css"]]) {
    const file = APP_FILES.find(f => f.path === (path || "index.html"));
    expect(file).toBeDefined();
    const response = appRoute(new Request(`http://localhost:4317/app/${path}`), ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(`${type}; charset=utf-8`);
    expect(response.headers.get("content-security-policy")).toBe(APP_HEADERS["Content-Security-Policy"]);
    expect(await response.text()).toBe(file!.text);
    const head = appRoute(new Request(`http://localhost:4317/app/${path}`, { method: "HEAD" }), ctx);
    expect(await head.text()).toBe("");
  }
});

test("app assets revalidate on every load so an update never runs a cached old app", () => {
  const ctx = fakeCtx();
  const first = appRoute(new Request("http://localhost:4317/app/app.js"), ctx);
  expect(first.headers.get("cache-control")).toBe("no-cache");
  const etag = first.headers.get("etag");
  expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
  const again = appRoute(new Request("http://localhost:4317/app/app.js", { headers: { "if-none-match": etag! } }), ctx);
  expect(again.status).toBe(304);
  const stale = appRoute(new Request("http://localhost:4317/app/app.js", { headers: { "if-none-match": '"old"' } }), ctx);
  expect(stale.status).toBe(200);
  expect(appRoute(new Request("http://localhost:4317/app/"), ctx).headers.get("cache-control")).toBe("no-store");
});
