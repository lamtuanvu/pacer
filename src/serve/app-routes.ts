import { createHash } from "node:crypto";
import { extname } from "node:path";
import { APP_FILES } from "../app/assets.generated";
import type { Ctx } from "../types";
import { createSession, redeemCode, SESSION_SECONDS } from "./app-auth";

export const APP_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export function appPage(message: string, status: number): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>pacer app</title></head><body><p>${message}</p></body></html>`, {
    status, headers: { ...APP_HEADERS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** Authentication is enforced by the HTTP server before static routes are called. */
export function appRoute(req: Request, ctx: Ctx): Response {
  const url = new URL(req.url);
  if (req.method !== "GET" && req.method !== "HEAD") return appPage("Method not allowed.", 405);
  if (url.pathname === "/app/auth") {
    if (req.method !== "GET") return appPage("Method not allowed.", 405);
    if (!redeemCode(ctx, url.searchParams.get("code") ?? "")) return appPage("This link has expired. Run `pacer open` again.", 403);
    // A redirect without a fragment inherits the original fragment in the browser.
    return new Response(null, { status: 303, headers: {
      ...APP_HEADERS, "Cache-Control": "no-store", Location: "/app/",
      "Set-Cookie": `pacer_session=${createSession(ctx)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}`,
    } });
  }
  const path = url.pathname.slice("/app/".length);
  const file = APP_FILES.find(f => f.path === (path || "index.html"))
    ?? (!extname(path) ? APP_FILES.find(f => f.path === "index.html") : undefined);
  if (!file) return appPage("Not found.", 404);
  if (file.path === "index.html") {
    return new Response(req.method === "HEAD" ? null : file.text, { headers: { ...APP_HEADERS, "Content-Type": file.type, "Cache-Control": "no-store" } });
  }
  // Revalidate assets on every load so an updated pacer never runs a cached old app.
  const etag = `"${etagOf(file.text)}"`;
  const headers = { ...APP_HEADERS, "Content-Type": file.type, "Cache-Control": "no-cache", ETag: etag };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(req.method === "HEAD" ? null : file.text, { headers });
}

const etags = new Map<string, string>();
function etagOf(text: string): string {
  let tag = etags.get(text);
  if (!tag) { tag = createHash("sha256").update(text).digest("hex").slice(0, 32); etags.set(text, tag); }
  return tag;
}
