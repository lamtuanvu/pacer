import { expect, test } from "bun:test";
import { main } from "../src/cli";
import { startServer } from "../src/serve/http";
import { fakeCtx } from "./helpers";

test("internal mode trusts only the internal token and keeps the bearer/cookie distinction", async () => {
  const ctx = fakeCtx({ now: Date.now() / 1000 });
  const s = startServer(() => ctx, { port: 0, pumpMs: 0, internal: { token: "i".repeat(64) } });
  try {
    const url = (p: string) => `http://127.0.0.1:${s.port}${p}`;
    const host = { host: `127.0.0.1:${s.port}` };
    expect((await fetch(url("/v3/hello"), { headers: { ...host, authorization: `Bearer ${s.token}` } })).status).toBe(401);
    for (const path of ["/health", "/app/auth", "/_internal/app-page?status=401"]) {
      expect((await fetch(url(path))).status).toBe(401);
    }
    const cookie = await fetch(url("/v3/hello"), { headers: {
      ...host, authorization: `Bearer ${"i".repeat(64)}`, "x-pacer-auth": "cookie",
      origin: "https://foreign.example", "sec-fetch-site": "cross-site",
    } });
    expect(cookie.status).toBe(200);
    const ok = await fetch(url("/v3/hello"), { headers: { ...host, authorization: `Bearer ${"i".repeat(64)}`, "x-pacer-auth": "bearer" } });
    expect(ok.status).toBe(200);
    const page = await fetch(url("/_internal/app-page?status=401&message=Session%20ended."), { headers: { ...host, authorization: `Bearer ${"i".repeat(64)}` } });
    expect(page.status).toBe(401);
    expect(await page.text()).toContain("Session ended.");
  } finally { s.stop(); }
});

for (const token of [undefined, "i".repeat(31)]) {
  test(`internal CLI rejects ${token ? "short" : "missing"} environment token`, async () => {
    const ctx = fakeCtx({ env: token ? { PACER_INTERNAL_TOKEN: token } : {} });
    const result = await main(["serve", "--internal", "--token", "i".repeat(64)], ctx);
    expect(result.code).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).toContain("PACER_INTERNAL_TOKEN");
    expect(result.err).toContain("32");
  });
}
