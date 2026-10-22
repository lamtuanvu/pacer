import { expect, test } from "bun:test";
import { appRoute } from "../src/serve/app-routes";
import { fakeCtx } from "./helpers";

test("terminal dynamic styles receive a unique page nonce without unsafe-inline", async () => {
  const ctx = fakeCtx();
  const first = appRoute(new Request("http://localhost/app/"), ctx);
  const html = await first.text();
  const nonce = html.match(/name="pacer-style-nonce" content="([A-Za-z0-9+/=]+)"/)?.[1];
  expect(nonce).toBeDefined();
  expect(first.headers.get("content-security-policy")).toContain(`style-src 'self' 'nonce-${nonce}'`);
  expect(first.headers.get("content-security-policy")).not.toContain("unsafe-inline");
  const second = await appRoute(new Request("http://localhost/app/"), ctx).text();
  expect(second).not.toContain(`content="${nonce}"`);
});
