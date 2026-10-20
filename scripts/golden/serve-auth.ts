/**
 * Golden recorder for the public listener and authentication port (M1 plan 4, task 3 step 1).
 *
 * Runs the request table from .work/reviews/m1p4-t3-plan.md against the Bun server
 * (startServer from src/serve/http.ts on a temp home with pumpMs: 0) and records,
 * for each request, its status and body.
 *
 * HTML bodies are recorded as a sha256 of the body (bodySha256) with body: null;
 * every other body is recorded verbatim as `body`. Headers are recorded with
 * <port>, <token> and <cookie> placeholders instead of real values.
 *
 * Output: crates/server/tests/golden/serve-auth.json (deterministic).
 * The Rust port (crates/server/src/serve/auth.rs) must reproduce these byte for byte.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "../../test/helpers";
import { createSession } from "../../src/serve/app-auth";
import { startServer } from "../../src/serve/http";

const repoRoot = join(import.meta.dir, "..", "..");
const outDir = join(repoRoot, "crates", "server", "tests", "golden");
const outPath = join(outDir, "serve-auth.json");

interface Row { name: string; method: string; path: string; headers: Record<string, string>; body?: string }

// Temp home with a real session cookie, per the plan.
const ctx = fakeCtx();
const cookie = `pacer_session=${createSession(ctx)}`;

const server = startServer(() => ctx, { pumpMs: 0, port: 0 });
const port = server.port;
const token = server.token;

// Replace <port>, <token>, <cookie> placeholders with real values for the request.
const headers = (h: Record<string, string>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    out[k] = v.replace(/<port>/g, String(port)).replace(/<token>/g, token).replace(/<cookie>/g, cookie);
  }
  return out;
};

// The request table covering every branch of the TypeScript checks (m1p4-t3 plan step 1).
const rows: Row[] = [
  { name: "wrong-host", method: "GET", path: "/v3/hello", headers: { Host: "wrong.example.com" } },
  { name: "localhost-host-valid-bearer", method: "GET", path: "/v3/hello", headers: { Host: "localhost:<port>", Authorization: "Bearer <token>" } },
  { name: "options-app-x", method: "OPTIONS", path: "/app/x", headers: { Host: "127.0.0.1:<port>" } },
  { name: "options-v3-x", method: "OPTIONS", path: "/v3/x", headers: { Host: "127.0.0.1:<port>" } },
  { name: "health", method: "GET", path: "/health", headers: { Host: "127.0.0.1:<port>" } },
  { name: "app-auth-no-credentials", method: "GET", path: "/app/auth", headers: { Host: "127.0.0.1:<port>" } },
  { name: "valid-bearer-v3-hello", method: "GET", path: "/v3/hello", headers: { Host: "127.0.0.1:<port>", Authorization: "Bearer <token>" } },
  { name: "invalid-bearer-v3-hello", method: "GET", path: "/v3/hello", headers: { Host: "127.0.0.1:<port>", Authorization: "Bearer bad-token" } },
  { name: "invalid-bearer-app", method: "GET", path: "/app/", headers: { Host: "127.0.0.1:<port>", Authorization: "Bearer bad-token" } },
  { name: "cookie-session-exchange", method: "POST", path: "/v3/session/exchange", headers: { Host: "127.0.0.1:<port>", Cookie: "<cookie>" }, body: "{}" },
  { name: "cookie-version-get-no-client", method: "POST", path: "/v3/ops/version.get", headers: { Host: "127.0.0.1:<port>", Cookie: "<cookie>" }, body: "{}" },
  { name: "cookie-sec-fetch-site-cross-site", method: "GET", path: "/v3/hello", headers: { Host: "127.0.0.1:<port>", Cookie: "<cookie>", "Sec-Fetch-Site": "cross-site" } },
  { name: "cookie-get-v3-hello-same-origin", method: "GET", path: "/v3/hello", headers: { Host: "127.0.0.1:<port>", Cookie: "<cookie>", "Sec-Fetch-Site": "same-origin", Origin: `http://localhost:<port>` } },
  { name: "cookie-non-app-non-api", method: "GET", path: "/other", headers: { Host: "127.0.0.1:<port>", Cookie: "<cookie>" } },
  { name: "session-websocket-foreign-origin", method: "GET", path: "/v3/tasks/t-x/session", headers: { Host: "127.0.0.1:<port>", Cookie: "<cookie>", Origin: "http://example.com" } },
];

try {
  const results: unknown[] = [];
  for (const row of rows) {
    const init: RequestInit = { method: row.method, headers: headers(row.headers) };
    if (row.body !== undefined) init.body = row.body;
    const res = await fetch(`http://127.0.0.1:${port}${row.path}`, init);
    const text = await res.text();
    const contentType = res.headers.get("content-type") ?? "";
    const isHtml = contentType.includes("text/html");
    const entry: Record<string, unknown> = {
      name: row.name,
      method: row.method,
      path: row.path,
      headers: row.headers,
      status: res.status,
    };
    if (isHtml) {
      entry.body = null;
      entry.bodySha256 = createHash("sha256").update(text).digest("hex");
    } else {
      // The process id differs per run; the Rust side compares against the placeholder.
      entry.body = text.replace(/"pid":\d+/, '"pid":"<pid>"');
    }
    results.push(entry);
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, JSON.stringify(results, null, 1) + "\n");
  console.log(`wrote ${results.length} cases to ${outPath}`);
} finally {
  server.stop();
}