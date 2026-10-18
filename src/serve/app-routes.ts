import { createHash } from "node:crypto";
import tokens from "../../app/src/ds/tokens.css" with { type: "text" };
import { extname } from "node:path";
import { APP_FILES } from "../app/assets.generated";
import type { Ctx } from "../types";
import { createSession, redeemCode, SESSION_SECONDS } from "./app-auth";

export const APP_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const PAGE_STYLE = `${tokens}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: var(--space-5); background: var(--surface-page); color: var(--ink); font: var(--type-body-size)/var(--type-body-line) var(--font-sans); }
main { width: 100%; max-width: 440px; padding: var(--space-8); border: 1px solid var(--line); border-radius: var(--radius-xl); background: var(--surface-card); }
h1 { font-size: var(--type-display-size); line-height: var(--type-display-line); }
p { color: var(--ink-secondary); }
.button { display: inline-block; padding: var(--space-3) var(--space-4); border-radius: var(--radius-md); background: var(--ink); color: var(--ink-on-ink); text-decoration: none; font-weight: var(--type-body-strong-weight); }
a:focus-visible, input:focus-visible { outline: 2px solid var(--focus); outline-offset: 4px; }
input { display: block; width: 100%; margin-top: var(--space-2); padding: var(--space-3); border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--surface-page); color: var(--ink); font-family: var(--font-mono); }
`;
const PAGE_CSP = APP_HEADERS["Content-Security-Policy"].replace("style-src 'self'", `style-src 'self' 'sha256-${createHash("sha256").update(PAGE_STYLE).digest("base64")}'`);
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;", "'": "&#39;" })[char]!);
}
export function appPage(message: string, status: number): Response {
  const expired = status === 401 || (status === 403 && message.includes("link has expired"));
  const action = expired ? "Sign in again" : "Open pacer";
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>pacer</title><style>${PAGE_STYLE}</style></head><body${expired ? ' data-pacer-session-ended="true"' : ""}><main><h1>pacer</h1><p>${escapeHtml(message)}</p><a class="button" href="${expired ? "#sign-in" : "/app/"}">${action}</a><section id="sign-in"><p>Run this command in your terminal to open a fresh sign-in link.</p><label for="command">Select and copy command</label><input id="command" aria-label="Run pacer open" readonly value="pacer open"></section></main></body></html>`, {
    status, headers: { ...APP_HEADERS, "Content-Security-Policy": PAGE_CSP, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** Shared cookie policy for the browser code flow and desktop bearer exchange. */
export function sessionCookie(ctx: Ctx): string {
  return `pacer_session=${createSession(ctx)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}`;
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
      "Set-Cookie": sessionCookie(ctx),
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
