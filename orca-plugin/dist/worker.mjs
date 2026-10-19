// src/api/client-types.ts
class ApiError extends Error {
  code;
  hint;
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.name = "ApiError";
  }
}

// src/api/http-client.ts
class HttpClient {
  base;
  token;
  o;
  kind = "http";
  controller = new AbortController;
  subscriptions = new Set;
  constructor(base, token, o = {}) {
    this.base = base;
    this.token = token;
    this.o = o;
    const url = new URL(base);
    if (!/^http:\/\/127\.0\.0\.1:[0-9]+\/?$/.test(base) || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("pacer API base must be http://127.0.0.1:<port> without credentials");
    }
  }
  async request(path, params) {
    const response = await fetch(`${this.base}${path}`, {
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.o.timeoutMs ?? 15000)]),
      method: params === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      ...params === undefined ? {} : { body: JSON.stringify(params) }
    });
    if (!response.ok) {
      const text = await response.text();
      let error;
      try {
        error = JSON.parse(text).error;
      } catch {}
      if (error)
        throw new ApiError(error.code, error.message, error.hint);
      throw new ApiError(response.status === 401 ? "not_allowed" : "internal", `pacer serve: HTTP ${response.status} ${text.trim()}`.trim());
    }
    return await response.json();
  }
  hello() {
    return this.request("/v2/hello");
  }
  snapshot() {
    return this.request("/v2/snapshot");
  }
  async call(op, params) {
    const body = await this.request(`/v2/ops/${encodeURIComponent(op)}`, params ?? {});
    return body.result;
  }
  subscribe(since, onEvent) {
    let last = since;
    let stopped = false;
    let controller;
    let timer;
    const stop = () => {
      stopped = true;
      controller?.abort();
      clearTimeout(timer);
      this.subscriptions.delete(stop);
    };
    this.subscriptions.add(stop);
    const connect = async () => {
      controller = new AbortController;
      let reader;
      try {
        const response = await fetch(`${this.base}/v2/events?since=${last}`, {
          headers: { authorization: `Bearer ${this.token}`, "Last-Event-ID": String(last) },
          signal: controller.signal
        });
        if (!response.ok || !response.body)
          throw new Error("event stream unavailable");
        reader = response.body.getReader();
        const decoder = new TextDecoder;
        let buffer = "";
        while (!stopped) {
          const { value, done } = await reader.read();
          if (done)
            break;
          buffer += decoder.decode(value, { stream: true });
          let boundary;
          while (!stopped && (boundary = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary[0].length);
            let id;
            let type;
            const data = [];
            for (const line of frame.split(/\r?\n/)) {
              if (line.startsWith(":"))
                continue;
              const colon = line.indexOf(":");
              const field = colon < 0 ? line : line.slice(0, colon);
              const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
              if (field === "id")
                id = value;
              if (field === "event")
                type = value;
              if (field === "data")
                data.push(value);
            }
            const seq = Number(id);
            if (id === undefined || !Number.isSafeInteger(seq) || seq < 0 || !type || !data.length)
              continue;
            const parsed = JSON.parse(data.join(`
`));
            last = seq;
            onEvent({ seq, at: Date.now() / 1000, type, data: parsed });
          }
        }
      } catch {} finally {
        await reader?.cancel().catch(() => {});
        if (!stopped)
          timer = setTimeout(() => {
            connect();
          }, this.o.retryMs ?? 1000);
      }
    };
    connect();
    return stop;
  }
  close() {
    this.controller.abort();
    for (const stop of this.subscriptions)
      stop();
  }
}

// src/api/stdio-client.ts
import { spawn } from "node:child_process";
var MAX_LINE_BYTES = 1024 * 1024;

class StdioClient {
  argv;
  env;
  o;
  kind = "stdio";
  child;
  pending = new Map;
  subscriptions = new Set;
  nextId = 1;
  closed = false;
  backoffMs = 1000;
  restartTimer;
  constructor(argv, env, o = {}) {
    this.argv = argv;
    this.env = env;
    this.o = o;
    if (!argv.length)
      throw new Error("pacer argv must not be empty");
    this.start();
  }
  rejectPending() {
    for (const pending of this.pending.values())
      pending.reject(new ApiError("internal", "pacer api exited"));
    this.pending.clear();
  }
  restart() {
    if (this.closed)
      return;
    const delay = Math.min(this.backoffMs, this.o.maxBackoffMs ?? 30000);
    this.backoffMs = Math.min(this.backoffMs * 2, 30000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.start();
    }, delay);
  }
  start() {
    if (this.closed)
      return;
    let child;
    try {
      child = (this.o.spawn ?? spawn)(this.argv[0], [...this.argv.slice(1), "api", "--stdio"], {
        env: this.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (e) {
      this.o.log?.(String(e));
      this.restart();
      return;
    }
    this.child = child;
    let ended = false;
    const finish = () => {
      if (ended)
        return;
      ended = true;
      this.child = undefined;
      this.rejectPending();
      this.restart();
    };
    child.once("exit", finish);
    child.once("error", (e) => {
      this.o.log?.(e.message);
      finish();
    });
    child.stdin.on("error", (e) => {
      this.o.log?.(e.message);
      child.kill("SIGTERM");
      finish();
    });
    const lines = (stream, receive) => {
      let buffer = "";
      let dropping = false;
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        if (ended || this.closed)
          return;
        let offset = 0;
        while (offset < chunk.length) {
          const newline = chunk.indexOf(`
`, offset);
          const end = newline < 0 ? chunk.length : newline;
          const part = chunk.slice(offset, end);
          if (!dropping) {
            if (Buffer.byteLength(buffer) + Buffer.byteLength(part) > MAX_LINE_BYTES) {
              buffer = "";
              dropping = true;
              this.o.log?.("pacer api: dropped line over 1 MiB");
            } else
              buffer += part;
          }
          if (newline < 0)
            break;
          if (!dropping)
            receive(buffer.replace(/\r$/, ""));
          buffer = "";
          dropping = false;
          offset = newline + 1;
        }
      });
      stream.on("end", () => {
        if (!ended && !this.closed && !dropping && buffer)
          receive(buffer);
        buffer = "";
      });
    };
    lines(child.stdout, (line) => this.receive(line));
    lines(child.stderr, (line) => this.o.log?.(line));
    this.resubscribe();
  }
  receive(line) {
    let message;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return;
      message = parsed;
    } catch {
      this.o.log?.("pacer api: ignored malformed JSON line");
      return;
    }
    if (message.jsonrpc !== "2.0")
      return;
    this.backoffMs = 1000;
    if (message.method === "event") {
      const event = message.params;
      if (!event || !Number.isSafeInteger(event.seq) || event.seq < 0 || typeof event.type !== "string")
        return;
      for (const subscription of this.subscriptions) {
        if (event.seq <= subscription.since)
          continue;
        subscription.since = event.seq;
        try {
          subscription.onEvent(event);
        } catch (e) {
          this.o.log?.(String(e));
        }
      }
      return;
    }
    if (typeof message.id !== "number")
      return;
    const pending = this.pending.get(message.id);
    if (!pending)
      return;
    this.pending.delete(message.id);
    if (message.error) {
      const error = message.error;
      pending.reject(new ApiError(error.data?.code ?? "internal", error.message, error.data?.hint));
    } else
      pending.resolve(message.result);
  }
  request(method, params = {}) {
    const child = this.child;
    if (this.closed || !child)
      return Promise.reject(new ApiError("internal", "pacer api exited"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (result) => resolve(result), reject });
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}
`);
      } catch (e) {
        this.pending.delete(id);
        reject(new ApiError("internal", e instanceof Error ? e.message : String(e)));
      }
    });
  }
  hello() {
    return this.request("hello");
  }
  snapshot() {
    return this.request("snapshot");
  }
  call(op, params) {
    return this.request(op, params ?? {});
  }
  resubscribe() {
    if (!this.child || !this.subscriptions.size)
      return;
    const since = Math.min(...Array.from(this.subscriptions, (s) => s.since));
    this.request("subscribe", { since }).catch((e) => this.o.log?.(String(e)));
  }
  subscribe(since, onEvent) {
    if (this.closed)
      return () => {};
    const subscription = { since, onEvent };
    this.subscriptions.add(subscription);
    this.resubscribe();
    return () => {
      this.subscriptions.delete(subscription);
    };
  }
  close() {
    if (this.closed)
      return;
    this.closed = true;
    clearTimeout(this.restartTimer);
    this.subscriptions.clear();
    this.rejectPending();
    this.child?.kill("SIGTERM");
    this.child = undefined;
  }
}

// src/plugin/live.ts
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
function readLiveHeartbeat(pacerHome, now = Date.now() / 1000) {
  try {
    const value = JSON.parse(readFileSync(join(pacerHome, "plugin-live.json"), "utf8"));
    return typeof value.version === "string" && Number.isInteger(value.pid) && typeof value.at === "number" && now >= value.at && now - value.at < 90 ? value : null;
  } catch {
    return null;
  }
}
function writeLiveHeartbeat(pacerHome, heartbeat) {
  mkdirSync(pacerHome, { recursive: true });
  const path = join(pacerHome, "plugin-live.json"), temp = `${path}.${heartbeat.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(heartbeat));
    renameSync(temp, path);
  } finally {
    try {
      unlinkSync(temp);
    } catch {}
  }
}
function removeLiveHeartbeat(pacerHome, pid) {
  try {
    const path = join(pacerHome, "plugin-live.json");
    if (JSON.parse(readFileSync(path, "utf8")).pid === pid)
      unlinkSync(path);
  } catch {}
}

// src/update/check.ts
import { mkdirSync as mkdirSync2, readFileSync as readFileSync3, writeFileSync as writeFileSync2, renameSync as renameSync2 } from "node:fs";
import { join as join3 } from "node:path";
import { fileURLToPath } from "node:url";

// src/update/errors.ts
class ReleaseError extends Error {
  name = "ReleaseError";
}

// src/update/version.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
var DEV_VERSION = "0.0.0-dev";
var SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
function currentVersion() {
  if (typeof PACER_BUILD_VERSION === "string")
    return PACER_BUILD_VERSION;
  try {
    const pkg = JSON.parse(readFileSync2(join2(import.meta.dir, "..", "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" && SEMVER.test(pkg.version) ? pkg.version : DEV_VERSION;
  } catch {
    return DEV_VERSION;
  }
}
function isVersion(v) {
  return SEMVER.test(v);
}
function compareVersions(a, b) {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb)
    throw new ReleaseError(`invalid version: ${pa ? b : a}`);
  for (let i = 1;i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0)
      return Math.sign(d);
  }
  const ra = pa[4];
  const rb = pb[4];
  if (ra === rb)
    return 0;
  if (ra === undefined)
    return 1;
  if (rb === undefined)
    return -1;
  const xa = ra.split(".");
  const xb = rb.split(".");
  for (let i = 0;i < Math.max(xa.length, xb.length); i++) {
    const x = xa[i];
    const y = xb[i];
    if (x === undefined)
      return -1;
    if (y === undefined)
      return 1;
    if (x === y)
      continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny)
      return Math.sign(Number(x) - Number(y));
    if (nx)
      return -1;
    if (ny)
      return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

// src/update/manifest.ts
function parseLatest(raw) {
  const v = typeof raw === "object" && raw !== null ? raw.version : undefined;
  const s = typeof v === "string" ? v.replace(/^v/, "") : "";
  if (!isVersion(s))
    throw new ReleaseError(`latest.json has no valid "version" (got ${JSON.stringify(v ?? null)})`);
  return s;
}
var GITHUB_REPO = "lamtuanvu/pacer";
var GITHUB_RELEASE_BASE = `https://github.com/${GITHUB_REPO}/releases`;
function latestUrl(base) {
  return base === undefined ? `https://github.com/${GITHUB_REPO}/releases/latest/download/latest.json` : `${base}/latest.json`;
}

// src/update/fetch.ts
var ALLOWED_BASE = /^(https:\/\/|file:\/\/|http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$))/;
function normalizeBase(base) {
  const b = base.trim().replace(/\/+$/, "");
  if (!ALLOWED_BASE.test(b) || b.includes("@") || b.includes("?") || b.includes("#")) {
    throw new ReleaseError(`release base must start with https://, file://, or http://127.0.0.1 / http://localhost (got "${base}")`);
  }
  return b;
}
var MAX_REDIRECTS = 5;
async function fetchBytes(fetchFn, url, maxBytes = Number.POSITIVE_INFINITY) {
  let res;
  let current = url;
  try {
    for (let hops = 0;; hops++) {
      res = await fetchFn(current);
      if (res.status < 300 || res.status >= 400)
        break;
      await res.body?.cancel();
      const location = res.headers.get("location");
      if (!location)
        throw new Error(`redirect HTTP ${res.status} has no Location`);
      if (hops >= MAX_REDIRECTS)
        throw new Error(`redirect limit (${MAX_REDIRECTS}) exceeded`);
      const next = new URL(location, current);
      if (next.protocol !== "https:" || next.username || next.password)
        throw new Error("redirect must target https:// without user info");
      current = next.href;
    }
  } catch (e) {
    throw new ReleaseError(`download failed: ${url} (${e.message})`);
  }
  if (!res.ok)
    throw new ReleaseError(`download failed: ${url} (HTTP ${res.status})`);
  const declaredLength = res.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    await res.body?.cancel();
    throw new ReleaseError(`download failed: ${url} (exceeds ${maxBytes} byte limit)`);
  }
  try {
    if (!res.body)
      return new Uint8Array;
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done)
        break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ReleaseError(`download failed: ${url} (exceeds ${maxBytes} byte limit)`);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (e) {
    if (e instanceof ReleaseError)
      throw e;
    throw new ReleaseError(`download failed: ${url} (${e.message})`);
  }
}
async function fetchText(fetchFn, url) {
  return new TextDecoder().decode(await fetchBytes(fetchFn, url, 1024 * 1024));
}

// src/update/check.ts
var UPDATE_CACHE_S = 86400;
var UPDATE_TIMEOUT_MS = 3000;
function updateChecksEnabled(ctx) {
  if (ctx.env.PACER_NO_UPDATE_CHECK === "1")
    return false;
  try {
    let active = "";
    try {
      active = readFileSync3(join3(ctx.pacerHome, "active"), "utf8").trim();
    } catch {}
    const path = active && /^[\w-]+$/.test(active) ? join3(ctx.pacerHome, "strategies", `${active}.yaml`) : join3(ctx.pacerHome, "strategy.yaml");
    return !/^update_check:\s*false\s*(?:#.*)?$/m.test(readFileSync3(path, "utf8"));
  } catch {
    return true;
  }
}
function readUpdateCheck(ctx, current = currentVersion()) {
  if (!updateChecksEnabled(ctx))
    return null;
  try {
    const v = JSON.parse(readFileSync3(join3(ctx.pacerHome, "update-check.json"), "utf8"));
    if (!Number.isFinite(v.checkedAt) || v.latest !== null && !isVersion(v.latest))
      return null;
    return { ...v, current };
  } catch {
    return null;
  }
}
function updateAvailable(check) {
  return !!check?.latest && isVersion(check.current) && compareVersions(check.latest, check.current) > 0;
}
async function checkForUpdate(ctx, options = {}) {
  if (!updateChecksEnabled(ctx))
    return null;
  const current = options.current ?? currentVersion(), cached = readUpdateCheck(ctx, current);
  if (!options.force && cached && ctx.now >= cached.checkedAt && ctx.now - cached.checkedAt < UPDATE_CACHE_S)
    return cached;
  const result = { checkedAt: ctx.now, latest: cached?.latest ?? null, current };
  const controller = new AbortController;
  let timer;
  try {
    const raw = options.base ?? ctx.env.PACER_RELEASE_BASE;
    const url = latestUrl(raw ? normalizeBase(raw) : undefined);
    const fetcher = options.fetch ?? (async (url) => url.startsWith("file://") ? new Response(await import("node:fs/promises").then((fs) => fs.readFile(fileURLToPath(url)))) : fetch(url, { signal: controller.signal, redirect: "manual" }));
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("update check timed out"));
      }, options.timeoutMs ?? UPDATE_TIMEOUT_MS);
    });
    result.latest = await Promise.race([fetchText(fetcher, url).then((text) => parseLatest(JSON.parse(text))), timeout]);
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
  }
  if (!(("readOnly" in ctx) && ctx.readOnly))
    try {
      mkdirSync2(ctx.pacerHome, { recursive: true });
      const path = join3(ctx.pacerHome, "update-check.json"), temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
      writeFileSync2(temp, JSON.stringify(result) + `
`);
      renameSync2(temp, path);
    } catch {}
  return result;
}

// orca-plugin/src/worker.ts
import { execFile as execFile2 } from "node:child_process";
import { mkdirSync as mkdirSync4 } from "node:fs";
// package.json
var package_default = {
  name: "pacer",
  type: "module",
  private: true,
  devDependencies: {
    "@types/bun": "^1.4.2",
    "playwright-core": "1.58.2",
    "preact-render-to-string": "^6.8.1",
    typescript: "^7.0.2"
  },
  version: "0.2.3",
  bin: {
    pacer: "src/cli.ts"
  },
  scripts: {
    test: "TZ=Asia/Ho_Chi_Minh bun test",
    live: "bun scripts/live/cli.ts",
    typecheck: "tsc --noEmit && tsc -p app",
    build: "bun scripts/build.ts",
    release: "bun scripts/release/build.ts",
    "release:prepare": "bun scripts/release/prepare.ts",
    "release:host": "bun scripts/release/build.ts --host",
    "plugin:build": "bun orca-plugin/build.ts",
    "protocol:doc": "bun scripts/protocol-doc.ts",
    "release:npm": "bun scripts/release/npm.ts",
    "release:homebrew": "bun scripts/release/homebrew.ts",
    "brand:render": "bun scripts/brand/render.ts",
    "app:build": "bun app/build.ts",
    "test:e2e": "PACER_E2E=1 TZ=Asia/Ho_Chi_Minh bun test test/install-signin-delegation.test.ts"
  },
  dependencies: {
    "@modelcontextprotocol/sdk": "1.32.1",
    "@xterm/addon-fit": "0.11.0",
    "@xterm/addon-serialize": "0.14.0",
    "@xterm/headless": "6.0.0",
    "@xterm/xterm": "6.0.0",
    preact: "10.29.8",
    yaml: "2.8.2",
    zod: "4.6.5"
  },
  license: "Apache-2.0",
  description: "Subscription-budget-aware delegation for AI coding agents through a CLI, MCP server and Orca plugin.",
  author: "Vu Lam",
  repository: {
    type: "git",
    url: "git+https://github.com/lamtuanvu/pacer.git"
  },
  homepage: "https://github.com/lamtuanvu/pacer#readme",
  bugs: {
    url: "https://github.com/lamtuanvu/pacer/issues"
  },
  keywords: [
    "ai-agents",
    "subscription-budgets",
    "delegation",
    "cli",
    "mcp",
    "claude-code",
    "codex",
    "orca",
    "bun"
  ],
  engines: {
    bun: ">=1.4.2"
  }
};

// orca-plugin/src/mode.ts
import { join as join4 } from "node:path";
function pluginMode(pluginRoot, fs) {
  return fs.exists(join4(pluginRoot, ".pacer-managed")) ? "live" : "bootstrap";
}

// src/install/fsx.ts
function shq(s) {
  return /^[A-Za-z0-9_\/.:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}
function shellCommand(argv) {
  return argv.map(shq).join(" ");
}
// src/config/accounts.ts
var AGENTS = ["claude-code", "codex", "cursor", "agy", "opencode"];

// src/config/runner-id.ts
function parseRunnerId(id) {
  const m = /^([a-z0-9][a-z0-9-]*)(?:#([a-z0-9][a-z0-9-]*))?(?:@([a-z0-9][a-z0-9-]*))?$/.exec(id);
  if (!m || !AGENTS.includes(m[1]))
    return null;
  return { agent: m[1], account: m[2] ?? null, host: m[3] === "local" ? null : m[3] ?? null };
}
// src/config/strategy.ts
var PLANNERS = ["claude-code", "codex", "cursor", "opencode"];

// src/setup/checklist.ts
function updateChecklist(s, f) {
  const ranked = f.executors?.ranked ?? [], excluded = f.executors?.excluded ?? [];
  const items = s.items.map((i) => {
    if (i.id === "executor")
      return {
        ...i,
        status: ranked.length ? "done" : "pending",
        detail: ranked.length ? ranked.map((e) => e.id).join(", ") : excluded.length ? excluded.map((e) => `${e.id}: ${e.reason}`).join("; ") : "no executor configured",
        command: ranked.length ? undefined : "pacer runner add",
        action: ranked.length ? undefined : "nav:add-executor"
      };
    if (i.id === "usage")
      return { ...i, status: f.verdict && f.verdict !== "UNKNOWN" ? "done" : "pending" };
    if (i.id === "first" && (f.reviewed || f.skipped))
      return { ...i, status: "done", action: undefined, ...f.skipped ? { detail: "Skipped" } : {} };
    return i;
  });
  const complete = items.filter((i) => i.required).every((i) => i.status === "done");
  return { ...s, items, complete, ready: complete && ["executor", "first"].every((id) => items.some((i) => i.id === id && i.status === "done")) };
}
function setupChecklist(f, checkedAt) {
  const item = (id, title, required, done, detail, command, action, error) => ({ id, title, required, status: error ? "failed" : done ? "done" : "pending", ...error || detail ? { detail: error ?? detail } : {}, ...!done || error ? { ...command ? { command } : {}, ...action ? { action } : {} } : {} });
  const plannerAgent = f.planner?.split(/[#@]/)[0];
  const items = [
    item("binary", "pacer", true, !!f.version, f.version ?? undefined, "pacer init", undefined, f.errors?.binary),
    f.planner ? item("planner", "Planner", true, f.signedIn !== false, `${f.planner}${f.signedIn === false ? " · signed out" : ""}`, f.loginCommand, undefined, f.errors?.strategy) : { ...item("planner", "Planner", true, false, "Choose which agent plans your work", "pacer init", "setup.init"), options: PLANNERS.filter((id) => f.agents.some((a) => a.id === id && a.cliInstalled)) },
    item("service", "Background service", true, f.service.installed && f.service.running, undefined, "pacer service install", "service.install", f.errors?.service),
    { ...item("connect", "Connect planner", true, !!f.planner && f.connected !== false, f.connected !== false ? "Connected" : "Integration missing or changed", "pacer init", "agent.connect", f.errors?.connect), ...plannerAgent ? { agent: plannerAgent, installed: f.agents.find((a) => a.id === plannerAgent)?.cliInstalled ?? false } : {} },
    item("link", "Link", true, f.link, undefined, "pacer init", undefined, f.errors?.link),
    item("executor", "Executor", false, false),
    item("usage", "Budget data", false, !!f.verdict && f.verdict !== "UNKNOWN", `Start a session in ${f.planner ?? "your planner"} once`),
    item("first", "First delegation", false, !!f.reviewed || !!f.skipped, f.skipped ? "Skipped" : undefined, undefined, "onboarding.try"),
    ...f.orcaInstalled ? [item("live", "Orca panel", false, f.live, undefined, "pacer init")] : [],
    ...f.agents.filter((a) => a.id !== plannerAgent).map((a) => ({ ...item(`agent:${a.id}`, a.name, false, a.installed, a.installed ? "Connected" : "Optional · not connected", "pacer init", "agent.connect"), agent: a.id, ...a.cliInstalled !== undefined ? { installed: a.cliInstalled } : {} }))
  ];
  return updateChecklist({ checkedAt, complete: false, ready: false, items }, f);
}

// orca-plugin/src/worktree.ts
async function resolveFocusedWorktree(host, exec, cli) {
  const context = await host.call("workspace.readContext");
  if (!context?.branch)
    return null;
  if (context.worktreeId)
    return { id: context.worktreeId };
  const reply = JSON.parse(await exec(cli, ["worktree", "list", "--json"]));
  if (reply.ok === false)
    throw new Error(reply.error?.message || "Could not list Orca worktrees");
  const matches = (reply.result?.worktrees ?? []).filter((w) => typeof w.id === "string" && w.branch === context.branch && w.displayName === context.displayName);
  const activity = (at) => typeof at === "number" ? at : typeof at === "string" ? Date.parse(at) || 0 : 0;
  matches.sort((a, b) => activity(b.lastActivityAt) - activity(a.lastActivityAt));
  return matches.length ? { id: matches[0].id } : null;
}
// orca-plugin/src/bootstrap.ts
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, existsSync as existsSync2, mkdirSync as mkdirSync3, readFileSync as readFileSync5, renameSync as renameSync3, chmodSync, unlinkSync as unlinkSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { readFile } from "node:fs/promises";
import { join as join6, delimiter } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/install/detection.ts
import { existsSync, readdirSync, readFileSync as readFileSync4 } from "node:fs";
import { join as join5 } from "node:path";
var AGENT_BINS = { "claude-code": ["claude"], codex: ["codex"], cursor: ["cursor-agent", "cursor"], opencode: ["opencode"] };
var names = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", opencode: "OpenCode" };
function agentPlans(home, pacerHome, which, env = {}) {
  let installed = {};
  try {
    installed = JSON.parse(readFileSync4(join5(pacerHome, "install-manifest.json"), "utf8")).planners ?? {};
  } catch {}
  return Object.keys(AGENT_BINS).filter((id) => AGENT_BINS[id].some((bin) => which(bin))).map((id) => {
    const root = id === "opencode" ? join5(env.XDG_CONFIG_HOME || join5(home, ".config"), "opencode") : join5(home, id === "claude-code" ? ".claude" : `.${id}`);
    const skillRoot = id === "codex" ? env.CODEX_HOME || root : root;
    const files = [join5(skillRoot, "skills/pacer/SKILL.md"), ...{
      "claude-code": [join5(root, "rules/pacer.md"), join5(root, "settings.json")],
      codex: [join5(root, "AGENTS.md"), join5(root, "hooks.json")],
      cursor: [join5(root, "hooks.json")],
      opencode: [join5(root, "AGENTS.md")]
    }[id]];
    if (id === "claude-code") {
      try {
        const command = JSON.parse(readFileSync4(join5(root, "settings.json"), "utf8")).statusLine?.command;
        if (typeof command === "string" && !/\s/.test(command)) {
          const path = command.replace(/^~(?=\/)/, home).replace(/^\$HOME(?=\/)/, home);
          if (path.startsWith("/") && existsSync(path) && /^input=\$\(cat\)\s*$/m.test(readFileSync4(path, "utf8")))
            files.push(path);
        }
      } catch {}
      files.push(...["scripts/budget/budget_status.py", "scripts/budget/subagent_guard.py", "scripts/budget/budget-status", "rules/model-delegation.md"].map((p) => join5(root, p)).filter(existsSync));
      const delegation = join5(root, "agents/delegation");
      if (existsSync(delegation))
        files.push(...readdirSync(delegation).filter((p) => p.endsWith(".md")).sort().map((p) => join5(delegation, p)));
    }
    return { id, name: names[id], installed: !!installed[id], files, undo: `pacer uninstall ${id}` };
  });
}

// orca-plugin/src/bootstrap.ts
var GITHUB_RELEASES = "https://github.com/lamtuanvu/pacer/releases";
var UNPUBLISHED = "pacer isn't published yet. Set the release folder in plugin settings or install pacer manually";
var MANUAL_INSTALL = "curl -fsSL https://raw.githubusercontent.com/lamtuanvu/pacer/main/install.sh | sh";
function cleanEnv(env) {
  const result = { ...env };
  delete result.ORCA_AGENT_SESSION_ID;
  delete result.ORCA_TERMINAL_HANDLE;
  return result;
}
function releaseBase(setting, env) {
  const base = (typeof setting === "string" && setting.trim() ? setting.trim() : env.PACER_RELEASE_BASE || GITHUB_RELEASES).replace(/\/+$/, "");
  const u = new URL(base);
  if (u.username || u.password || u.search || u.hash || !(u.protocol === "https:" || u.protocol === "file:" && (!u.hostname || u.hostname === "localhost") || u.protocol === "http:" && ["127.0.0.1", "localhost"].includes(u.hostname)))
    throw new Error("Use an HTTPS, file:// or localhost release folder.");
  return base;
}
function releaseURL(base, version, name) {
  return base === GITHUB_RELEASES ? name === "latest.json" ? `${base}/latest/download/latest.json` : `${base}/download/v${version}/${name}` : name === "latest.json" ? `${base}/latest.json` : `${base}/${version}/${name}`;
}
async function download(url, fetcher = fetch, signal = AbortSignal.timeout(120000)) {
  releaseBase(url, {});
  if (url.startsWith("file:"))
    return readFile(fileURLToPath2(url), { signal });
  for (let hops = 0;; hops++) {
    const response = await fetcher(url, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || hops >= 5)
        throw new Error("Release redirect limit exceeded.");
      const next = new URL(location, url);
      if (next.protocol !== "https:" || next.username || next.password)
        throw new Error("Release redirects must use HTTPS.");
      await response.body?.cancel();
      url = next.href;
      continue;
    }
    if (!response.ok)
      throw new Error(`Release download HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
}
function runFile(bin, args, env, timeout) {
  return new Promise((resolve, reject) => execFile(bin, args, { env, timeout, maxBuffer: 1024 * 1024 }, (err, stdout) => err ? reject(err) : resolve(stdout)));
}
function which(bin, env) {
  for (const dir of (env.PATH || "").split(delimiter).filter(Boolean)) {
    const path = join6(dir, bin);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {}
  }
  return null;
}
function resolveOrcaCli(env) {
  return env.ORCA_CLI_COMMAND || which("orca", env) || (existsSync2("/Applications/Orca.app/Contents/Resources/bin/orca") ? "/Applications/Orca.app/Contents/Resources/bin/orca" : "orca");
}
function createBootstrap(d) {
  const now = d.now ?? (() => Date.now() / 1000), exec = d.exec ?? runFile, env = cleanEnv(d.env);
  const home = d.home, pacerHome = join6(home, ".pacer"), platform = d.platform ?? process.platform;
  let state = { install: { status: "pending" }, start: { status: "pending" }, agents: [] };
  let running = null, terminalRunning = false, stopped = false, probedAt = -Infinity;
  const changed = async (ctx, onChange) => {
    if (d.mode === "bootstrap") {
      const message = state.install.status === "failed" || state.start.status === "failed" ? `pacer setup couldn't open. Run ${state.binary || "~/.local/bin/pacer"} init in a terminal. ${state.install.detail || ""}` : null;
      if (message)
        await notify(ctx, message, `failure:${d.version}`);
    }
    onChange();
    try {
      await ctx.host.call("storage.set", { key: "bootstrap", value: state });
    } catch {}
  };
  async function notify(ctx, message, key = message) {
    if (state.notifications?.includes(key))
      return;
    state.notifications = [...state.notifications ?? [], key];
    await ctx.host.call("storage.set", { key: "bootstrap", value: state });
    await ctx.host.call("notifications.show", { title: message }).catch(() => {});
  }
  async function activate(ctx) {
    stopped = false;
    try {
      const saved = (await ctx.host.call("storage.get", { key: "bootstrap" })).value;
      if (saved && saved.install && saved.start)
        state = { ...state, install: saved.install ?? state.install, start: saved.start ?? state.start, binary: saved.binary, agents: saved.agents ?? [], nextAt: saved.nextAt, failures: saved.failures, restarts: saved.restarts, terminalAttempts: saved.terminalAttempts, notifications: saved.notifications, handoffVersion: saved.handoffVersion, dashboardSessions: saved.dashboardSessions, dashboardReadySessions: saved.dashboardReadySessions };
    } catch {}
  }
  async function cycle(ctx, onChange) {
    if (stopped)
      return;
    if (d.mode === "live") {
      if (now() < (state.nextAt ?? 0))
        return;
      state.nextAt = now() + 30;
      const binary = env.PACER_BIN || (existsSync2(join6(home, ".local/bin/pacer")) ? join6(home, ".local/bin/pacer") : which("pacer", env));
      state.binary = binary ?? undefined;
      state.install = { status: binary ? "done" : "pending" };
      try {
        const service = binary ? JSON.parse(await exec(binary, ["service", "status", "--json"], env, 30000)) : null;
        state.start = { status: existsSync2(join6(pacerHome, "strategy.yaml")) && service?.installed ? "done" : "pending" };
      } catch {
        state.start = { status: "pending", detail: "Run pacer init to finish setup." };
      }
      await changed(ctx, onChange);
      return;
    }
    if (readLiveHeartbeat(pacerHome, now())) {
      state.nextAt = now() + 30;
      if (state.handoffVersion !== d.version) {
        state.handoffVersion = d.version;
        await notify(ctx, "pacer now runs from its live panel. You can uninstall the marketplace copy in Orca Settings > Plugins.", `live:${d.version}`);
      }
      await changed(ctx, onChange);
      return;
    }
    if (now() < (state.nextAt ?? 0))
      return;
    state.nextAt = now() + 600;
    let step = "install";
    try {
      const settings = await ctx.host.call("settings.get").catch(() => ({ settings: {} }));
      const base = releaseBase(settings.settings.releaseBase, env);
      let binary = env.PACER_BIN || (existsSync2(join6(home, ".local/bin/pacer")) ? join6(home, ".local/bin/pacer") : which("pacer", env));
      state.install = { status: "pending" };
      state.start = { status: "pending" };
      await changed(ctx, onChange);
      if (!binary) {
        if (!["darwin", "linux"].includes(platform) || !["arm64", "x64"].includes(d.arch ?? process.arch))
          throw new Error("This platform needs a manual pacer install.");
        const name = `pacer-${platform}-${d.arch ?? process.arch}`, signal = AbortSignal.timeout(120000);
        const sums = (await download(releaseURL(base, d.version, "SHA256SUMS"), d.fetch, signal)).toString();
        const match = sums.split(/\r?\n/).map((line) => /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line)).find((m) => m?.[2] === name);
        if (!match)
          throw new Error("The release checksum is missing.");
        const bytes = await download(releaseURL(base, d.version, name), d.fetch, signal);
        if (createHash("sha256").update(bytes).digest("hex") !== match[1].toLowerCase())
          throw new Error("The pacer download failed its checksum check.");
        const dir = join6(home, ".local/bin");
        mkdirSync3(dir, { recursive: true });
        const temporary = join6(dir, `.pacer-${randomUUID()}.tmp`);
        try {
          writeFileSync3(temporary, bytes, { flag: "wx", mode: 384 });
          chmodSync(temporary, 493);
          renameSync3(temporary, join6(dir, "pacer"));
        } finally {
          try {
            unlinkSync2(temporary);
          } catch {}
        }
        binary = join6(dir, "pacer");
      } else {
        const output = (await exec(binary, ["--version"], env, 30000)).trim().replace(/^pacer\s+/, "");
        if (isVersion(output) && !output.includes("dev") && compareVersions(output, d.version) < 0) {
          await exec(binary, ["update", "--to", d.version], base === GITHUB_RELEASES ? { ...env, PACER_RELEASE_BASE: undefined } : { ...env, PACER_RELEASE_BASE: base }, 120000);
        }
      }
      state.binary = binary;
      state.install = { status: "done" };
      step = "start";
      state.start = { status: "pending" };
      await changed(ctx, onChange);
      const cli = resolveOrcaCli(env);
      const focused = await resolveFocusedWorktree(ctx.host, (bin, args) => exec(bin, args, env, 30000), cli);
      if (!focused) {
        state.nextAt = now() + 30;
        return;
      }
      const service = JSON.parse(await exec(binary, ["service", "status", "--json"], env, 30000));
      const command = existsSync2(join6(pacerHome, "strategy.yaml")) && service.installed ? "dashboard" : "init";
      const status = JSON.parse(await exec(cli, ["status", "--json"], env, 30000));
      const pid = status.result?.app?.pid ?? status.app?.pid;
      if (typeof pid !== "number")
        throw new Error("Could not identify the Orca launch.");
      const session = `pid:${pid}`;
      if (!state.dashboardSessions?.includes(session)) {
        state.dashboardSessions = [...state.dashboardSessions ?? [], session].slice(-20);
        await ctx.host.call("storage.set", { key: "bootstrap", value: state });
        const result = JSON.parse(await exec(cli, ["terminal", "create", "--worktree", `id:${focused.id}`, "--title", "pacer", "--command", shellCommand([binary, command]), "--json"], env, 30000));
        if (result.ok !== true)
          throw new Error(result.error?.message || "Could not open the pacer terminal.");
        state.dashboardReadySessions = [...state.dashboardReadySessions ?? [], session].slice(-20);
      }
      state.start = { status: "done" };
      state.dashboardOpened = state.dashboardReadySessions?.includes(session);
      state.dashboardFailed = !state.dashboardOpened;
    } catch (e) {
      const message = e.message;
      const unpublished = message.includes("HTTP 404");
      state[step] = { status: "failed", detail: unpublished ? UNPUBLISHED : step === "install" ? message.split(/\r?\n/)[0].slice(0, 160) : "pacer couldn't start. Try again shortly." };
      state.failures = (state.failures ?? []).filter((at) => now() - at < 3600);
      state.failures.push(now());
      state.nextAt = d.mode === "bootstrap" && state.failures.length >= 5 ? state.failures[0] + 3600 : now() + (unpublished || state.failures.length >= 5 ? 600 : 60);
      ctx.log(`pacer bootstrap: ${message}`);
    } finally {
      state.agents = agentPlans(home, pacerHome, (bin) => which(bin, env), env);
      await changed(ctx, onChange);
    }
  }
  return {
    activate,
    get state() {
      return state;
    },
    run(ctx, onChange) {
      if (!running)
        running = cycle(ctx, onChange).finally(() => {
          running = null;
        });
      return running;
    },
    async refreshAgents(ctx, onChange) {
      if (stopped)
        return;
      if (d.mode === "bootstrap")
        return;
      const agents = agentPlans(home, pacerHome, (bin) => which(bin, env), env);
      if (JSON.stringify(agents) !== JSON.stringify(state.agents)) {
        state.agents = agents;
        await changed(ctx, onChange);
      }
      if (terminalRunning || state.start.status !== "done" || !state.agents.some((a) => !a.installed) || now() - probedAt < 30)
        return;
      terminalRunning = true;
      probedAt = now();
      try {
        const context = await ctx.host.call("workspace.readContext");
        if (!context)
          return;
        let available = context.terminals.find((t) => t.writable === true && !t.agent && !/^pacer(?: console)?$/.test(t.title ?? ""));
        for (const candidate of context.terminals) {
          if (available)
            break;
          if (candidate.writable === false || candidate.agent || /^pacer(?: console)?$/.test(candidate.title ?? ""))
            continue;
          try {
            const reply = JSON.parse(await exec(resolveOrcaCli(env), ["terminal", "show", "--terminal", candidate.id, "--json"], env, 30000));
            const terminal = reply.result?.terminal;
            if (reply.ok && terminal?.connected && terminal.writable && !terminal.agent && !terminal.agentSessionId && !/^pacer(?: console)?$/.test(terminal.title ?? ""))
              available = candidate;
          } catch {}
        }
        if (available) {
          if (state.terminal !== available.id || state.opening) {
            state.terminal = available.id;
            state.opening = false;
            await changed(ctx, onChange);
          }
          return;
        }
        state.terminal = undefined;
        const focused = await resolveFocusedWorktree(ctx.host, (bin, args) => exec(bin, args, env, 30000), resolveOrcaCli(env));
        if (!focused)
          return;
        const id = focused.id;
        state.terminalAttempts ??= {};
        if (now() - (state.terminalAttempts[id] ?? -Infinity) < 600)
          return;
        state.terminalAttempts[id] = now();
        state.opening = true;
        await changed(ctx, onChange);
        await exec(resolveOrcaCli(env), ["terminal", "create", "--worktree", `id:${id}`, "--title", "pacer setup", "--json"], env, 30000);
      } catch (e) {
        state.opening = false;
        ctx.log(`pacer setup terminal: ${e.message}`);
        await changed(ctx, onChange);
      } finally {
        terminalRunning = false;
      }
    },
    async checkSetup(reachable, stateHome = pacerHome) {
      const binary = env.PACER_BIN || (existsSync2(join6(home, ".local/bin/pacer")) ? join6(home, ".local/bin/pacer") : which("pacer", env));
      const errors = {};
      let version = null, planner = null, service = { installed: false, running: false };
      if (binary)
        try {
          const value = (await exec(binary, ["--version"], env, 3000)).trim().replace(/^pacer\s+/, "");
          if (isVersion(value))
            version = value;
          else
            errors.binary = "Could not read pacer version.";
        } catch {
          errors.binary = "Could not run pacer --version.";
        }
      try {
        let active = "";
        try {
          active = readFileSync5(join6(stateHome, "active"), "utf8").trim();
        } catch {}
        const text = readFileSync5(active ? join6(stateHome, "strategies", `${active}.yaml`) : join6(stateHome, "strategy.yaml"), "utf8");
        const value = text.trim().startsWith("{") ? JSON.parse(text).planner : text.match(/^planner\s*:\s*(["']?)([a-z][a-z0-9-]*)\1\s*(?:#.*)?$/m)?.[2];
        if (["claude-code", "codex", "cursor", "opencode"].includes(value))
          planner = value;
        else
          errors.strategy = "Strategy needs a supported planner.";
      } catch {}
      if (binary)
        try {
          service = JSON.parse(await exec(binary, ["service", "status", "--json"], { ...env, PACER_HOME: stateHome }, 3000));
        } catch {
          errors.service = "Could not check the login service.";
        }
      state.agents = agentPlans(home, stateHome, (bin) => which(bin, env), env);
      return setupChecklist({ version, planner, service, link: reachable, live: true, agents: state.agents, errors }, now());
    },
    stop() {
      stopped = true;
    }
  };
}

// orca-plugin/src/worker.ts
import { get, request } from "node:http";
import { existsSync as existsSync3, readFileSync as readFileSync6, writeFileSync as writeFileSync4, renameSync as renameSync4, unlinkSync as unlinkSync3 } from "node:fs";
import { dirname as dirname2, join as join9, resolve as resolve2 } from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";

// orca-plugin/src/updates.ts
var UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
var updateInstruction = (mode) => mode === "bootstrap" ? "In Orca Settings > Plugins, click Refresh, then Update plugin." : "Click Update in the pacer panel.";
async function notifyUpdates(host, mode, plugin, check, cli) {
  const newer = (v) => !!v && isVersion(v) && isVersion(plugin) && compareVersions(v, plugin) > 0;
  for (const [kind, version] of [["release", check?.latest ?? null], ["cli", cli]]) {
    if (!newer(version))
      continue;
    const key = `pacer-update-${kind}-${version}`;
    if ((await host.call("storage.get", { key })).value === true)
      continue;
    const message = kind === "release" ? `pacer ${version} is available. ${updateInstruction(mode)}` : `The pacer CLI ${version} is newer than the Orca plugin ${plugin}. ${mode === "live" ? "Run pacer plugin install, then turn pacer off and on in Orca Settings > Plugins." : updateInstruction(mode)}`;
    const sent = await host.call("notifications.show", { title: "pacer update", body: message });
    if (sent.delivered)
      await host.call("storage.set", { key, value: true });
  }
  return { plugin, cli, latest: check?.latest ?? null, available: newer(check?.latest ?? null) || !!check?.latest && !!cli && isVersion(cli) && compareVersions(check.latest, cli) > 0 };
}

// orca-plugin/src/plugin.ts
import { join as join8 } from "node:path";

// orca-plugin/src/settings.ts
function readSettings(raw, home) {
  const finite = (v) => typeof v === "number" && Number.isFinite(v);
  return {
    notifications: ["off", "important", "all"].includes(String(raw.notifications)) ? raw.notifications : "important",
    transport: ["auto", "api"].includes(raw.transport) ? raw.transport : "auto",
    port: finite(raw.port) && Number.isInteger(raw.port) && raw.port >= 1 && raw.port <= 65535 ? raw.port : 4317,
    pacerHome: typeof raw.pacerHome === "string" && raw.pacerHome.length > 0 ? raw.pacerHome : `${home}/.pacer`,
    pollSeconds: finite(raw.pollSeconds) ? Math.max(5, Math.min(300, raw.pollSeconds)) : 10,
    ...Array.isArray(raw.deliveredAlerts) ? { deliveredAlerts: raw.deliveredAlerts.filter((a) => !!a && typeof a === "object" && typeof a.key === "string" && finite(a.at)).slice(-200) } : {},
    lastAlertAt: finite(raw.lastAlertAt) && raw.lastAlertAt >= 0 ? raw.lastAlertAt : 0
  };
}

// src/link/envelope.ts
var LIMITS = { providers: 32, tasks: 20, alerts: 10, goal: 200, title: 120, body: 1000, id: 128, heartbeatS: 30 };
var isObj2 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var str = (v, max) => typeof v === "string" ? v.slice(0, max) : null;
var optStr = (v, max) => typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;
var num = (v) => typeof v === "number" && Number.isFinite(v) ? v : null;
var LEVELS = ["info", "warn", "error"];
function clip(s, max) {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 3))}...`;
}
function parseBudget(d) {
  if (!isObj2(d))
    return null;
  const generatedAt = num(d.generatedAt), strategy = str(d.strategy, 128), planner = str(d.planner, 64), mode = str(d.mode, 32);
  if (generatedAt === null || strategy === null || planner === null || mode === null)
    return null;
  const providers = (Array.isArray(d.providers) ? d.providers : []).slice(0, LIMITS.providers).flatMap((p) => {
    if (!isObj2(p))
      return [];
    const id = str(p.id, 64), verdict = str(p.verdict, 32);
    if (id === null || verdict === null)
      return [];
    return [{ id, ...optStr(p.agent, 64) && optStr(p.account, 64) ? { agent: optStr(p.agent, 64), account: optStr(p.account, 64) } : {}, ...optStr(p.unavailableReason, 500) ? { unavailableReason: optStr(p.unavailableReason, 500) } : {}, verdict, usedPct: num(p.usedPct), pacePct: num(p.pacePct), resetsAt: num(p.resetsAt), window: optStr(p.window, 32), stale: p.stale === true, ...optStr(p.brokenReason, 500) ? { brokenReason: optStr(p.brokenReason, 500) } : {}, ...optStr(p.blockedReason, 500) ? { blockedReason: optStr(p.blockedReason, 500), blockedUntil: num(p.blockedUntil) } : {} }];
  });
  const ranked = (Array.isArray(d.ranked) ? d.ranked : []).slice(0, LIMITS.providers).flatMap((r) => {
    if (!isObj2(r))
      return [];
    const id = str(r.id, 64), verdict = str(r.verdict, 32);
    return id === null || verdict === null ? [] : [{ id, verdict }];
  });
  return { generatedAt, strategy, planner, mode, providers, ranked };
}
function parseTask(d) {
  if (!isObj2(d))
    return null;
  const id = str(d.id, LIMITS.id), state = str(d.state, 16), updatedAt = num(d.updatedAt);
  if (!id || !state || updatedAt === null)
    return null;
  return {
    id,
    state,
    updatedAt,
    ...optStr(d.title, 60)?.trim() ? { title: optStr(d.title, 60).trim() } : {},
    goal: str(d.goal, LIMITS.goal) ?? "",
    executor: optStr(d.executor, 64),
    backend: optStr(d.backend, 32),
    worktree: optStr(d.worktree, 4096),
    ...isObj2(d.placement) && ["current", "new"].includes(String(d.placement.mode)) && typeof d.placement.why === "string" ? { placement: { mode: d.placement.mode, why: d.placement.why.slice(0, 240) } } : {},
    ...isObj2(d.session) && ["builtin", "orca", "none"].includes(String(d.session.host)) && typeof d.session.live === "boolean" && num(d.session.viewers) !== null ? { session: { host: d.session.host, live: d.session.live, controller: optStr(d.session.controller, 64), viewers: Math.max(0, Math.min(99, Math.floor(num(d.session.viewers)))) } } : {},
    ...typeof d.terminalPresent === "boolean" ? { terminalPresent: d.terminalPresent } : {},
    ...optStr(d.resolved, 240) ? { resolved: optStr(d.resolved, 240) } : {},
    ...isObj2(d.review) && typeof d.review.accepted === "boolean" && num(d.review.at) !== null ? { review: { accepted: d.review.accepted, kind: optStr(d.review.kind, 64), note: optStr(d.review.note, 1000), at: num(d.review.at) } } : {},
    ...d.dismissed === true ? { dismissed: true } : {},
    ...optStr(d.retriedBy, 128) ? { retriedBy: optStr(d.retriedBy, 128) } : {},
    ...optStr(d.retryOf, 128) ? { retryOf: optStr(d.retryOf, 128) } : {},
    ...optStr(d.brokenExecutor, 64) ? { brokenExecutor: optStr(d.brokenExecutor, 64) } : {},
    ...optStr(d.brokenReason, 500) ? { brokenReason: optStr(d.brokenReason, 500) } : {},
    ...num(d.attemptStartedAt) !== null ? { attemptStartedAt: num(d.attemptStartedAt) } : {},
    ...isObj2(d.progress) && typeof d.progress.phase === "string" && num(d.progress.files) !== null && num(d.progress.commits) !== null && num(d.progress.logBytes) !== null ? { progress: { phase: d.progress.phase.slice(0, 16), lastOutputAt: num(d.progress.lastOutputAt), files: num(d.progress.files), commits: num(d.progress.commits), logBytes: num(d.progress.logBytes) } } : {},
    ...typeof d.runnerAlive === "boolean" ? { runnerAlive: d.runnerAlive } : {}
  };
}
function parseMode(d) {
  if (!isObj2(d))
    return null;
  const mode = str(d.mode, 32), strategy = str(d.strategy, 128), at = num(d.at);
  if (!mode || strategy === null || at === null)
    return null;
  return { mode, strategy, at, previous: optStr(d.previous, 32) };
}
function parseAlert(d) {
  if (!isObj2(d))
    return null;
  const error = optStr(d.error, LIMITS.body), level = LEVELS.includes(d.level) ? d.level : error ? "error" : "info";
  const alert = { key: optStr(d.key, LIMITS.id) ?? "alert", level, title: clip(optStr(d.title, 4096) ?? "pacer", LIMITS.title), body: clip(str(d.body, 4096) ?? error ?? "", LIMITS.body), at: num(d.at) ?? 0 };
  if (error)
    alert.error = error;
  const n = d.notification;
  if (isObj2(n) && ["failed", "done", "broken", "quota", "strategy", "session"].includes(String(n.kind)))
    alert.notification = { kind: n.kind, ...n.fromPanel === true ? { fromPanel: true } : {}, ...n.near === true ? { near: true } : {}, ...optStr(n.executor, 64) ? { executor: optStr(n.executor, 64) } : {}, ...optStr(n.goal, 1000) ? { goal: optStr(n.goal, 1000) } : {}, ...optStr(n.nextExecutor, 64) ? { nextExecutor: optStr(n.nextExecutor, 64) } : {}, ...optStr(n.strategy, 128) ? { strategy: optStr(n.strategy, 128) } : {}, ...num(n.resetsAt) !== null ? { resetsAt: num(n.resetsAt) } : {} };
  return alert;
}
function parseOutboxEvent(raw) {
  if (!isObj2(raw) || raw.v !== undefined && raw.v !== 1)
    return null;
  switch (raw.type) {
    case "entity": {
      const d = raw.data;
      if (!isObj2(d) || !["planner", "executor", "account", "host", "repo", "counts", "attention", "activity", "job", "notify"].includes(String(d.kind)) || typeof d.id !== "string" || !d.id.length || d.id.length > (d.kind === "notify" ? 512 : 128))
        return null;
      return { type: "entity", data: { kind: d.kind, id: d.id, ...d.removed === true ? { removed: true } : { value: d.value } } };
    }
    case "pause": {
      const d = raw.data;
      if (!isObj2(d))
        return null;
      if (d.removed === true)
        return { type: "pause", data: { removed: true } };
      if (d.until !== null && num(d.until) === null || d.reason !== null && typeof d.reason !== "string" || d.by !== null && typeof d.by !== "string")
        return null;
      return { type: "pause", data: { until: d.until, reason: d.reason, by: d.by } };
    }
    case "config": {
      const d = raw.data;
      if (!isObj2(d) || !optStr(d.area, 128) || num(d.at) === null)
        return null;
      return { type: "config", data: { area: optStr(d.area, 128), at: num(d.at) } };
    }
    case "budget": {
      const data = parseBudget(raw.data);
      return data && { type: "budget", data };
    }
    case "task": {
      const data = parseTask(raw.data);
      return data && { type: "task", data };
    }
    case "mode": {
      const data = parseMode(raw.data);
      return data && { type: "mode", data };
    }
    case "alert": {
      const data = parseAlert(raw.data);
      return data && { type: "alert", data };
    }
    default:
      return null;
  }
}
function emptySnapshot() {
  return { v: 1, seq: 0, at: 0, budget: null, mode: null, tasks: [], alerts: [], console: null, consoles: [], strategies: [] };
}
function reduce(s, e, at) {
  const next = { ...s, seq: s.seq + 1, at };
  switch (e.type) {
    case "entity":
      break;
    case "config":
      break;
    case "budget":
      next.budget = e.data;
      break;
    case "mode":
      next.mode = e.data;
      break;
    case "task":
      next.tasks = [e.data, ...s.tasks.filter((t) => t.id !== e.data.id)].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, LIMITS.tasks);
      break;
    case "alert":
      next.alerts = [e.data, ...s.alerts.filter((a) => a.key !== e.data.key)].sort((a, b) => b.at - a.at).slice(0, LIMITS.alerts);
      break;
  }
  return next;
}
function contentKey(s) {
  return JSON.stringify({ serviceInstalled: s.serviceInstalled, budget: s.budget ? { ...s.budget, generatedAt: undefined } : null, mode: s.mode, tasks: s.tasks, alerts: s.alerts, console: s.console, consoles: s.consoles, strategies: s.strategies });
}

// orca-plugin/src/store.ts
var snapshotKey = (s) => s.planner === undefined ? contentKey(s) : JSON.stringify({
  planner: s.planner,
  executors: s.executors,
  accounts: s.accounts,
  service: s.service,
  setup: s.setup,
  attention: s.attention,
  mode: s.mode,
  strategies: s.strategies,
  tasks: s.tasks
});

class LinkStore {
  nowS;
  snapshot = emptySnapshot();
  transport = null;
  listeners = [];
  constructor(nowS) {
    this.nowS = nowS;
  }
  apply(e) {
    this.replace(reduce(this.snapshot, e, this.nowS()));
  }
  replace(s) {
    const changed = snapshotKey(s) !== snapshotKey(this.snapshot);
    this.snapshot = s;
    if (changed)
      for (const fn of this.listeners)
        fn(s);
  }
  onChange(fn) {
    this.listeners.push(fn);
  }
}

// orca-plugin/src/transports/choose.ts
var TRANSPORT_ORDER = ["api"];
async function chooseTransport(ts, forced) {
  const probe = async (t) => {
    try {
      return await t.probe();
    } catch {
      return false;
    }
  };
  if (forced === "api") {
    const transport = ts.find((t) => t.id === forced) ?? null;
    return { transport, reachable: transport ? await probe(transport) : false };
  }
  for (const id of TRANSPORT_ORDER) {
    const transport = ts.find((t) => t.id === id);
    if (transport && await probe(transport))
      return { transport, reachable: true };
  }
  return { transport: null, reachable: false };
}

// orca-plugin/src/transports/api.ts
function apiTransport(o) {
  let connection = null;
  let hello = null;
  let seq = 0;
  let watches = 0;
  const client = () => connection ??= Promise.resolve().then(o.connect);
  async function snapshot() {
    try {
      const c = await client();
      if (!c)
        return null;
      const result = await c.snapshot();
      seq = result.seq;
      return result.snapshot;
    } catch (e) {
      o.log?.(`pacer API snapshot: ${String(e)}`);
      return null;
    }
  }
  return {
    id: "api",
    async probe() {
      let cancel = () => {}, abandoned = false;
      const created = connection === null;
      const pending = client();
      try {
        const ready = await Promise.race([
          pending.then(async (c) => {
            if (abandoned)
              return false;
            if (!c)
              return false;
            hello = await c.hello();
            return true;
          }),
          new Promise((resolve) => {
            cancel = o.timers.after(2000, () => resolve(false));
          })
        ]);
        if (ready)
          return true;
      } catch (e) {
        o.log?.(`pacer API probe: ${String(e)}`);
      } finally {
        cancel();
      }
      abandoned = true;
      if (created && watches === 0 && connection === pending) {
        connection = null;
        pending.then((c) => c?.close()).catch(() => {});
      }
      return false;
    },
    snapshot,
    watch(onEnvelope, onSnapshot, onFailure) {
      watches++;
      let stopped = false, busy = false, resetPending = false;
      let unsubscribe = () => {}, cancelHeartbeat = () => {};
      let clientId = null;
      const delivered = new Set;
      let deliveries = Promise.resolve();
      const refresh = async () => {
        if (stopped || busy)
          return;
        busy = true;
        try {
          const s = await snapshot();
          if (!stopped) {
            if (s)
              onSnapshot(s);
            else
              onFailure?.();
          }
        } finally {
          busy = false;
          if (resetPending) {
            resetPending = false;
            refresh();
          }
        }
      };
      const start = async () => {
        await refresh();
        if (stopped)
          return;
        const c = await client();
        if (stopped || !c)
          return;
        const capabilities = hello ??= await c.hello();
        if (o.notifier && capabilities.ops.includes("client.register") && capabilities.events.includes("notify")) {
          const register = async () => {
            const result = await c.call("client.register", { kind: "orca", version: o.notifier.version, notifier: true });
            clientId = result.client_id;
          };
          await register();
          if (stopped)
            return;
          let renewing = false;
          cancelHeartbeat = o.timers.every(30000, () => {
            if (stopped || renewing)
              return;
            renewing = true;
            c.call("client.heartbeat", { client_id: clientId }).catch(async (e) => {
              if (!stopped && e?.code === "invalid_input")
                await register();
              else
                o.log?.(`pacer notifier heartbeat: ${String(e)}`);
            }).catch((e) => o.log?.(`pacer notifier registration: ${String(e)}`)).finally(() => {
              renewing = false;
            });
          });
        }
        if (stopped)
          return;
        unsubscribe = c.subscribe(seq, (e) => {
          if (stopped)
            return;
          if (e.type === "notify") {
            const data = e.data;
            if (!clientId || !data || data.client_id !== clientId || typeof data.key !== "string" || typeof data.title !== "string" || typeof data.body !== "string")
              return;
            deliveries = deliveries.then(async () => {
              if (stopped || delivered.has(data.key))
                return;
              const result = await o.notifier.deliver(data);
              if (result !== false)
                delivered.add(data.key);
            }).catch((e) => o.log?.(`pacer notification: ${String(e)}`));
            return;
          }
          if (e.type === "reset") {
            if (busy)
              resetPending = true;
            else
              refresh();
            return;
          }
          if (!["budget", "task", "mode", "alert"].includes(e.type))
            return;
          const envelope = parseOutboxEvent({ type: e.type, data: e.data });
          if (envelope)
            onEnvelope(envelope);
        });
      };
      start().catch((e) => {
        o.log?.(`pacer API watch: ${String(e)}`);
        if (!stopped)
          onFailure?.();
      });
      const cancelPoll = o.timers.every(1e4, () => {
        refresh();
      });
      return () => {
        if (stopped)
          return;
        stopped = true;
        watches--;
        unsubscribe();
        cancelPoll();
        cancelHeartbeat();
      };
    }
  };
}

// orca-plugin/src/notify.ts
var shownAt = new WeakMap;
async function deliverNotification(host, message, nowS, serviceDecided = false) {
  if (!serviceDecided && nowS - (shownAt.get(host) ?? -Infinity) < 5)
    return false;
  const previous = shownAt.get(host);
  shownAt.set(host, nowS);
  try {
    const result = await host.call("notifications.show", message);
    if (result.delivered)
      return true;
  } catch (e) {
    if (previous === undefined)
      shownAt.delete(host);
    else
      shownAt.set(host, previous);
    throw e;
  }
  if (previous === undefined)
    shownAt.delete(host);
  else
    shownAt.set(host, previous);
  return false;
}
var states = new WeakMap;

// src/view-model/selectors.ts
var memo = new WeakMap;
function cached(s, key, build) {
  let entries = memo.get(s);
  if (!entries)
    memo.set(s, entries = new Map);
  if (!entries.has(key))
    entries.set(key, build());
  return entries.get(key);
}
var inScope = (scope, repo) => scope.repo === null || !repo || repo.key === scope.repo;
var active = (state) => state === "running" || state === "queued";
var needsYou = (s, scope) => cached(s, `needsYou:${scope.repo}`, () => (s.attention ?? []).filter((a) => !(a.snoozedUntil && a.snoozedUntil > s.at) && (scope.repo === null || !a.repo || a.repo.key === scope.repo)));
var otherReposNeedingYou = (s, scope) => scope.repo === null ? 0 : needsYou(s, { repo: null }).length - needsYou(s, scope).length;
var running = (s, scope) => cached(s, `running:${scope.repo}`, () => s.tasks.filter((t) => active(t.state) && !t.dismissed && inScope(scope, t.repo)));
var capacity = (s) => s.executors ?? [];
var doneToday = (s, scope) => cached(s, `doneToday:${scope.repo}`, () => {
  const since = s.today?.since;
  if (since === undefined)
    return [];
  return s.tasks.filter((t) => t.source !== "onboarding" && !active(t.state) && t.updatedAt >= since && inScope(scope, t.repo)).sort((a, b) => b.updatedAt - a.updatedAt);
});
var counts = (s) => s.counts ?? null;
var repos = (s) => s.repos ?? [];
var plannerMeter = (s) => s.planner ?? null;

// src/render/accounts.ts
var names2 = { "claude-code": "Claude", codex: "Codex", cursor: "Cursor", agy: "Antigravity", byteplus: "BytePlus", local: "Local", opencode: "OpenCode" };
var providerName = (id) => (Object.hasOwn(names2, id) ? names2[id] : undefined) ?? id.charAt(0).toUpperCase() + id.slice(1);
function displayName(id) {
  const runner = parseRunnerId(id);
  if (runner?.agent === "opencode" && runner.account)
    return providerName(runner.account);
  if (runner?.account)
    return `${runner.agent === "claude-code" ? "Claude Code" : providerName(runner.agent)} (${runner.account})`;
  return providerName(runner?.agent ?? id);
}
function runnerLabel(p) {
  return p.agent === "opencode" && p.account ? providerName(p.account) : displayName(p.id);
}
function accountGroups(rows) {
  const groups = [];
  for (const row of rows) {
    const account = row.agent ? row.account : undefined;
    let group = groups.find((g) => g.account === account);
    if (!group) {
      group = { account, rows: [] };
      groups.push(group);
    }
    group.rows.push(row);
  }
  return groups;
}

// src/view-model/time.ts
function clock(at, now, timeZone) {
  const date = new Date(at * 1000), opts = { timeZone, hourCycle: "h23" };
  const time = date.toLocaleTimeString("en-GB", { ...opts, hour: "2-digit", minute: "2-digit" });
  const day = (t) => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date(t * 1000));
    const part = (name) => Number(parts.find((p) => p.type === name).value);
    return Date.UTC(part("year"), part("month") - 1, part("day")) / 86400000;
  };
  const days = day(now) - day(at);
  if (days === 0)
    return time;
  if (days === 1)
    return `Yesterday ${time}`;
  if (days > 1 && days < 7)
    return `${date.toLocaleDateString("en-GB", { ...opts, weekday: "short" })} ${time}`;
  return `${date.toLocaleDateString("en-GB", { ...opts, day: "numeric", month: "short", ...date.toLocaleDateString("en-GB", { timeZone, year: "numeric" }) !== new Date(now * 1000).toLocaleDateString("en-GB", { timeZone, year: "numeric" }) ? { year: "numeric" } : {} })} ${time}`;
}

// src/view-model/format.ts
var displayName2 = (id) => parseRunnerId(id) || Object.hasOwn(names2, id) ? displayName(id) : id;

// src/view-model/agents.ts
var AGENT_IDS = ["claude-code", "codex", "cursor", "agy", "byteplus", "local", "opencode", "gemini"];
var AGENTS2 = {
  "claude-code": { name: "Claude Code", glyph: "claude", color: "#D97757", tile: "tint" },
  codex: { name: "Codex", glyph: "openai", color: "ink", tile: "page-hairline" },
  cursor: { name: "Cursor", glyph: "cursor", color: "ink", tile: "tint" },
  agy: { name: "Antigravity", glyph: "antigravity", color: "#4285F4", tile: "tint" },
  byteplus: { name: "BytePlus", glyph: "bytedance", color: "#3C8CFF", tile: "tint" },
  local: { name: "Local model", glyph: "lmstudio", color: "ink", tile: "tint" },
  opencode: { name: "OpenCode", glyph: "opencode", color: "ink", tile: "tint" },
  gemini: { name: "Gemini", glyph: "gemini", color: "#8E75B2", tile: "tint" }
};
var ALIASES = { claude: "claude-code", antigravity: "agy" };
function agentKey(agent) {
  if (Object.hasOwn(ALIASES, agent))
    return ALIASES[agent];
  return AGENT_IDS.includes(agent) ? agent : null;
}
function agentInfo(agent) {
  const key = agentKey(agent);
  const monogram = agent.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "?";
  return key ? { ...AGENTS2[key], monogram } : { name: agent, glyph: null, color: "ink", tile: "tint", monogram };
}
var runnerAgent = (id) => id.split("@")[0].split("#")[0];
function markAgent(id, account) {
  const agent = runnerAgent(id), acct = account ?? id.split("@")[0].split("#")[1];
  return agent === "opencode" && acct && agentKey(acct) ? agentKey(acct) : agent;
}

// src/view-model/words.ts
var tones = {
  good: "good",
  info: "info",
  warn: "warn",
  bad: "bad",
  muted: "neutral",
  EXHAUSTED: "bad",
  AHEAD: "warn",
  NEAR_LIMIT: "warn",
  EXPIRING: "warn",
  EXPIRING_SOON: "warn",
  OK: "good",
  ON_PACE: "good",
  BEHIND: "good",
  UNMETERED: "good",
  behind: "good",
  on_pace: "good",
  ahead: "warn",
  out: "bad"
};
var toneFor = (value) => Object.hasOwn(tones, value) ? tones[value] : "neutral";
var verdicts = {
  ON_PACE: "Available",
  OK: "Available",
  UNMETERED: "Available",
  AHEAD: "Ahead of pace",
  BEHIND: "Behind pace",
  EXPIRING: "Expiring soon",
  EXPIRING_SOON: "Expiring soon",
  NEAR_LIMIT: "Near limit",
  EXHAUSTED: "Out of quota",
  behind: "Behind pace",
  on_pace: "On pace",
  ahead: "Ahead of pace",
  out: "Out of quota",
  unknown: "Usage unknown"
};
var verdictWords = (v) => Object.hasOwn(verdicts, v) ? verdicts[v] : "Unknown";
var phases = { driving: "You're driving", starting: "Starting", working: "Editing", testing: "Testing", idle: "Idle", "lost-contact": "Lost contact", queued: "Queued" };
var phaseWords = (phase) => Object.hasOwn(phases, phase) ? phases[phase] : phase;
var modeWords = (mode) => mode ? mode[0].toUpperCase() + mode.slice(1).toLowerCase() : mode;
function executorLabel(id, accounts = []) {
  if (!id)
    return "Automatic";
  const [local, host] = id.split("@");
  const [agent, name] = local.split("#");
  const account = accounts.find((a) => a.runners?.includes(id) || a.name === name);
  const native = { "claude-code": "Claude Code", claude: "Claude", codex: "Codex", cursor: "Cursor", agy: "Antigravity", antigravity: "Antigravity" }[agent];
  const defaultAccount = account?.source === "default" || account?.folder && (agent === "codex" && account.folder.endsWith("/.codex") || agent === "claude-code" && account.folder.endsWith("/.claude"));
  const suffix = name && !defaultAccount ? ` · ${account?.name ?? name}` : "";
  const known = (id) => id && agentKey(id) ? agentInfo(id).name : id;
  const label = agent === "opencode" ? `${known(account?.name ?? name) ?? "OpenCode"}` : `${native ?? known(agent)}${suffix}`;
  return label + (host ? ` on ${host}` : "");
}
var status = (label, tone, glyph) => ({ label, tone, glyph });
var unknownStatus = status("Unknown", "neutral", "?");
var taskStates = {
  needs_input: status("Needs your answer", "warn", "!"),
  running: status("Working", "info", "▶"),
  queued: status("Queued", "neutral", "…"),
  done: status("Done", "good", "✓"),
  partial: status("Partial", "warn", "!"),
  failed: status("Failed", "bad", "✕"),
  limit: status("Out of quota", "bad", "!"),
  stopped: status("Stopped", "neutral", "■")
};
var sessionStates = {
  driving: status("You're driving", "info", "▶"),
  starting: status("Starting", "info", "▶"),
  working: status("Editing", "info", "▶"),
  testing: status("Testing", "info", "▶"),
  idle: status("Idle", "warn", "…"),
  "lost-contact": status("Lost contact", "bad", "!"),
  queued: taskStates.queued
};
var waitingReview = status("Waiting for review", "warn", "◐");
function taskStatus(task) {
  if (task.review)
    return task.review.accepted ? status("Accepted", "good", "✓") : status("Rejected", "bad", "✕");
  if (["done", "partial"].includes(task.state) && !task.dismissed && !task.resolved && !task.retriedBy)
    return waitingReview;
  const phase = task.progress?.phase ?? task.phase;
  if (task.state === "running" && phase)
    return sessionStatus(phase);
  return Object.hasOwn(taskStates, task.state) ? taskStates[task.state] : unknownStatus;
}
var sessionStatus = (phase) => Object.hasOwn(sessionStates, phase) ? sessionStates[phase] : unknownStatus;
var executorStates = {
  ready: status("Ready", "good", "✓"),
  busy: status("Busy", "info", "▶"),
  full: status("At capacity", "info", "■"),
  failing: status("Failing", "warn", "!"),
  down: status("Unavailable", "bad", "✕"),
  blocked: status("Blocked", "neutral", "■"),
  exhausted: taskStates.limit,
  disabled: status("Disabled", "neutral", "■"),
  checking: status("Checking", "info", "…")
};
var paceStates = {
  behind: status("Behind pace", "good", "↓"),
  on_pace: status("On pace", "good", "✓"),
  ahead: status("Ahead of pace", "warn", "↑"),
  out: taskStates.limit,
  UNMETERED: status("Unmetered", "good", "∞"),
  EXPIRING: status("Expiring soon", "warn", "!"),
  EXPIRING_SOON: status("Expiring soon", "warn", "!"),
  unknown: status("Usage unknown", "neutral", "?")
};

// src/view-model/panel.ts
var providerLabel = (p) => p.agent ? runnerLabel(p) : displayName2(p.id);
function providers(s) {
  if (s.planner === undefined)
    return s.budget?.providers ?? [];
  return capacity(s).map((e) => {
    const a = s.accounts?.find((a) => a.name === e.account);
    return {
      id: e.id,
      agent: e.agent,
      account: e.account,
      usedPct: e.usedPct,
      pacePct: e.pacePct,
      resetsAt: a?.resetsAt ?? null,
      window: a?.window ?? null,
      verdict: e.state === "exhausted" ? "EXHAUSTED" : a?.verdict ?? "UNKNOWN",
      stale: e.rank === "planner" ? plannerMeter(s)?.stale ?? false : false,
      ...e.state === "blocked" ? { blockedReason: e.reason ?? "blocked" } : {},
      ...e.state === "down" ? { brokenReason: e.reason ?? "not available" } : {},
      ...!e.enabled ? { unavailableReason: e.reason ?? "disabled" } : {}
    };
  });
}
function plannerProvider(s) {
  if (s.planner === undefined)
    return s.budget?.providers.find((p) => p.id === s.budget?.planner);
  const p = plannerMeter(s);
  if (!p)
    return;
  const e = capacity(s).find((e) => e.id === p.runner);
  return {
    id: p.runner,
    agent: p.agent,
    account: e?.account,
    usedPct: p.usedPct,
    pacePct: p.pacePct,
    resetsAt: p.resetsAt,
    window: p.window,
    stale: p.stale,
    verdict: { behind: "BEHIND", on_pace: "ON_PACE", ahead: "AHEAD", out: "EXHAUSTED", unknown: "UNKNOWN" }[p.verdict]
  };
}
function headline(p, _now = 0) {
  const name = p?.agent ? providerLabel(p) : "Claude";
  switch (p?.verdict) {
    case "OK":
    case "ON_PACE":
      return "You're on pace for the week.";
    case "AHEAD":
    case "NEAR_LIMIT":
      return `${name} is ahead of pace. Slow down planning.`;
    case "BEHIND":
      return `${name} is behind pace. Room for more planning.`;
    case "EXHAUSTED":
      return p.resetsAt === null ? `${name} is out of quota until its next reset.` : `${name} is out until ${new Date(p.resetsAt * 1000).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}.`;
    default:
      return "Budget unknown.";
  }
}

// orca-plugin/src/panel/shared.ts
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
var h = (v) => escapeHtml(String(v ?? ""));

// app/src/ds/agent-glyphs.ts
var AGENT_GLYPHS = {
  claude: { path: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z", viewBox: "0 0 24 24", source: "simple-icons", license: "CC0-1.0" },
  openai: { path: "M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z", viewBox: "0 0 24 24", evenOdd: true, source: "lobe-icons", license: "MIT" },
  cursor: { path: "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23", viewBox: "0 0 24 24", source: "simple-icons", license: "CC0-1.0" },
  antigravity: { path: "M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z", viewBox: "0 0 24 24", source: "lobe-icons", license: "MIT" },
  bytedance: { path: "M19.8772 1.4685L24 2.5326v18.9426l-4.1228 1.0563V1.4685zm-13.3481 9.428l4.115 1.0641v8.9786l-4.115 1.0642v-11.107zM0 2.572l4.115 1.0642v16.7354L0 21.428V2.572zm17.4553 5.6205v11.107l-4.1228-1.0642V9.2568l4.1228-1.0642z", viewBox: "0 0 24 24", source: "simple-icons", license: "CC0-1.0" },
  lmstudio: { path: "M14.025 0c3.492 0 5.237 0 6.571.68a6.24 6.24 0 0 1 2.725 2.724C24 4.738 24 6.484 24 9.975v4.05c0 3.492 0 5.237-.68 6.571a6.24 6.24 0 0 1-2.724 2.725c-1.334.679-3.08.679-6.571.679h-4.05c-3.492 0-5.237 0-6.571-.68A6.24 6.24 0 0 1 .68 20.597C0 19.262 0 17.516 0 14.025v-4.05c0-3.492 0-5.237.68-6.571A6.23 6.23 0 0 1 3.404.68C4.738 0 6.484 0 9.975 0zM7.688 16.313a1.313 1.313 0 0 0 0 2.625h11.625a1.313 1.313 0 0 0 0-2.625zm-3-3.75a1.313 1.313 0 0 0 0 2.624h11.625a1.313 1.313 0 0 0 0-2.624zm3-3.75a1.313 1.313 0 0 0 0 2.624h11.625a1.313 1.313 0 0 0 0-2.624zm-3-3.75a1.313 1.313 0 0 0 0 2.625h11.625a1.313 1.313 0 0 0 0-2.625z", viewBox: "0 0 24 24", source: "simple-icons", license: "CC0-1.0" },
  opencode: { path: "M22 24H2V0h20zM17 4.8H7v14.4h10z", viewBox: "0 0 24 24", source: "simple-icons", license: "CC0-1.0" },
  gemini: { path: "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81", viewBox: "0 0 24 24", source: "simple-icons", license: "CC0-1.0" }
};

// orca-plugin/src/panel/icons.ts
function icon(id, size = 16, account) {
  const agent = markAgent(id, account), info = agentInfo(agent), key = agentKey(agent);
  const glyph = info.glyph ? AGENT_GLYPHS[info.glyph] : null, inner = Math.round(size * 0.66);
  const classes = ["agent-mark", `agent-mark--${key ?? "unknown"}`, info.tile === "page-hairline" ? "agent-mark--hairline" : ""].filter(Boolean).join(" ");
  return `<span class="${classes}" role="img" aria-label="${escapeHtml(info.name)}" style="width:${size}px;height:${size}px;border-radius:${size * 0.28}px">${glyph ? `<svg width="${inner}" height="${inner}" viewBox="${glyph.viewBox}" aria-hidden="true" focusable="false"><path d="${glyph.path}" fill="currentColor"${glyph.evenOdd ? ' fill-rule="evenodd"' : ""}></path></svg>` : `<span class="monogram">${escapeHtml(info.monogram)}</span>`}</span>`;
}
var agentStyle = `
.agent-mark{display:inline-flex;align-items:center;justify-content:center;flex:none;color:var(--agent-color,var(--ink));background:color-mix(in srgb,var(--agent-color,var(--ink)) 14%,transparent)}
.agent-mark--hairline{background:var(--surface-page);border:1px solid var(--line);color:var(--ink)}
.agent-mark--unknown{background:var(--ink);color:var(--ink-on-ink)}
${AGENT_IDS.map((id) => `.agent-mark--${id}{--agent-color:${agentInfo(id).color === "ink" ? "var(--ink)" : agentInfo(id).color}}`).join(`
`)}
`;
var mark = `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48"><rect x="4" y="20" width="40" height="8" rx="4" fill="var(--border)"></rect><rect x="4" y="20" width="22" height="8" rx="4" fill="currentColor"></rect><rect class="brand-tick" x="29" y="12" width="4" height="24" rx="2"></rect></svg>`;

// orca-plugin/src/panel/setup.ts
function legacyChecklist(s, now, reachable, bootstrap) {
  if (s.planner !== undefined)
    return { checkedAt: now, ready: s.setup?.ready ?? false, complete: s.setup?.complete ?? false, items: (s.setup?.items ?? []).map((i) => ({ ...i, status: i.status === "done" || i.status === "failed" ? i.status : "pending" })) };
  return setupChecklist({ version: bootstrap?.install.status === "done" ? s.console?.version ?? "installed" : null, planner: s.budget?.planner ?? null, service: { installed: bootstrap?.start.status === "done" || !!s.serviceInstalled, running: reachable }, link: reachable, live: true, agents: bootstrap?.agents ?? [] }, now);
}
// orca-plugin/src/panel/overview.ts
function placementLine(t) {
  return t.placement ? `<small class="muted">${h(`${t.placement.mode} worktree${t.placement.mode === "new" && t.worktree ? ` ${t.worktree}` : ""} (${t.placement.why})`)}</small>` : "";
}
function meter(p, slim = false) {
  if (p.usedPct === null)
    return "";
  const used = Math.max(0, Math.min(100, p.usedPct)), pace = p.pacePct == null ? null : Math.max(0, Math.min(100, p.pacePct));
  return `<div class="meter ${slim ? "slim" : ""} ${toneFor(p.verdict)}" role="progressbar" aria-label="${h(providerLabel(p))} usage${pace === null ? "" : `, pace ${pace}%`}" aria-valuenow="${used}" aria-valuemin="0" aria-valuemax="100"><div class="fill" style="width:${used}%"></div>${pace === null ? "" : `<div class="pace" style="left:${pace}%"></div>`}</div>`;
}

// orca-plugin/src/panel/style.ts
var style = `
*{box-sizing:border-box}body{margin:0;background:var(--background);color:var(--foreground);font:12px/1.4 var(--app-font-family,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif);font-variant-numeric:tabular-nums;--background:var(--surface-page);--foreground:var(--ink);--border:var(--line);--card:var(--surface-page);--muted:var(--surface-lane);--muted-foreground:var(--ink-muted);--good:var(--good-fg);--warn:var(--warn-fg);--bad:var(--bad-fg)}
.content{padding:12px;display:flex;flex-direction:column;gap:18px;min-width:0;overflow-wrap:anywhere}.stack{display:flex;flex-direction:column;gap:6px;min-width:0}.row,.name,header{display:flex;align-items:center;gap:8px}header{flex-wrap:wrap}.grow{flex:1;min-width:0}.brand{font-weight:600;font-size:14px}.brand-tick{fill:var(--track)}.pill{font-size:10px;padding:2px 6px;border-radius:6px;background:var(--muted)}.live,small,footer{font-size:11px;color:var(--muted-foreground)}h2{font-size:10px;letter-spacing:.06em;text-transform:uppercase;font-weight:500;margin:0;color:var(--muted-foreground)}.section{gap:8px}.card{border:1px solid var(--border);border-radius:8px;background:var(--card);padding:10px}.headline{font-weight:600}p{margin:0}.good{color:var(--good)}.warn{color:var(--warn)}.bad{color:var(--bad)}.meter{position:relative;height:6px;background:var(--border);border-radius:999px;margin:4px 0}.meter.slim{height:3px}.fill{height:100%;border-radius:999px;background:currentColor}.pace{position:absolute;width:2px;top:-4px;bottom:-4px;background:var(--foreground);border-radius:2px}.step{padding:8px;display:flex;gap:8px}.step.failed{color:var(--bad)}pre{margin:0;padding:10px;background:var(--muted);border-radius:8px;white-space:pre-wrap}code,pre{user-select: text;-webkit-user-select:text}code{font:11px ui-monospace,monospace;overflow-wrap:anywhere}footer{border-top:1px solid var(--border);padding-top:12px}
`;

// app/src/ds/tokens.css
var tokens_default = `/* Generated from tokens.json. */
:root {
  color-scheme: light dark;
  --surface-page: #ffffff;
  --surface-card: #fafafa;
  --surface-lane: #f4f4f5;
  --line: #e4e4e7;
  --ink: #18181b;
  --ink-secondary: #52525b;
  --ink-muted: #71717a;
  --ink-on-ink: #ffffff;
  --track: #65a30d;
  --link: #1d4ed8;
  --good-fg: #166534;
  --good-bg: #dcfce7;
  --good-fill: #15803d;
  --warn-fg: #92400e;
  --warn-bg: #fef3c7;
  --warn-fill: #d97706;
  --warn-line: #fde68a;
  --warn-tint: #fffdf5;
  --bad-fg: #991b1b;
  --bad-bg: #fee2e2;
  --bad-fill: #dc2626;
  --bad-line: #fecaca;
  --bad-tint: #fffbfb;
  --info-fg: #1e40af;
  --info-bg: #dbeafe;
  --focus: #1d4ed8;
  --font-sans: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  --font-mono: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  --type-display-size: 28px;
  --type-display-line: 34px;
  --type-display-weight: 650;
  --type-display-tracking: -0.02em;
  --type-wordmark-size: 20px;
  --type-wordmark-line: 24px;
  --type-wordmark-weight: 650;
  --type-wordmark-tracking: -0.03em;
  --type-number-lg-size: 22px;
  --type-number-lg-line: 26px;
  --type-number-lg-weight: 650;
  --type-number-lg-tracking: -0.02em;
  --type-headline-size: 16px;
  --type-headline-line: 22px;
  --type-headline-weight: 650;
  --type-headline-tracking: -0.01em;
  --type-body-size: 13px;
  --type-body-line: 19px;
  --type-body-weight: 400;
  --type-body-strong-size: 13px;
  --type-body-strong-line: 19px;
  --type-body-strong-weight: 600;
  --type-caption-size: 12px;
  --type-caption-line: 16px;
  --type-caption-weight: 400;
  --type-label-size: 11px;
  --type-label-line: 14px;
  --type-label-weight: 600;
  --type-label-tracking: 0.06em;
  --type-pill-size: 11px;
  --type-pill-line: 14px;
  --type-pill-weight: 600;
  --type-code-size: 12px;
  --type-code-line: 18px;
  --type-code-weight: 400;
  --space-1: 4px;
  --space-1\\.5: 6px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-8: 32px;
  --space-12: 48px;
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 10px;
  --radius-xl: 14px;
  --radius-full: 999px;
  font-variant-numeric: tabular-nums;
}
@media (prefers-color-scheme: dark) {
:root:not([data-theme="light"]) {
  --surface-page: #09090b;
  --surface-card: #18181b;
  --surface-lane: #27272a;
  --line: #3f3f46;
  --ink: #fafafa;
  --ink-secondary: #a1a1aa;
  --ink-muted: #a1a1aa;
  --ink-on-ink: #18181b;
  --track: #a3e635;
  --link: #93c5fd;
  --good-fg: #86efac;
  --good-bg: #14532d;
  --good-fill: #22c55e;
  --warn-fg: #fcd34d;
  --warn-bg: #451a03;
  --warn-fill: #f59e0b;
  --warn-line: #78350f;
  --warn-tint: #1c1408;
  --bad-fg: #fca5a5;
  --bad-bg: #450a0a;
  --bad-fill: #ef4444;
  --bad-line: #7f1d1d;
  --bad-tint: #1f0a0a;
  --info-fg: #93c5fd;
  --info-bg: #172554;
  --focus: #93c5fd;
}
}
:root[data-theme="dark"] {
  --surface-page: #09090b;
  --surface-card: #18181b;
  --surface-lane: #27272a;
  --line: #3f3f46;
  --ink: #fafafa;
  --ink-secondary: #a1a1aa;
  --ink-muted: #a1a1aa;
  --ink-on-ink: #18181b;
  --track: #a3e635;
  --link: #93c5fd;
  --good-fg: #86efac;
  --good-bg: #14532d;
  --good-fill: #22c55e;
  --warn-fg: #fcd34d;
  --warn-bg: #451a03;
  --warn-fill: #f59e0b;
  --warn-line: #78350f;
  --warn-tint: #1c1408;
  --bad-fg: #fca5a5;
  --bad-bg: #450a0a;
  --bad-fill: #ef4444;
  --bad-line: #7f1d1d;
  --bad-tint: #1f0a0a;
  --info-fg: #93c5fd;
  --info-bg: #172554;
  --focus: #93c5fd;
}
`;

// orca-plugin/src/panel/board.ts
var command = (line) => `<code>${h(line)}</code>`;
var quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
function sections(s, scope) {
  const needs = needsYou(s, scope), runs = running(s, scope), done = doneToday(s, scope), executors = capacity(s);
  const c = counts(s);
  const runCount = (scope.repo === null ? c?.running : c?.byRepo[scope.repo]?.running) ?? runs.filter((t) => t.state === "running").length;
  const doneCount = (scope.repo === null ? s.today?.done : s.today?.byRepo[scope.repo] ?? 0) ?? done.length;
  const hidden = otherReposNeedingYou(s, scope), next = executors.find((e) => e.next);
  const section = (name, count, body, extra = "") => `<section class="stack section" aria-label="${name}"><div class="row"><h2>${name}</h2><span class="pill">${count}</span><span class="grow"></span>${extra}</div>${body}</section>`;
  const repo = (r) => scope.repo === null && r ? ` · ${h(r.label)}` : "";
  return section("Needs you", needs.length, needs.map((n) => {
    const actions = n.actions.map((a, index) => {
      const p = a.params, id = p.id ?? n.taskId;
      const line = a.op === "ui.open" ? `pacer open ${quote(`${p.view === "task" ? "sessions" : p.view === "session" ? "sessions" : p.view ?? "overview"}${p.view === "settings" && p.section ? `/${p.section}` : id ? `/${id}` : ""}`)}` : a.op === "host.check" ? `pacer host check ${quote(p.alias ?? n.host)}` : a.op === "task.retry" ? `pacer retry ${quote(id)}${p.executor ? ` --executor ${quote(p.executor)}` : ""}` : a.op === "task.review" ? `pacer review ${quote(id)} --${p.verdict === "accept" ? "accept" : "reject"}` : `pacer open ${quote(n.taskId ? `review/${n.taskId}` : n.host ? "settings/hosts" : "overview")}`;
      return { label: `<span class="action-block ${index === 0 ? "action-primary" : "action-secondary"}">${h(a.label)}</span>`, line: command(line) };
    });
    const executor = n.executor ?? s.tasks.find((t) => t.id === n.taskId)?.executor;
    return `<article class="card stack ${n.severity === "blocked" ? "bad" : n.severity === "problem" ? "warn" : "info"}"><div class="row attention-heading">${executor ? icon(executor, 22, n.account) : ""}<div class="stack grow"><strong>${h(n.title)}</strong><small>${n.kind === "failed" ? '<span class="bad" aria-label="Failed">✗</span> ' : ""}${h(n.detail)}${repo(n.repo)}</small></div></div><div class="row actions">${actions.map((a) => a.label).join("")}</div><div class="stack action-commands">${actions.map((a) => a.line).join("")}</div></article>`;
  }).join("") || "<small>Nothing needs you here.</small>", hidden ? `<a href="#all-repos">+${hidden} in other repos</a>` : "") + section("Running", runCount, runs.map((t) => `<article class="card stack"><div class="row">${t.executor ? icon(t.executor, 22) : ""}<strong class="grow">${h(t.goal.slice(0, 100))}</strong></div><small>${h(executorLabel(t.executor))} · ${h(t.progress ? phaseWords(t.progress.phase) : taskStatus(t).label)} · ${h(clock(t.attemptStartedAt ?? t.updatedAt, s.at))}${repo(t.repo)}</small>${command(`pacer open ${quote(`sessions/${t.id}`)}`)}</article>`).join("") || "<small>Nothing running here.</small>") + section("Capacity", executors.length, `<div class="card row capacity">${executors.map((e) => `<span class="executor ${toneFor(e.tone)}" title="${h(`${executorLabel(e.id)} · ${e.sub}`)}">${icon(e.agent, 24, e.account)}<span class="dot" aria-hidden="true"></span><span class="sr-only">${h(`${executorLabel(e.id)} · ${e.sub}`)}</span></span>`).join("")}<span class="grow"></span><small>${counts(s)?.ready ?? 0} ready${executors.some((e) => e.state === "down") ? ` · ${executors.filter((e) => e.state === "down").length} down` : ""}</small></div>`, next ? `<small>next: ${h(executorLabel(next.id))}</small>` : "") + section("Done today", doneCount, done.map((t) => {
    const status = taskStatus(t);
    return `<div class="row done ${status.tone}"><span title="${h(status.label)}" aria-label="${h(status.label)}">${status.tone === "good" ? "✓" : status.tone === "bad" ? "✗" : "·"}</span><span class="grow">${h(t.goal)}${repo(t.repo)}</span>${t.executor ? icon(t.executor, 16) : ""}<small class="done-time">${h(clock(t.updatedAt, s.at))}</small></div>`;
  }).join("") || "<small>Nothing done here today.</small>");
}
function board(s, repo) {
  const nav = (all) => `<nav class="scope-toggle" aria-label="Scope"><a href="#this-repo"${!all ? ' aria-current="true"' : ""}>This repo${repo ? ` · ${h(repo.label)}` : ""}</a><a href="#all-repos"${all ? ' aria-current="true"' : ""}>All repos</a></nav>`;
  return `<div id="all-repos" class="scope-all stack">${nav(true)}${sections(s, { repo: null })}</div><div id="this-repo" class="scope-here stack">${nav(false)}${sections(s, { repo: repo?.key ?? "__unknown_repo__" })}</div>`;
}
var boardStyle = `${tokens_default}
${agentStyle}
body{background:var(--surface-page);color:var(--ink);font:13px/19px var(--font-sans)}
.content{gap:14px;padding:10px 16px}.stack{gap:6px}.scope-here,.scope-all{gap:14px}.scope-all{display:none}.scope-all:target{display:flex}.scope-all:target~.scope-here{display:none}
a{color:var(--link)}a:hover{color:var(--ink)}a:focus-visible{outline:2px solid var(--focus);outline-offset:3px}a[aria-current]{font-weight:650}
.scope-toggle{display:flex;align-items:stretch;gap:6px}.scope-toggle a{display:flex;align-items:center;justify-content:center;flex:1 1 0;min-width:0;min-height:32px;padding:5px 8px;border:1px solid var(--line);border-radius:999px;background:var(--surface-page);color:var(--ink);font-size:12px;text-align:center;text-decoration:none}.scope-toggle a[aria-current]{background:var(--ink);border-color:var(--ink);color:var(--ink-on-ink)}
.attention-heading{align-items:flex-start}.attention-heading .stack{gap:2px}.actions{align-items:stretch;gap:6px}.action-block{display:flex;align-items:center;justify-content:center;min-height:30px;padding:5px 10px;border:1px solid var(--line);border-radius:6px;color:var(--ink);background:var(--surface-page);font-size:12px;text-align:center}.action-primary{flex:1;background:var(--ink);color:var(--ink-on-ink);border-color:var(--ink);font-weight:600}.action-commands code{display:block}.footer-actions{display:flex;flex-direction:column;gap:8px}.footer-actions .action-block{flex-direction:column;align-items:stretch;gap:4px;padding:10px;text-align:left}.footer-actions code{color:inherit}.planner-summary{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px}.planner-summary strong{font-weight:600}.planner-stats{text-align:right}.done-time{flex:none;text-align:right}.done .agent-mark{margin-left:auto}
header{padding-bottom:10px;border-bottom:1px solid var(--line)}.brand-tick{fill:var(--track)}.pill{background:var(--surface-lane);border-radius:999px}h2{color:var(--ink);font-size:11px;font-weight:600}.live,small,footer{color:var(--ink-muted);font-size:12px}
.card{border-color:var(--line);border-radius:10px;background:var(--surface-page);padding:8px 10px}.card.warn{border-color:var(--warn-line);background:var(--warn-tint)}.card.bad{border-color:var(--bad-line);background:var(--bad-tint)}.card strong{color:var(--ink)}
.good{color:var(--good-fg)}.warn{color:var(--warn-fg)}.bad{color:var(--bad-fg)}.info{color:var(--info-fg)}.neutral{color:var(--ink-muted)}.meter{background:var(--surface-lane)}.pace{background:var(--ink)}
code{font-family:var(--font-mono)}pre{background:var(--surface-lane)}footer{border-color:var(--line)}.capacity{flex-wrap:wrap;gap:12px}.executor{position:relative;display:inline-flex}.dot{position:absolute;right:-3px;bottom:-3px;width:8px;height:8px;border-radius:50%;background:currentColor;border:1px solid var(--surface-page)}.monogram{display:inline-flex;align-items:center;justify-content:center;font-size:11px}.done{font-size:12px}.done .grow{color:var(--ink)}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
`;
// orca-plugin/src/panel/repo.ts
import { dirname, resolve } from "node:path";
async function panelRepo(s, run) {
  try {
    const result = await run(["orca", "worktree", "show", "--worktree", "active", "--json"], 2000);
    if (result.code !== 0)
      return null;
    const reply = JSON.parse(result.stdout);
    if (!reply.ok)
      return null;
    const worktree = reply.result?.worktree;
    const path = worktree?.path ?? worktree?.id?.split("::")[1];
    const repoPath = reply.result?.repo?.path ?? worktree?.repo?.path;
    if (repoPath)
      return repos(s).find((r) => resolve(r.path) === resolve(repoPath)) ?? { key: repoPath, label: reply.result?.repo?.name ?? repoPath.split("/").pop(), path: repoPath };
    if (typeof path !== "string")
      return null;
    const git = await run(["git", "-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"], 2000);
    const root = git.code === 0 ? dirname(git.stdout.trim()) : path;
    return repos(s).find((r) => resolve(r.path) === resolve(root)) ?? { key: root, label: root.split("/").pop() ?? root, path: root };
  } catch {
    return null;
  }
}
// orca-plugin/src/panel.ts
function absolute(at, now, weekday = false) {
  const date = new Date(at * 1000), today = new Date(now * 1000);
  const clock = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  return weekday || date.toDateString() !== today.toDateString() ? `${date.toLocaleDateString("en-GB", { weekday: "short" })} ${clock}` : clock;
}
var percent = (p) => p.usedPct === null ? "Usage unknown" : `${Math.round(p.usedPct)}% used`;
var section = (title, body) => `<section class="stack section"><h2>${title}</h2>${body}</section>`;
function checklist(setup) {
  const rows = (required) => setup.items.filter((i) => i.required === required).map((i) => `<div class="step ${h(i.status)}"><span aria-hidden="true">${i.status === "done" ? "✓" : i.status === "failed" ? "!" : "·"}</span><div class="stack"><strong>${h(i.title)}</strong><small>${h(i.status)}${i.detail ? ` · ${h(i.detail)}` : ""}</small></div></div>`).join("");
  const optional = rows(false);
  return `${rows(true)}${optional ? `<div class="stack"><strong>Optional</strong>${optional}</div>` : ""}`;
}
function renderStatusPage(s, view) {
  const { nowS } = view, providers2 = providers(s), planner = plannerProvider(s);
  const reset = (p, weekday = false) => p.resetsAt === null ? "Reset unknown" : `Resets ${absolute(p.resetsAt, nowS, weekday)}`;
  const mode = s.mode?.mode ?? plannerMeter(s)?.mode ?? (s.planner === undefined ? s.budget?.mode : undefined) ?? "unknown";
  const header = `<header><span class="brand name">${mark}pacer</span><span class="pill">${h(modeWords(mode))}</span><span class="grow"></span><span class="live">${view.reachable ? "Live · updated" : "Not connected · last data"} ${h(s.planner === undefined ? absolute(s.at, nowS) : clock(s.at, s.at))}</span></header>`;
  let content;
  const setup = s.planner === undefined ? view.setup : s.setup?.ready !== undefined ? legacyChecklist(s, nowS, view.reachable, view.bootstrap) : view.setup ?? legacyChecklist(s, nowS, view.reachable, view.bootstrap);
  if (view.bootstrap && !(s.planner === undefined ? s.budget : s.service) && !setup?.complete) {
    const steps = ["install", "start"].map((name) => {
      const step = view.bootstrap[name];
      return `<p><strong>${name}: ${h(step.status)}</strong>${step.detail ? ` · ${h(step.detail)}` : ""}</p>`;
    }).join("");
    content = section("Welcome to pacer", "<p>pacer tracks your AI account budgets and task status. It helps you pace planning and delegate work to available executors.</p>") + section("Install", `<pre><code>${h(MANUAL_INSTALL)}</code></pre><pre><code>pacer init</code></pre>${steps}`) + section("Live panel", "<p>The live panel opens automatically once pacer is installed and the plugin restarts.</p>") + section("Act in pacer", "<p>Run <code>pacer open</code> in a terminal to open the pacer app, where you delegate, review and change settings.</p>");
  } else if (s.planner !== undefined) {
    content = `<div class="stack planner"><div class="planner-summary"><strong>Planner${planner ? ` · ${h(providerLabel(planner))}` : " unknown"}</strong>${planner ? `<span class="planner-stats">${h(planner.usedPct === null ? "Usage unknown" : `${Math.round(planner.usedPct)}%`)} · pace ${h(planner.pacePct === null ? "unknown" : Math.round(planner.pacePct))} · resets ${h(planner.resetsAt === null ? "unknown" : new Date(planner.resetsAt * 1000).toLocaleDateString("en-GB", { weekday: "short" }))}</span>` : ""}</div>${planner ? meter(planner) : ""}${s.planner ? `<small>${h(s.planner.advice)}</small>` : ""}</div>${board(s, view.repo ?? null)}`;
  } else {
    const accounts = accountGroups(providers2).flatMap((group) => {
      const rows = group.account ? [group.rows] : group.rows.map((p) => [p]);
      return rows.map((runners) => {
        const row = runners[0], account = s.planner === undefined ? undefined : s.accounts?.find((a) => a.name === group.account);
        const p = account ? { ...row, usedPct: account.usedPct, pacePct: account.pacePct, resetsAt: account.resetsAt, window: account.window, verdict: account.verdict } : row;
        return `<div class="account card stack"><strong>${h(group.account ?? providerLabel(p))}</strong><span>${h(verdictWords(p.verdict))} · ${h(percent(p))}${p.stale ? ' · <span class="pill">stale</span>' : ""}</span>${meter(p, true)}<small>${h(p.window ?? "Window unknown")} · ${h(reset(p))}</small><small>Runners: ${h(runners.map(providerLabel).join(", "))}</small></div>`;
      });
    }).join("");
    const running = s.tasks.filter((t) => t.state === "running" || t.state === "queued").map((t) => `<div class="card stack"><strong>${h(t.goal.slice(0, 100))}</strong><small>${h(t.executor ? displayName2(t.executor) : "Executor pending")} · ${h(t.state)} · started ${h(absolute(t.attemptStartedAt ?? t.updatedAt, nowS))}${t.progress ? ` · ${h(t.progress.phase)}` : ""}</small>${placementLine(t)}</div>`).join("");
    const waiting = s.tasks.filter((t) => !t.review && !t.dismissed && (t.state === "partial" || t.state === "done" || t.state === "needs_input")).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10).map((t) => `<div class="card stack"><strong>${h(t.goal)}</strong><small>${h(t.executor ? displayName2(t.executor) : "Executor unknown")} · ${t.state === "needs_input" ? "Needs your answer" : "finished"} ${h(absolute(t.updatedAt, nowS))}</small><small>${h(t.worktree ?? "Worktree unknown")}</small></div>`).join("");
    const alertRows = s.planner === undefined ? s.alerts : (s.attention ?? []).map((a) => ({ level: a.severity === "blocked" ? "error" : "warn", title: a.title, body: a.detail, at: a.raisedAt }));
    const alerts = alertRows.filter((a) => a.level === "warn" || a.level === "error").sort((a, b) => b.at - a.at).slice(0, 5).map((a) => `<div class="card stack"><strong>${h(a.title)}</strong><p>${h(a.body.slice(0, 200))}</p><small>${h(absolute(a.at, nowS))}</small></div>`).join("");
    const versions = `<p>pacer ${h((s.planner === undefined ? view.updates?.cli ?? s.console?.version : s.service?.version ?? view.updates?.cli) ?? "unknown")} · plugin ${h(view.updates?.plugin ?? "unknown")}</p>${view.updates?.available ? `<p>Update available: ${h(view.updates.latest ?? "unknown")} · <code>pacer update</code></p>` : ""}`;
    content = section("Planner", `<div class="card stack">${planner ? `<div class="row"><strong class="grow">${h(providerLabel(planner))}</strong><span>${h(percent(planner))}</span></div>${meter(planner)}<small>${h(reset(planner, true))}</small>` : "<small>Planner unknown · Reset unknown</small>"}<p class="headline">${h(headline(planner))}</p></div>`) + section("Accounts", accounts || "<small>No accounts reported.</small>") + section("Running", running || "<small>No tasks running.</small>") + section("Waiting for review", `${waiting || "<small>No tasks waiting for review.</small>"}<p>Review with <code>pacer review &lt;id&gt;</code> or in the pacer app.</p>`) + section("Alerts", alerts || "<small>No alerts.</small>") + section("Versions", versions);
  }
  if (!view.reachable && view.transport === null)
    content = section("Update the pacer plugin", "<p>Run <code>pacer update</code> in a terminal, then restart the plugin to connect to the pacer API.</p>") + content;
  if (setup?.ready)
    content += section("Setup ✓", "");
  else if (setup && (!setup.complete || setup.items.length > 0))
    content += section("Setup", `${checklist(setup)}<pre><code>pacer init</code></pre>`);
  const delegate = s.planner !== undefined && view.repo ? `<div class="action-block action-primary"><strong>Delegate from this worktree</strong><code>${h(`pacer delegate --repo '${view.repo.path.replace(/'/g, "'\\''")}' --goal '<goal>'`)}</code></div>` : "";
  const footer = `<footer><div class="footer-actions">${delegate}<div class="action-block action-secondary"><strong>Open pacer</strong><small>Run to open the pacer app (desktop first).</small><code>pacer open</code></div></div></footer>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"><title>pacer</title><style>${style}${boardStyle}</style></head><body><main class="content">${header}${content}${footer}</main></body></html>`;
}
function snapshotStrategy(s) {
  if (s.planner === undefined)
    return s.budget?.strategy;
  return s.strategies?.find((row) => typeof row !== "string" && row.active)?.name;
}

// src/plugin/panel-owner.ts
import { join as join7 } from "node:path";
var PANEL_OWNER_MARKER = ".pacer-panel-serve.json";
function serveOwnsPanel(root, readText, nowS) {
  try {
    const marker = JSON.parse(readText(join7(root, PANEL_OWNER_MARKER)) ?? "null");
    return typeof marker?.at === "number" && Number.isFinite(marker.at) && nowS >= marker.at && nowS - marker.at < 60;
  } catch {
    return false;
  }
}

// orca-plugin/src/plugin.ts
function createPlugin(deps) {
  let stopped = false;
  const clients = new Set;
  let stopWatch = null;
  let cancelRender = null;
  let cancelRetry = null;
  const timerCancels = new Set;
  const timers = {
    every(ms, fn) {
      const cancel = deps.timers.every(ms, fn);
      timerCancels.add(cancel);
      return () => {
        cancel();
        timerCancels.delete(cancel);
      };
    },
    after(ms, fn) {
      let cancel;
      cancel = deps.timers.after(ms, () => {
        timerCancels.delete(cancel);
        fn();
      });
      timerCancels.add(cancel);
      return () => {
        cancel();
        timerCancels.delete(cancel);
      };
    }
  };
  async function activate(ctx) {
    stopped = false;
    const mode = pluginMode(deps.pluginRoot, deps.fs);
    ctx.commands.register("open", async () => {
      if (deps.open) {
        await deps.open();
        return { ok: true };
      }
      await ctx.host.call("notifications.show", {
        title: "Open pacer",
        body: "Run `pacer open` in a terminal to open the pacer app."
      });
      return { ok: true };
    });
    for (const event of ["agent.status.changed", "worktree.created"])
      ctx.events.on(event, () => {});
    let updates;
    let updateBusy = false;
    const runUpdateCheck = async () => {
      if (stopped || updateBusy || !deps.checkUpdates || !deps.version)
        return;
      updateBusy = true;
      try {
        try {
          deps.reportVersion?.(mode, deps.version);
        } catch (e) {
          ctx.log(`pacer plugin version: ${String(e)}`);
        }
        const { check, cli } = await deps.checkUpdates();
        if (!stopped)
          updates = await notifyUpdates(ctx.host, mode, deps.version, check, cli);
      } catch (e) {
        ctx.log(`pacer update check: ${String(e)}`);
      } finally {
        updateBusy = false;
      }
    };
    runUpdateCheck();
    timers.every(UPDATE_INTERVAL_MS, () => {
      runUpdateCheck();
    });
    if (pluginMode(deps.pluginRoot, deps.fs) === "bootstrap") {
      const logError = (e) => ctx.log(`pacer bootstrap: ${e instanceof Error ? e.message : String(e)}`);
      if (deps.bootstrap) {
        const ready = deps.bootstrap.activate(ctx);
        const run = async () => {
          await ready;
          if (!stopped)
            await deps.bootstrap.run(ctx, () => {});
        };
        run().catch(logError);
        timers.every(30000, () => {
          run().catch(logError);
        });
      }
      return;
    }
    let raw = {};
    let settingsReady = false;
    let cancelSettings = () => {};
    try {
      const result = await Promise.race([
        ctx.host.call("settings.get").then((result) => {
          settingsReady = true;
          return result;
        }),
        new Promise((resolve) => {
          cancelSettings = timers.after(500, () => resolve({ settings: {} }));
        })
      ]);
      raw = result.settings;
    } catch {} finally {
      cancelSettings();
    }
    if (stopped)
      return;
    const settings = readSettings(raw, deps.home);
    settings.settingsReady = settingsReady;
    const store = new LinkStore(deps.nowS);
    const transports = [
      apiTransport({ timers, notifier: { version: deps.version ?? "0", deliver: (data) => deliverNotification(ctx.host, { title: data.title, body: data.body }, deps.nowS(), true) }, log: (m) => ctx.log(m), connect: async () => {
        const client = await deps.connect?.(settings) ?? null;
        if (stopped) {
          client?.close();
          return null;
        }
        if (client && !clients.has(client)) {
          const close = client.close.bind(client);
          client.close = () => {
            try {
              close();
            } finally {
              clients.delete(client);
            }
          };
          clients.add(client);
        }
        return client;
      } })
    ];
    let active = null, reachable = false, connecting = null;
    let lastSeenAt;
    let apiFailures = 0;
    let setup;
    let repo = null;
    let repoBusy = false;
    const refreshRepo = async () => {
      if (repoBusy || !deps.resolveRepo || store.snapshot.planner === undefined)
        return;
      repoBusy = true;
      try {
        const next = await deps.resolveRepo(store.snapshot);
        if (!stopped && JSON.stringify(next) !== JSON.stringify(repo)) {
          repo = next;
          scheduleRender(true);
        }
      } catch (e) {
        logError(e);
      } finally {
        repoBusy = false;
      }
    };
    timers.every(5000, () => {
      refreshRepo();
    });
    let renderedHtml = null;
    let lastRenderAt = -Infinity;
    let userOutcome = false;
    const panelUpdates = () => {
      if (!deps.version)
        return updates;
      const cached = deps.cachedUpdate?.();
      const latest = cached?.latest ?? updates?.latest ?? null;
      const cli = store.snapshot.service?.version ?? updates?.cli ?? null;
      const check = { checkedAt: deps.nowS(), latest, current: deps.version };
      return { plugin: deps.version, cli, latest, available: updateAvailable(check) || !!cli && updateAvailable({ ...check, current: cli }) };
    };
    const logError = (e) => ctx.log(`pacer: ${e instanceof Error ? e.message : String(e)}`);
    const scheduleRender = (immediate = false) => {
      if (immediate) {
        userOutcome = true;
        cancelRender?.();
        cancelRender = null;
      }
      if (stopped || cancelRender)
        return;
      cancelRender = timers.after(Math.max(200, (lastRenderAt + (userOutcome ? 2 : 10) - deps.nowS()) * 1000), () => {
        cancelRender = null;
        if (stopped)
          return;
        try {
          const nowS = deps.nowS();
          const html = renderStatusPage(store.snapshot, { nowS, transport: store.transport, reachable, setup, repo, bootstrap: deps.bootstrap?.state, updates: panelUpdates() });
          if (serveOwnsPanel(deps.pluginRoot, (path) => deps.fs.readText(path), nowS))
            renderedHtml = null;
          else if (html !== renderedHtml) {
            if (pluginMode(deps.pluginRoot, deps.fs) === "live") {
              deps.fs.writeTextAtomic(join8(deps.pluginRoot, "panel", "live.html"), html);
              renderedHtml = html;
              lastRenderAt = nowS;
              userOutcome = false;
            } else
              ctx.log("pacer: refused panel write: unmanaged root");
          }
        } catch (e) {
          logError(e);
        }
      });
    };
    if (deps.bootstrap) {
      let checking = false, nextCheckAt = 0, request = null;
      const checkSetup = async () => {
        const latest = deps.fs.readText(join8(settings.pacerHome, "check-setup-request.json"));
        if (latest !== request) {
          request = latest;
          nextCheckAt = 0;
        }
        if (stopped || checking || deps.nowS() < nextCheckAt)
          return;
        checking = true;
        try {
          const result = await deps.bootstrap.checkSetup(reachable, settings.pacerHome);
          if (stopped)
            return;
          setup = result;
          nextCheckAt = deps.nowS() + (result.complete ? 60 : 5);
          scheduleRender(true);
        } catch (e) {
          logError(e);
        } finally {
          checking = false;
        }
      };
      checkSetup();
      timers.every(5000, () => {
        checkSetup();
      });
    }
    let refreshingSettings = false;
    timers.every(30000, () => {
      if (stopped || refreshingSettings)
        return;
      refreshingSettings = true;
      ctx.host.call("settings.get").then((result) => {
        if (stopped)
          return;
        const updated = readSettings(result.settings, deps.home), changed = settings.notifications !== updated.notifications;
        settings.lastAlertAt = Math.max(settings.lastAlertAt, updated.lastAlertAt);
        settings.deliveredAlerts = [...settings.deliveredAlerts ?? [], ...updated.deliveredAlerts ?? []].slice(-200);
        settings.notifications = updated.notifications;
        settings.settingsReady = true;
        if (changed)
          scheduleRender(true);
      }).catch(() => {}).finally(() => {
        refreshingSettings = false;
      });
    });
    store.onChange(() => {
      scheduleRender();
      refreshRepo();
    });
    timers.every(15000, () => {
      scheduleRender();
    });
    const replaceSnapshot = (snapshot) => {
      if (stopped)
        return;
      const previous = store.snapshot;
      const taskChanged = snapshot.tasks.some((t) => !previous.tasks.some((p) => p.id === t.id) || t.dismissed !== previous.tasks.find((p) => p.id === t.id)?.dismissed || t.retriedBy !== previous.tasks.find((p) => p.id === t.id)?.retriedBy);
      const blockedChanged = snapshot.executors?.some((e) => e.state === "blocked" !== (previous.executors?.find((p) => p.id === e.id)?.state === "blocked"));
      const initiated = snapshotStrategy(snapshot) !== snapshotStrategy(previous) || taskChanged || blockedChanged;
      if (initiated) {
        userOutcome = true;
        if (cancelRender) {
          cancelRender();
          cancelRender = null;
        }
      }
      store.replace(snapshot);
    };
    const acceptSnapshot = (snapshot) => {
      if (stopped)
        return;
      apiFailures = 0;
      lastSeenAt = deps.nowS();
      if (!reachable) {
        reachable = true;
        scheduleRender(true);
      }
      replaceSnapshot(snapshot);
    };
    const connect = async () => {
      const chosen = await chooseTransport(transports, settings.transport);
      if (stopped)
        return;
      active = chosen.transport;
      reachable = chosen.reachable && !!active;
      if (reachable)
        lastSeenAt = deps.nowS();
      store.transport = active?.id ?? null;
      if (!active) {
        scheduleRender();
        cancelRetry = timers.after(settings.pollSeconds * 1000, () => {
          cancelRetry = null;
          ensureConnected();
        });
        return;
      }
      const snapshot = await active.snapshot().catch(() => null);
      if (stopped)
        return;
      if (snapshot)
        replaceSnapshot(snapshot);
      stopWatch = active.watch((e) => {
        if (!stopped) {
          lastSeenAt = deps.nowS();
          store.apply(e);
        }
      }, acceptSnapshot, () => {
        handleApiFailure().catch(logError);
      });
      scheduleRender();
    };
    function ensureConnected() {
      if (stopped || stopWatch)
        return Promise.resolve();
      if (!connecting) {
        cancelRetry?.();
        cancelRetry = null;
        connecting = connect().catch(logError).finally(() => {
          connecting = null;
        });
      }
      return connecting;
    }
    const handleApiFailure = async () => {
      const failures = ++apiFailures;
      if (stopped || active?.id !== "api")
        return;
      reachable = false;
      if (lastSeenAt !== undefined)
        timers.after(Math.max(0, (20 - (deps.nowS() - lastSeenAt)) * 1000), scheduleRender);
      if (failures >= 3) {
        stopWatch?.();
        stopWatch = null;
        apiFailures = 0;
        await ensureConnected();
      }
      scheduleRender();
    };
    ensureConnected();
  }
  return {
    activate,
    async deactivate() {
      stopped = true;
      deps.bootstrap?.stop();
      stopWatch?.();
      stopWatch = null;
      cancelRender?.();
      cancelRender = null;
      cancelRetry?.();
      cancelRetry = null;
      for (const client of clients)
        client.close();
      clients.clear();
      for (const cancel of timerCancels)
        cancel();
      timerCancels.clear();
    }
  };
}

// orca-plugin/src/worker.ts
var timers = {
  every(ms, fn) {
    const timer = setInterval(fn, ms);
    return () => clearInterval(timer);
  },
  after(ms, fn) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  }
};
function checkLoopback(url) {
  const u = new URL(url);
  if (u.protocol !== "http:" || u.hostname !== "127.0.0.1" || u.username || u.password)
    throw new Error("pacer worker only supports loopback HTTP");
}
var http = {
  post(url, token, data, timeoutMs) {
    return new Promise((resolve, reject) => {
      checkLoopback(url);
      const body = JSON.stringify(data);
      const req = request(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
        let response = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          response += chunk;
          if (Buffer.byteLength(response) > 256 * 1024)
            req.destroy(new Error("pacer response exceeds 256 KiB"));
        });
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: response, headers: res.headers }));
      });
      const timeout = setTimeout(() => req.destroy(new Error("pacer HTTP timeout")), timeoutMs);
      req.on("close", () => clearTimeout(timeout));
      req.on("error", reject);
      req.end(body);
    });
  },
  get(url, token, timeoutMs) {
    return new Promise((resolve, reject) => {
      checkLoopback(url);
      const req = get(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
          if (Buffer.byteLength(body) > 256 * 1024)
            req.destroy(new Error("pacer snapshot exceeds 256 KiB"));
        });
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      });
      const timeout = setTimeout(() => req.destroy(new Error("pacer HTTP timeout")), timeoutMs);
      req.on("close", () => clearTimeout(timeout));
      req.on("error", reject);
    });
  },
  stream(url, token, onLine, onClose) {
    checkLoopback(url);
    let stopped = false, closed = false;
    const close = (err) => {
      if (!stopped && !closed) {
        closed = true;
        onClose(err);
      }
    };
    const req = get(url, { headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        close(new Error(`pacer events HTTP ${res.statusCode}`));
        req.destroy();
        return;
      }
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (stopped)
          return;
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf(`
`)) >= 0) {
          onLine(buffer.slice(0, newline).replace(/\r$/, ""));
          buffer = buffer.slice(newline + 1);
        }
        if (Buffer.byteLength(buffer) > 256 * 1024)
          req.destroy(new Error("pacer SSE line exceeds 256 KiB"));
      });
      res.on("end", () => close());
      res.on("close", () => close());
      res.on("error", close);
    });
    req.on("error", close);
    return () => {
      stopped = true;
      req.destroy();
    };
  }
};
var pluginRoot = dirname2(fileURLToPath3(import.meta.url));
var PLUGIN_VERSION = (() => {
  try {
    const version = JSON.parse(readFileSync6(join9(pluginRoot, "orca-plugin.json"), "utf8")).version;
    if (isVersion(version))
      return version;
  } catch {}
  return package_default.version;
})();
var log = (message) => {};
var workerEnv = { ...process.env };
var pacerHome = workerEnv.PACER_HOME || join9(workerEnv.HOME ?? workerEnv.USERPROFILE ?? "", ".pacer");
var runPanelCommand = (argv, timeoutMs) => new Promise((resolve) => {
  execFile2(argv[0] === "orca" ? resolveOrcaCli(workerEnv) : argv[0], argv.slice(1), { env: workerEnv, timeout: timeoutMs }, (error, stdout, stderr) => resolve({ code: error ? 1 : 0, stdout, stderr }));
});
var plugin = createPlugin({
  resolveRepo: (snapshot) => panelRepo(snapshot, runPanelCommand),
  async open() {
    const binary = workerEnv.PACER_BIN || (existsSync3(join9(workerEnv.HOME ?? "", ".local/bin/pacer")) ? join9(workerEnv.HOME ?? "", ".local/bin/pacer") : "pacer");
    const result = await runPanelCommand([binary, "open"], 1e4);
    if (result.code !== 0)
      throw new Error(result.stderr || "Could not open pacer");
  },
  async connect(settings) {
    const base = `http://127.0.0.1:${settings.port}`;
    try {
      const health = await http.get(`${base}/health`, "", 500);
      if (health.status === 200 && health.headers?.["x-pacer"] === "1") {
        const token = readFileSync6(join9(settings.pacerHome, "token"), "utf8").trim();
        if (token)
          return new HttpClient(base, token);
      }
    } catch {}
    try {
      const binary = workerEnv.PACER_BIN || (existsSync3(join9(workerEnv.HOME ?? "", ".local/bin/pacer")) ? join9(workerEnv.HOME ?? "", ".local/bin/pacer") : "pacer");
      const env = { ...workerEnv, PACER_BIN: binary, PACER_HOME: settings.pacerHome };
      return new StdioClient([binary], env, { log: (m) => log(m) });
    } catch {
      return null;
    }
  },
  version: PLUGIN_VERSION,
  cachedUpdate: () => readUpdateCheck({ pacerHome, env: workerEnv }, PLUGIN_VERSION),
  reportVersion(mode, version) {
    mkdirSync4(pacerHome, { recursive: true });
    const path = join9(pacerHome, "plugin-version.json"), temp = `${path}.${process.pid}.tmp`;
    writeFileSync4(temp, JSON.stringify({ mode, version }));
    renameSync4(temp, path);
  },
  async checkUpdates() {
    const check = await checkForUpdate({ pacerHome, env: workerEnv, now: Date.now() / 1000 }, { force: true, current: PLUGIN_VERSION });
    const binary = workerEnv.PACER_BIN || (existsSync3(join9(workerEnv.HOME ?? "", ".local/bin/pacer")) ? join9(workerEnv.HOME ?? "", ".local/bin/pacer") : "pacer");
    const cli = await new Promise((resolve) => execFile2(binary, ["--version"], { timeout: 3000, env: workerEnv }, (error, stdout) => resolve(error ? null : stdout.trim().replace(/^pacer\s+/, ""))));
    return { check, cli };
  },
  bootstrap: createBootstrap({ home: process.env.HOME ?? process.env.USERPROFILE ?? "", env: process.env, version: PLUGIN_VERSION, mode: pluginMode(pluginRoot, { exists: existsSync3 }) }),
  nowS: () => Date.now() / 1000,
  timers,
  http,
  home: process.env.HOME ?? process.env.USERPROFILE ?? "",
  pluginRoot,
  fs: {
    readText(path) {
      try {
        return readFileSync6(path, "utf8");
      } catch {
        return null;
      }
    },
    exists: existsSync3,
    writeTextAtomic(path, text) {
      if (pluginMode(pluginRoot, { exists: existsSync3 }) !== "live" || resolve2(path) !== resolve2(pluginRoot, "panel", "live.html")) {
        log("pacer: refused panel write: unexpected path");
        return;
      }
      const temporary = `${path}.${process.pid}.tmp`;
      try {
        writeFileSync4(temporary, text, "utf8");
        renameSync4(temporary, path);
      } finally {
        try {
          unlinkSync3(temporary);
        } catch {}
      }
    }
  }
});
var liveTimer;
async function activate(ctx) {
  log = (message) => ctx.log(message);
  if (pluginMode(pluginRoot, { exists: existsSync3 }) === "live") {
    const heartbeat = () => {
      try {
        writeLiveHeartbeat(pacerHome, { version: PLUGIN_VERSION, pid: process.pid, at: Date.now() / 1000 });
      } catch (e) {
        log(`pacer heartbeat: ${e}`);
      }
    };
    heartbeat();
    liveTimer = setInterval(heartbeat, 30000);
  }
  await plugin.activate(ctx);
}
async function deactivate() {
  clearInterval(liveTimer);
  removeLiveHeartbeat(pacerHome, process.pid);
  await plugin.deactivate();
}
export {
  deactivate,
  activate as default
};
