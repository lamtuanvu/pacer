import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { APP_FILES } from "../src/app/assets.generated";
import { appRoute } from "../src/serve/app-routes";
import { fakeCtx } from "./helpers";
import rows from "./fixtures/app-route-parity.json";

test("app route asset bytes, cache, CSP and fallback classification", async () => {
  const ctx = fakeCtx();
  for (const row of rows) {
    const file = "asset" in row ? APP_FILES.find(item => item.path === row.asset) : undefined;
    const tag = file && file.path !== "index.html"
      ? `"${createHash("sha256").update(file.text).digest("hex").slice(0, 32)}"` : undefined;
    const headers = "conditional" in row && row.conditional ? { "if-none-match": tag! } : undefined;
    const response = appRoute(new Request(`http://localhost:4317${row.path}`, { method: row.method, headers }), ctx);
    if (row.forward) {
      if (row.path.startsWith("/app/"))
        expect(response.status).toBe(row.path.includes("missing.js") ? 404 : row.method === "POST" ? 405 : 403);
      continue;
    }
    expect(response.status).toBe(headers ? 304 : 200);
    expect(response.headers.get("content-type")).toBe(file!.type);
    expect(response.headers.get("cache-control")).toBe(row.cache!);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("etag")).toBe(tag ?? null);
    const body = await response.text();
    if (row.method === "HEAD" || headers) expect(body).toBe("");
    else if (file!.path === "index.html") {
      const nonce = response.headers.get("content-security-policy")!.match(/'nonce-([^']+)'/)?.[1];
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{32}$/);
      expect(body).toBe(file!.text.replace("</head>", `<meta name="pacer-style-nonce" content="${nonce}"></head>`));
    } else expect(body).toBe(file!.text);
  }
});
