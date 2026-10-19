import * as healthListener from "../src/serve/health-listener";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../src/serve/http";
import { main } from "../src/cli";
import { fakeCtx } from "./helpers";

let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; });
async function serve() {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
  const s = startServer(() => ctx, { port: 0, pumpMs: 0 });
  stop = s.stop;
  ctx.env.PACER_PORT = String(s.port);
  const url = `http://127.0.0.1:${s.port}`;
  const codeUrl = async () => (await main(["open", "--print"], ctx)).out;
  const login = async () => {
    const auth = await fetch(await codeUrl(), { redirect: "manual" });
    expect(auth.status).toBe(200);
    return auth.headers.get("set-cookie")!.split(";")[0]!;
  };
  return { ctx, s, url, codeUrl, login };
}

test("Host is checked first, including health and OPTIONS", async () => {
  const { url, s } = await serve();
  for (const path of ["/health", "/v2/hello", "/app/auth?code=x"]) {
    expect((await fetch(url + path, { headers: { host: `evil.example:${s.port}` } })).status).toBe(421);
    expect((await fetch(url + path, { headers: { host: "127.0.0.1:1" } })).status).toBe(421);
  }
  expect((await fetch(url + "/health", { headers: { host: `localhost:${s.port}` } })).status).toBe(200);
});

test("open prints a working single-use URL and serves the protected app and hello", async () => {
  const { ctx, url, codeUrl } = await serve();
  const denied = await fetch(url + "/app/");
  expect(denied.status).toBe(401);
  expect(denied.headers.get("content-type")).toContain("text/html");
  const link = await codeUrl();
  expect(new URL(link).pathname).toBe("/app/auth");
  const auth = await fetch(link, { redirect: "manual" });
  expect(auth.status).toBe(200);
  const cookie = auth.headers.get("set-cookie")!;
  for (const attr of ["HttpOnly", "SameSite=Strict", "Path=/"]) expect(cookie).toContain(attr);
  const headers = { cookie: cookie.split(";")[0]! };
  const page = await fetch(url + "/app/", { headers });
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('<div id="app"></div>');
  expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
  expect(page.headers.get("x-content-type-options")).toBe("nosniff");
  expect(page.headers.get("referrer-policy")).toBe("no-referrer");
  expect(page.headers.get("cache-control")).toBe("no-store");
  expect((await fetch(url + "/v2/hello", { headers })).status).toBe(200);
  expect((await fetch(url + "/app/tasks/one", { headers })).status).toBe(200);
  expect((await fetch(url + "/app/missing.js", { headers })).status).toBe(404);
  expect(await (await fetch(url + "/app/app.js", { headers })).text()).toContain("/v2/hello");
  expect((await fetch(url + "/state", { headers })).status).toBe(401);
  const reused = await fetch(link, { redirect: "manual" });
  expect(reused.status).toBe(403);
  expect(await reused.text()).toContain("This link has expired. Run `pacer open` again.");
  for (const name of ["codes", "sessions"]) {
    const file = join(ctx.pacerHome, "app", name + ".json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain(new URL(link).searchParams.get("code")!);
    expect(text).not.toContain(headers.cookie.split("=")[1]!);
  }
  expect(statSync(join(ctx.pacerHome, "app")).mode & 0o777).toBe(0o700);
});

test("codes expire at 60 seconds", async () => {
  const { ctx, codeUrl } = await serve();
  const link = await codeUrl();
  const stored = readFileSync(join(ctx.pacerHome, "app", "codes.json"), "utf8");
  expect(stored).not.toContain(new URL(link).searchParams.get("code")!);
  ctx.now += 60;
  expect((await fetch(link, { redirect: "manual" })).status).toBe(403);
});

test("cookie mutations require Origin and app header; fetch metadata rejects other sites", async () => {
  const { url, login, s } = await serve();
  const cookie = await login();
  const post = (headers: Record<string, string>) => fetch(url + "/v2/ops/task.list", { method: "POST", headers: { cookie, "content-type": "application/json", ...headers }, body: "{}" });
  expect((await post({})).status).toBe(403);
  expect((await post({ origin: "http://evil.example", "x-pacer-client": "app" })).status).toBe(403);
  expect((await post({ origin: url })).status).toBe(403);
  expect((await post({ origin: url, "x-pacer-client": "app" })).status).toBe(200);
  expect((await post({ origin: `http://localhost:${s.port}`, "x-pacer-client": "app" })).status).toBe(200);
  for (const value of ["cross-site", "same-site", "unexpected"]) {
    expect((await fetch(url + "/v2/hello", { headers: { cookie, "sec-fetch-site": value } })).status).toBe(403);
  }
  expect((await fetch(url + "/v2/hello", { headers: { cookie, "sec-fetch-site": "same-origin" } })).status).toBe(200);
  expect((await post({ authorization: `Bearer ${s.token}` })).status).toBe(200);
  expect((await fetch(url + "/v2/hello", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  const options = await fetch(url + "/v2/hello", { method: "OPTIONS" });
  expect(options.status).toBe(405);
  expect([...options.headers.keys()].some(k => k.startsWith("access-control-"))).toBe(false);
});

test("sessions slide for 30 days, expire, and logout clears them", async () => {
  const { ctx, url, login } = await serve();
  const cookie = await login();
  ctx.now += 29 * 86400;
  expect((await fetch(url + "/v2/hello", { headers: { cookie } })).status).toBe(200);
  ctx.now += 29 * 86400;
  expect((await fetch(url + "/v2/hello", { headers: { cookie } })).status).toBe(200);
  ctx.now += 30 * 86400;
  expect((await fetch(url + "/v2/hello", { headers: { cookie } })).status).toBe(401);
  const fresh = await login();
  expect((await main(["open", "--logout"], ctx)).code).toBe(0);
  expect((await fetch(url + "/v2/hello", { headers: { cookie: fresh } })).status).toBe(401);
});

test("open uses the injected opener, keeps screen in the fragment, and reports a stopped daemon", async () => {
  const { ctx, s } = await serve();
  const { openCmd } = await import("../src/commands/open");
  const opened: string[] = [];
  expect((await openCmd(["tasks/one"], ctx, { opener: async url => { opened.push(url); } })).code).toBe(0);
  expect(new URL(opened[0]!).hash).toBe("#/sessions/one");
  s.stop(); stop = undefined;
  const down = await main(["open"], ctx);
  expect(down.code).toBe(1);
  expect(down.err).toContain("pacer isn't running. Start it with: pacer service install");
});

test("auth store uses hashed private records, single-use codes, and sliding sessions", async () => {
  const auth = await import("../src/serve/app-auth");
  const ctx = fakeCtx();
  expect(auth.safeEqual("same", "same")).toBe(true);
  expect(auth.safeEqual("same", "diff")).toBe(false);
  expect(auth.safeEqual("same", "shorter")).toBe(false);
  const code = auth.createCode(ctx);
  expect(code).toMatch(/^[a-f0-9]{64}$/);
  const codes = join(ctx.pacerHome, "app", "codes.json");
  expect(readFileSync(codes, "utf8")).not.toContain(code);
  expect(statSync(codes).mode & 0o777).toBe(0o600);
  expect(auth.redeemCode(ctx, "wrong")).toBe(false);
  expect(auth.redeemCode(ctx, code)).toBe(true);
  expect(auth.redeemCode(ctx, code)).toBe(false);
  const expired = auth.createCode(ctx);
  ctx.now += 60;
  expect(auth.redeemCode(ctx, expired)).toBe(false);
  const session = auth.createSession(ctx);
  const sessions = join(ctx.pacerHome, "app", "sessions.json");
  expect(readFileSync(sessions, "utf8")).not.toContain(session);
  expect(statSync(sessions).mode & 0o777).toBe(0o600);
  expect(statSync(join(ctx.pacerHome, "app")).mode & 0o777).toBe(0o700);
  expect(auth.checkSession(ctx, "wrong")).toBe(false);
  ctx.now += 29 * 86400;
  expect(auth.checkSession(ctx, session)).toBe(true);
  ctx.now += 29 * 86400;
  expect(auth.checkSession(ctx, session)).toBe(true);
  ctx.now += 30 * 86400;
  expect(auth.checkSession(ctx, session)).toBe(false);
  const fresh = auth.createSession(ctx);
  auth.clearSessions(ctx);
  expect(auth.checkSession(ctx, fresh)).toBe(false);
});

test("app routes exchange codes, set security headers, and serve only embedded assets", async () => {
  const { createCode } = await import("../src/serve/app-auth");
  const { appRoute } = await import("../src/serve/app-routes");
  const ctx = fakeCtx();
  const link = `http://127.0.0.1:4317/app/auth?code=${createCode(ctx)}`;
  const res = appRoute(new Request(link), ctx);
  // Sign-in hops to the app from a same-origin page so the Strict cookie is sent even when
  // the navigation started cross-site (the desktop shell's own page).
  expect(res.status).toBe(200);
  expect(res.headers.get("location")).toBeNull();
  const hop = await res.text();
  expect(hop).toContain('location.replace("/app/" + location.hash)');
  expect(hop).toContain('<meta http-equiv="refresh" content="0;url=/app/">');
  const csp = res.headers.get("content-security-policy")!;
  expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
  expect(csp).not.toContain("'unsafe-inline'");
  expect(res.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict; Path=/");
  expect(appRoute(new Request(link), ctx).status).toBe(403);
  for (const path of ["/app/", "/app/tasks/one"]) {
    const page = appRoute(new Request(`http://localhost:4317${path}`), ctx);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<div id="app"></div>');
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(page.headers.get("cache-control")).toBe("no-store");
  }
  expect(appRoute(new Request("http://localhost:4317/app/missing.js"), ctx).status).toBe(404);
});

test("HTTP browser access and open work through the server handler without a listening socket", async () => {
  const { spyOn } = await import("bun:test");
  const { createCode } = await import("../src/serve/app-auth");
  const { openCmd } = await import("../src/commands/open");
  const ctx = fakeCtx({ env: { PACER_PORT: "4317" } });
  mkdirSync(ctx.pacerHome, { recursive: true });
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
  let handler!: (req: Request, server: { port: number }) => Promise<Response>;
  const serveSpy = spyOn(Bun, "serve").mockImplementation(((opts: { fetch: typeof handler }) => {
    handler = opts.fetch;
    return { port: 4317, stop() {} };
  }) as typeof Bun.serve);
  const listenerSpy = spyOn(healthListener, "startHealthListener").mockReturnValue({ port: 4317, stop() {} });
  let s: ReturnType<typeof startServer>;
  try { s = startServer(() => ctx, { pumpMs: 0 }); stop = s.stop; }
  finally { serveSpy.mockRestore(); listenerSpy.mockRestore(); }
  const url = "http://127.0.0.1:4317";
  const request = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has("host")) headers.set("host", "127.0.0.1:4317");
    return handler(new Request(url + path, { ...init, headers }), { port: 4317 });
  };
  expect((await request("/health", { headers: { host: "evil.example:4317" } })).status).toBe(421);
  expect((await request("/health", { headers: { host: "localhost:1" } })).status).toBe(421);
  expect((await request("/health", { headers: { host: "localhost:4317" } })).status).toBe(200);
  expect((await request("/app/")).status).toBe(401);
  const options = await request("/v2/hello", { method: "OPTIONS" });
  expect(options.status).toBe(405);
  expect([...options.headers.keys()].some(k => k.startsWith("access-control-"))).toBe(false);
  const appOptions = await request("/app/", { method: "OPTIONS" });
  expect(appOptions.status).toBe(405);
  expect(appOptions.headers.get("content-security-policy")).toContain("script-src 'self'");
  const path = `/app/auth?code=${createCode(ctx)}`;
  const auth = await request(path);
  expect(auth.status).toBe(200);
  expect((await request(path)).status).toBe(403);
  const cookie = auth.headers.get("set-cookie")!.split(";")[0]!;
  expect((await request("/app/", { headers: { cookie } })).status).toBe(200);
  expect((await request("/v2/hello", { headers: { cookie } })).status).toBe(200);
  expect((await request("/state", { headers: { cookie } })).status).toBe(401);
  for (const site of ["cross-site", "same-site"]) {
    expect((await request("/v2/hello", { headers: { cookie, "sec-fetch-site": site } })).status).toBe(403);
  }
  const post = (headers: Record<string, string>) => request("/v2/ops/task.list", { method: "POST", headers: { cookie, "content-type": "application/json", ...headers }, body: "{}" });
  expect((await post({})).status).toBe(403);
  expect((await post({ origin: "http://evil.example", "x-pacer-client": "app" })).status).toBe(403);
  expect((await post({ origin: url })).status).toBe(403);
  expect((await post({ origin: url, "x-pacer-client": "app" })).status).toBe(200);
  expect((await post({ authorization: `Bearer ${s!.token}` })).status).toBe(200);
  expect((await request("/v2/hello", { headers: { authorization: "Bearer bad" } })).status).toBe(401);

  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    return request(target.pathname + target.search, init);
  }) as typeof fetch);
  try {
    const printed = await main(["open", "--print", "tasks/one"], ctx);
    expect(printed.code).toBe(0);
    expect(new URL(printed.out).hash).toBe("#/sessions/one");
    expect((await request(new URL(printed.out).pathname + new URL(printed.out).search)).status).toBe(200);
    const opened: string[] = [];
    expect((await openCmd([], ctx, { opener: async value => { opened.push(value); } })).code).toBe(0);
    expect(new URL(opened[0]!).pathname).toBe("/app/auth");
    expect((await main(["open", "--logout"], ctx)).code).toBe(0);
    expect((await request("/v2/hello", { headers: { cookie } })).status).toBe(401);
    fetchSpy.mockImplementation((async () => { throw Error("offline"); }) as unknown as typeof fetch);
    const down = await main(["open"], ctx);
    expect(down.code).toBe(1);
    expect(down.err).toBe("pacer isn't running. Start it with: pacer service install");
    fetchSpy.mockImplementation((async () => Response.json({ ok: true })) as unknown as typeof fetch);
    expect((await main(["open", "--print"], ctx)).code).toBe(1);
  } finally { fetchSpy.mockRestore(); }
});

test("open prefers an Orca browser tab when Orca is running, and --browser skips it", async () => {
  const { openInOrca } = await import("../src/commands/open");
  const calls: string[][] = [];
  const running = fakeCtx({ run: async argv => { calls.push(argv); return argv[1] === "status" ? { code: 0, stdout: "appRunning: true\nruntimeReachable: true\n", stderr: "" } : { code: 0, stdout: "", stderr: "" }; } });
  expect(await openInOrca(running, "http://127.0.0.1:4317/app/auth?code=x")).toBe(true);
  expect(calls.at(-1)).toEqual(["orca", "tab", "create", "--url", "http://127.0.0.1:4317/app/auth?code=x", "--worktree", "active"]);
  const stopped = fakeCtx({ run: async () => ({ code: 0, stdout: "runtimeReachable: false\n", stderr: "" }) });
  expect(await openInOrca(stopped, "u")).toBe(false);
  const absent = fakeCtx({ which: () => null });
  expect(await openInOrca(absent, "u")).toBe(false);
});

test("desktop exchanges a bearer for an app cookie; cookie-only exchange is forbidden", async () => {
  const { spyOn } = await import("bun:test");
  const { checkSession, createSession } = await import("../src/serve/app-auth");
  const ctx = fakeCtx();
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
  let handler!: (req: Request, server: { port: number }) => Promise<Response>;
  const spy = spyOn(Bun, "serve").mockImplementation(((opts: { fetch: typeof handler }) => {
    handler = opts.fetch;
    return { port: 4317, stop() {} };
  }) as typeof Bun.serve);
  const listenerSpy = spyOn(healthListener, "startHealthListener").mockReturnValue({ port: 4317, stop() {} });
  let s: ReturnType<typeof startServer>;
  try { s = startServer(() => ctx, { pumpMs: 0 }); stop = s.stop; }
  finally { spy.mockRestore(); listenerSpy.mockRestore(); }
  const url = "http://127.0.0.1:4317";
  const fetch = (target: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", "127.0.0.1:4317");
    return handler(new Request(target, { ...init, headers }), { port: 4317 });
  };
  const login = async () => `pacer_session=${createSession(ctx)}`;
  const path = url + "/v2/session/exchange";
  const headers = { authorization: `Bearer ${s.token}` };
  const res = await fetch(path, { method: "POST", headers });
  expect(res.status).toBe(204);
  expect(await res.text()).toBe("");
  expect(res.headers.get("cache-control")).toBe("no-store");
  const cookie = res.headers.get("set-cookie")!;
  expect(cookie).toContain("HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000");
  expect(checkSession(ctx, cookie.split(";")[0]!.slice("pacer_session=".length))).toBe(true);
  expect((await fetch(url + "/app/", { headers: { cookie: cookie.split(";")[0]! } })).status).toBe(200);
  ctx.now += 30 * 86400;
  const ended = await fetch(url + "/app/", { headers: { cookie: cookie.split(";")[0]! } });
  expect(ended.status).toBe(401);
  expect(await ended.text()).toContain('data-pacer-session-ended="true"');
  const exchanged = await fetch(path, { method: "POST", headers });
  expect(exchanged.status).toBe(204);
  const renewedCookie = exchanged.headers.get("set-cookie")!.split(";")[0]!;
  expect((await fetch(url + "/app/", { headers: { cookie: renewedCookie } })).status).toBe(200);
  expect((await fetch(path, { headers })).status).toBe(405);
  const session = await login();
  for (const extra of [{}, { origin: url, "x-pacer-client": "app" }] as Record<string, string>[]) {
    const denied = await fetch(path, { method: "POST", headers: { cookie: session, ...extra } });
    expect(denied.status).toBe(403);
    expect(denied.headers.has("set-cookie")).toBe(false);
  }
  expect((await fetch(path, { method: "POST" })).status).toBe(401);
  expect((await fetch(path, { method: "POST", headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  expect((await fetch(path, { method: "POST", headers: { ...headers, cookie: session } })).status).toBe(204);
});

test("script-free app error cards embed design tokens with an exact CSP style hash", async () => {
  const { createHash } = await import("node:crypto");
  const { appPage, appRoute } = await import("../src/serve/app-routes");
  const tokens = readFileSync(new URL("../app/src/ds/tokens.css", import.meta.url), "utf8");
  const ctx = fakeCtx();
  const responses = [
    appPage("Session ended. Run `pacer open`.", 401),
    appRoute(new Request("http://127.0.0.1:4317/app/auth?code=expired"), ctx),
    appRoute(new Request("http://127.0.0.1:4317/app/", { method: "POST" }), ctx),
    appRoute(new Request("http://127.0.0.1:4317/app/missing.css"), ctx),
    appPage("Forbidden.", 403),
  ];
  for (const response of responses) {
    const html = await response.text();
    expect(html).toContain(tokens);
    expect(html).toContain("font: var(--type-body-size)/var(--type-body-line) var(--font-sans)");
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain('<a class="button"');
    expect(html).toContain('readonly value="pacer open"');
    expect(html).not.toMatch(/<script|onclick=|javascript:/i);
    const style = html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
    const hash = createHash("sha256").update(style).digest("base64");
    const csp = response.headers.get("content-security-policy")!;
    expect(csp).toContain(`style-src 'self' 'sha256-${hash}'`);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(html.includes('data-pacer-session-ended="true"')).toBe(response.status === 401 || responses.indexOf(response) === 1);
  }
  const escaped = await appPage('<script>alert("test")</script>', 400).text();
  expect(escaped).toContain("&lt;script&gt;");
  expect(escaped).not.toContain("<script>");
});
