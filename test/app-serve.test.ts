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
