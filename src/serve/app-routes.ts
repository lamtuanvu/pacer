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
  return new Response(req.method === "HEAD" ? null : file.text, { headers: {
    ...APP_HEADERS, "Content-Type": file.type,
    ...(file.path === "index.html" ? { "Cache-Control": "no-store" } : {}),
  } });
}
