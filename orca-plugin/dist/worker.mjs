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
var SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
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
    typescript: "^7.0.2"
  },
  version: "0.2.3",
  bin: {
    pacer: "src/cli.ts"
  },
  scripts: {
    test: "TZ=Asia/Ho_Chi_Minh bun test",
    typecheck: "tsc --noEmit && tsc -p app",
    build: "bun build --compile src/cli.ts --outfile dist/pacer",
    release: "bun scripts/release/build.ts",
    "release:prepare": "bun scripts/release/prepare.ts",
    "release:host": "bun scripts/release/build.ts --host",
    "plugin:build": "bun orca-plugin/build.ts",
    "protocol:doc": "bun scripts/protocol-doc.ts",
    "release:npm": "bun scripts/release/npm.ts",
    "release:homebrew": "bun scripts/release/homebrew.ts",
    "brand:render": "bun scripts/brand/render.ts",
    "app:build": "bun app/build.ts"
  },
  dependencies: {
    "@modelcontextprotocol/sdk": "1.32.1",
    preact: "10.29.8",
    yaml: "2.8.2",
    zod: "4.6.5",
    "@xterm/headless": "6.0.0",
    "@xterm/addon-serialize": "0.14.0"
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

// src/setup/checklist.ts
function setupChecklist(f, checkedAt) {
  const item = (id, title, done, detail) => ({ id, title, required: true, status: f.errors?.[id] ? "failed" : done ? "done" : "pending", detail: f.errors?.[id] ?? detail, ...!done || f.errors?.[id] ? { command: "pacer init" } : {} });
  const items = [
    item("binary", "Binary", !!f.version, f.version ?? undefined),
    item("strategy", "Strategy", !!f.planner, f.planner ? `Planner: ${f.planner}` : undefined),
    item("service", "Login service", f.service.installed && f.service.running),
    item("link", "Link", f.link),
    { id: "live", title: "Live plugin", required: false, status: f.live ? "done" : "pending", ...!f.live ? { command: "pacer init" } : {} },
    ...f.agents.map((a) => ({ id: `agent:${a.id}`, title: a.name, required: false, status: a.installed ? "done" : "pending", detail: a.installed ? "Connected" : "Optional · not connected", ...!a.installed ? { command: "pacer init" } : {} }))
  ];
  return { checkedAt, complete: items.filter((i) => i.required).every((i) => i.status === "done"), items };
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
// src/install/fsx.ts
function shq(s) {
  return /^[A-Za-z0-9_\/.:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}
function shellCommand(argv) {
  return argv.map(shq).join(" ");
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
import { dirname, join as join9, resolve } from "node:path";
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
    transport: ["auto", "api", "http", "channel", "bridge"].includes(raw.transport) ? raw.transport : "auto",
    port: finite(raw.port) && Number.isInteger(raw.port) && raw.port >= 1 && raw.port <= 65535 ? raw.port : 4317,
    pacerHome: typeof raw.pacerHome === "string" && raw.pacerHome.length > 0 ? raw.pacerHome : `${home}/.pacer`,
    pollSeconds: finite(raw.pollSeconds) ? Math.max(5, Math.min(300, raw.pollSeconds)) : 10,
    ...Array.isArray(raw.deliveredAlerts) ? { deliveredAlerts: raw.deliveredAlerts.filter((a) => !!a && typeof a === "object" && typeof a.key === "string" && finite(a.at)).slice(-200) } : {},
    lastAlertAt: finite(raw.lastAlertAt) && raw.lastAlertAt >= 0 ? raw.lastAlertAt : 0
  };
}

// src/link/envelope.ts
var LIMITS = { providers: 32, tasks: 20, alerts: 10, goal: 200, title: 120, body: 1000, id: 128, cmdLine: 4096, heartbeatS: 30 };
var isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var str = (v, max) => typeof v === "string" ? v.slice(0, max) : null;
var optStr = (v, max) => typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;
var num = (v) => typeof v === "number" && Number.isFinite(v) ? v : null;
var LEVELS = ["info", "warn", "error"];
function clip(s, max) {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 3))}...`;
}
function parseBudget(d) {
  if (!isObj(d))
    return null;
  const generatedAt = num(d.generatedAt), strategy = str(d.strategy, 128), planner = str(d.planner, 64), mode = str(d.mode, 32);
  if (generatedAt === null || strategy === null || planner === null || mode === null)
    return null;
  const providers = (Array.isArray(d.providers) ? d.providers : []).slice(0, LIMITS.providers).flatMap((p) => {
    if (!isObj(p))
      return [];
    const id = str(p.id, 64), verdict = str(p.verdict, 32);
    if (id === null || verdict === null)
      return [];
    return [{ id, ...optStr(p.agent, 64) && optStr(p.account, 64) ? { agent: optStr(p.agent, 64), account: optStr(p.account, 64) } : {}, ...optStr(p.unavailableReason, 500) ? { unavailableReason: optStr(p.unavailableReason, 500) } : {}, verdict, usedPct: num(p.usedPct), pacePct: num(p.pacePct), resetsAt: num(p.resetsAt), window: optStr(p.window, 32), stale: p.stale === true, ...optStr(p.brokenReason, 500) ? { brokenReason: optStr(p.brokenReason, 500) } : {}, ...optStr(p.blockedReason, 500) ? { blockedReason: optStr(p.blockedReason, 500), blockedUntil: num(p.blockedUntil) } : {} }];
  });
  const ranked = (Array.isArray(d.ranked) ? d.ranked : []).slice(0, LIMITS.providers).flatMap((r) => {
    if (!isObj(r))
      return [];
    const id = str(r.id, 64), verdict = str(r.verdict, 32);
    return id === null || verdict === null ? [] : [{ id, verdict }];
  });
  return { generatedAt, strategy, planner, mode, providers, ranked };
}
function parseTask(d) {
  if (!isObj(d))
    return null;
  const id = str(d.id, LIMITS.id), state = str(d.state, 16), updatedAt = num(d.updatedAt);
  if (!id || !state || updatedAt === null)
    return null;
  return {
    id,
    state,
    updatedAt,
    goal: str(d.goal, LIMITS.goal) ?? "",
    executor: optStr(d.executor, 64),
    backend: optStr(d.backend, 32),
    worktree: optStr(d.worktree, 4096),
    ...isObj(d.placement) && ["current", "new"].includes(String(d.placement.mode)) && typeof d.placement.why === "string" ? { placement: { mode: d.placement.mode, why: d.placement.why.slice(0, 240) } } : {},
    ...typeof d.terminalPresent === "boolean" ? { terminalPresent: d.terminalPresent } : {},
    ...optStr(d.resolved, 240) ? { resolved: optStr(d.resolved, 240) } : {},
    ...isObj(d.review) && typeof d.review.accepted === "boolean" && num(d.review.at) !== null ? { review: { accepted: d.review.accepted, kind: optStr(d.review.kind, 64), note: optStr(d.review.note, 1000), at: num(d.review.at) } } : {},
    ...d.dismissed === true ? { dismissed: true } : {},
    ...optStr(d.retriedBy, 128) ? { retriedBy: optStr(d.retriedBy, 128) } : {},
    ...optStr(d.retryOf, 128) ? { retryOf: optStr(d.retryOf, 128) } : {},
    ...optStr(d.brokenExecutor, 64) ? { brokenExecutor: optStr(d.brokenExecutor, 64) } : {},
    ...optStr(d.brokenReason, 500) ? { brokenReason: optStr(d.brokenReason, 500) } : {},
    ...num(d.attemptStartedAt) !== null ? { attemptStartedAt: num(d.attemptStartedAt) } : {},
    ...isObj(d.progress) && typeof d.progress.phase === "string" && num(d.progress.files) !== null && num(d.progress.commits) !== null && num(d.progress.logBytes) !== null ? { progress: { phase: d.progress.phase.slice(0, 16), lastOutputAt: num(d.progress.lastOutputAt), files: num(d.progress.files), commits: num(d.progress.commits), logBytes: num(d.progress.logBytes) } } : {},
    ...typeof d.runnerAlive === "boolean" ? { runnerAlive: d.runnerAlive } : {}
  };
}
function parseMode(d) {
  if (!isObj(d))
    return null;
  const mode = str(d.mode, 32), strategy = str(d.strategy, 128), at = num(d.at);
  if (!mode || strategy === null || at === null)
    return null;
  return { mode, strategy, at, previous: optStr(d.previous, 32) };
}
function parseAlert(d) {
  if (!isObj(d))
    return null;
  const error = optStr(d.error, LIMITS.body), level = LEVELS.includes(d.level) ? d.level : error ? "error" : "info";
  const alert = { key: optStr(d.key, LIMITS.id) ?? "alert", level, title: clip(optStr(d.title, 4096) ?? "pacer", LIMITS.title), body: clip(str(d.body, 4096) ?? error ?? "", LIMITS.body), at: num(d.at) ?? 0 };
  if (error)
    alert.error = error;
  const n = d.notification;
  if (isObj(n) && ["failed", "done", "broken", "quota", "strategy", "session"].includes(String(n.kind)))
    alert.notification = { kind: n.kind, ...n.fromPanel === true ? { fromPanel: true } : {}, ...n.near === true ? { near: true } : {}, ...optStr(n.executor, 64) ? { executor: optStr(n.executor, 64) } : {}, ...optStr(n.goal, 1000) ? { goal: optStr(n.goal, 1000) } : {}, ...optStr(n.nextExecutor, 64) ? { nextExecutor: optStr(n.nextExecutor, 64) } : {}, ...optStr(n.strategy, 128) ? { strategy: optStr(n.strategy, 128) } : {}, ...num(n.resetsAt) !== null ? { resetsAt: num(n.resetsAt) } : {} };
  return alert;
}
function parseConsole(d) {
  if (!isObj(d))
    return null;
  const pid = num(d.pid), startedAt = num(d.startedAt), heartbeatAt = num(d.heartbeatAt);
  if (pid === null || startedAt === null || heartbeatAt === null)
    return null;
  return { ...optStr(d.version, 64) ? { version: optStr(d.version, 64) } : {}, ...optStr(d.worktreeId, 1024) ? { worktreeId: optStr(d.worktreeId, 1024) } : {}, pid, startedAt, heartbeatAt, ...num(d.busyUntil) !== null ? { busyUntil: num(d.busyUntil) } : {}, handle: optStr(d.handle, 1024), paneKey: optStr(d.paneKey, 2048) };
}
function parseEnvelope(raw) {
  if (!isObj(raw) || raw.v !== 1)
    return null;
  switch (raw.type) {
    case "config": {
      const d = raw.data;
      if (!isObj(d) || !optStr(d.area, 128) || num(d.at) === null)
        return null;
      return { v: 1, type: "config", data: { area: optStr(d.area, 128), at: num(d.at) } };
    }
    case "budget": {
      const data = parseBudget(raw.data);
      return data && { v: 1, type: "budget", data };
    }
    case "task": {
      const data = parseTask(raw.data);
      return data && { v: 1, type: "task", data };
    }
    case "mode": {
      const data = parseMode(raw.data);
      return data && { v: 1, type: "mode", data };
    }
    case "alert": {
      const data = parseAlert(raw.data);
      return data && { v: 1, type: "alert", data };
    }
    default:
      return null;
  }
}
function emptySnapshot() {
  return { v: 1, seq: 0, at: 0, budget: null, mode: null, tasks: [], alerts: [], console: null, consoles: [], strategies: [] };
}
function parseSnapshot(raw) {
  if (!isObj(raw) || raw.v !== 1)
    return null;
  const seq = num(raw.seq), at = num(raw.at);
  if (seq === null || at === null)
    return null;
  const list = (v, f, max) => (Array.isArray(v) ? v : []).map(f).filter((x) => x !== null).slice(0, max);
  return { v: 1, seq, at, ...typeof raw.serviceInstalled === "boolean" ? { serviceInstalled: raw.serviceInstalled } : {}, budget: raw.budget == null ? null : parseBudget(raw.budget), mode: raw.mode == null ? null : parseMode(raw.mode), tasks: list(raw.tasks, parseTask, LIMITS.tasks), alerts: list(raw.alerts, parseAlert, LIMITS.alerts), console: raw.console == null ? null : parseConsole(raw.console), consoles: list(raw.consoles, parseConsole, 32), strategies: list(raw.strategies, (v) => typeof v === "string" ? optStr(v, 128) : isObj(v) && optStr(v.name, 128) ? { name: optStr(v.name, 128), active: v.active === true, summary: str(v.summary, 1000) ?? "", description: str(v.description, 1000) ?? "" } : null, 32) };
}
function reduce(s, e, at) {
  const next = { ...s, seq: s.seq + 1, at };
  switch (e.type) {
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
    const changed = contentKey(s) !== contentKey(this.snapshot);
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
var TRANSPORT_ORDER = ["api", "http", "channel", "bridge"];
async function chooseTransport(ts, forced) {
  const probe = async (t) => {
    try {
      return await t.probe();
    } catch {
      return false;
    }
  };
  if (forced !== "auto") {
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
            await c.hello();
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
      let unsubscribe = () => {};
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
        unsubscribe = c.subscribe(seq, (e) => {
          if (stopped)
            return;
          if (e.type === "reset") {
            if (busy)
              resetPending = true;
            else
              refresh();
            return;
          }
          if (!["budget", "task", "mode", "alert"].includes(e.type))
            return;
          const envelope = parseEnvelope({ v: 1, type: e.type, data: e.data });
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
      };
    }
  };
}

// orca-plugin/src/transports/http.ts
function httpTransport(o) {
  const base = `http://127.0.0.1:${o.port}`;
  async function request(path, token) {
    let cancel = () => {};
    try {
      return await Promise.race([
        o.http.get(base + path, token, 1500),
        new Promise((resolve) => {
          cancel = o.timers.after(1500, () => resolve(null));
        })
      ]);
    } catch {
      return null;
    } finally {
      cancel();
    }
  }
  async function identified() {
    const health = await request("/health", "");
    return health?.status === 200 && health.headers?.["x-pacer"] === "1";
  }
  async function get() {
    try {
      if (!await identified())
        return null;
      const token = o.readToken();
      if (!token)
        return null;
      const response = await request("/link", token);
      return response?.headers?.["x-pacer"] === "1" ? response : null;
    } catch {
      return null;
    }
  }
  async function snapshot() {
    const r = await get();
    if (r?.status !== 200)
      return null;
    try {
      return parseSnapshot(JSON.parse(r.body));
    } catch {
      return null;
    }
  }
  return {
    id: "http",
    probe: async () => (await get())?.status === 200,
    snapshot,
    watch(onEnvelope, onSnapshot, onFailure) {
      let stopped = false, failures = 0;
      let stopStream = () => {}, cancelRetry = () => {};
      let refreshBusy = false;
      const reconnect = () => {
        if (stopped)
          return;
        const delay = [2000, 4000, 8000, 16000, 30000][Math.min(failures++, 4)];
        cancelRetry();
        cancelRetry = o.timers.after(delay, () => {
          connect();
        });
      };
      const connect = async () => {
        if (stopped)
          return;
        stopStream();
        try {
          if (!await identified()) {
            reconnect();
            return;
          }
          if (stopped)
            return;
          const token = o.readToken();
          if (!token) {
            reconnect();
            return;
          }
          stopStream = o.http.stream(`${base}/events`, token, (chunk) => {
            for (const line of chunk.split(/\r?\n/)) {
              if (!line.startsWith("data: "))
                continue;
              try {
                const e = parseEnvelope(JSON.parse(line.slice(6)));
                if (e) {
                  failures = 0;
                  onEnvelope(e);
                }
              } catch {}
            }
          }, reconnect);
        } catch {
          reconnect();
        }
      };
      const cancelPoll = o.timers.every(1e4, () => {
        if (refreshBusy)
          return;
        refreshBusy = true;
        snapshot().then((s) => {
          if (!stopped) {
            if (s)
              onSnapshot(s);
            else
              onFailure?.();
          }
        }).finally(() => {
          refreshBusy = false;
        });
      });
      connect();
      return () => {
        stopped = true;
        stopStream();
        cancelRetry();
        cancelPoll();
      };
    }
  };
}

// orca-plugin/src/transports/bridge.ts
function bridgeTransport(o) {
  async function snapshot() {
    try {
      return parseSnapshot((await o.host.call("storage.get", { key: "link" })).value);
    } catch {
      return null;
    }
  }
  return {
    id: "bridge",
    snapshot,
    probe: async () => await snapshot() !== null,
    watch(_onEnvelope, onSnapshot) {
      let key = null, stopped = false, busy = false;
      const cancel = o.timers.every(Math.min(o.pollMs, 1000), () => {
        if (busy)
          return;
        busy = true;
        snapshot().then((s) => {
          if (s && !stopped) {
            const next = contentKey(s);
            if (next !== key) {
              key = next;
              onSnapshot(s);
            }
          }
        }).finally(() => {
          busy = false;
        });
      });
      return () => {
        stopped = true;
        cancel();
      };
    }
  };
}

// orca-plugin/src/transports/channel.ts
var CHANNEL_EVENT = "plugin.message";
function channelTransport(o) {
  let listener = null;
  let registered = false;
  return {
    id: "channel",
    probe: async () => {
      try {
        await o.host.call("events.subscribe", { events: [CHANNEL_EVENT] });
        if (!registered) {
          o.registerEvent(CHANNEL_EVENT, (p) => {
            if (typeof p !== "object" || !p)
              return;
            const e = parseEnvelope(p.data);
            if (e)
              listener?.(e);
          });
          registered = true;
        }
        return true;
      } catch {
        return false;
      }
    },
    snapshot: async () => null,
    watch(onEnvelope) {
      listener = onEnvelope;
      return () => {
        listener = null;
      };
    }
  };
}

// src/link/notification.ts
var executorName = (id) => NAMES[id ?? ""] ?? "the executor";
var NAMES = { "claude-code": "Claude", codex: "Codex", cursor: "Cursor", agy: "Antigravity", byteplus: "BytePlus", opencode: "OpenCode", local: "Local model" };
function shortGoal(goal, max = 90) {
  const text = goal.replace(/\s+/g, " ").trim();
  if (text.length <= max)
    return text;
  const prefix = text.slice(0, max - 1), space = prefix.lastIndexOf(" ");
  return prefix.slice(0, space > max / 2 ? space : prefix.length) + "…";
}

// orca-plugin/src/notify.ts
var shownAt = new WeakMap;
async function deliverNotification(host, message, nowS) {
  if (nowS - (shownAt.get(host) ?? -Infinity) < 5)
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
var id = (a) => JSON.stringify([a.key, a.at]);
function notificationMessage(a) {
  const n = a.notification, name = executorName(n?.executor);
  const next = n?.nextExecutor ? `Moved to ${executorName(n.nextExecutor)} automatically.` : n?.kind === "failed" ? "Open the pacer panel to retry." : "Nothing to do.";
  let title = a.title.replace(/\bpacer\b[: ]*/gi, "").trim(), body = "Nothing to do.";
  if (n) {
    title = n.kind === "failed" ? `Task failed on ${name}` : n.kind === "done" ? `Task done on ${name}` : n.kind === "broken" ? `${name} isn't starting` : n.kind === "quota" ? `${name} ${n.near ? "is near its limit" : "is out of quota"}${!n.near && n.resetsAt ? ` until ${new Date(n.resetsAt * 1000).toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).replace(",", "")}` : ""}` : n.kind === "strategy" ? `Switched to strategy ${n.strategy}` : "Strategy session opened";
    body = `${shortGoal(n.goal ?? "")}
${n.kind === "failed" && n.nextExecutor ? `Open the pacer panel to retry on ${executorName(n.nextExecutor)}.` : next}`;
  }
  if (!n)
    title = title.replace(/\bagy\b/g, "Antigravity").replace(/\bcodex\b/gi, "Codex").replace(/\bcursor\b/gi, "Cursor").replace(/\bclaude-code\b/g, "Claude").replace(/\s+(via|backend)\b.*$/i, "");
  return { title: shortGoal(title, 60), body };
}
async function notifyNewAlerts(host, s, settings, activatedAtS, nowS = Date.now() / 1000) {
  let state = states.get(settings);
  if (!state) {
    state = { since: settings.settingsReady === false ? activatedAtS : Math.max(settings.lastAlertAt, activatedAtS - 300), delivered: new Set((settings.deliveredAlerts ?? []).map((a) => JSON.stringify([a.key, a.at]))), pending: new Map, lastSent: -Infinity };
    states.set(settings, state);
  }
  const level = settings.notifications ?? "important";
  if (level === "off") {
    state.pending.clear();
    return settings.lastAlertAt;
  }
  const important = (a) => a.notification?.kind === "broken" || ["failed", "done"].includes(a.notification?.kind ?? "") && a.notification?.fromPanel === true || a.notification?.kind === "quota" && a.notification.executor === "claude-code";
  for (const a of s.alerts)
    if (a.at > Math.max(state.since, settings.lastAlertAt) && !state.delivered.has(id(a))) {
      if (level === "all" || important(a))
        state.pending.set(id(a), a);
    }
  if (nowS - state.lastSent < 5)
    return settings.lastAlertAt;
  const pending = [...state.pending.values()].sort((a, b) => a.at - b.at);
  const a = pending[0];
  const batched = a?.notification?.kind === "failed" || a?.notification?.kind === "broken";
  if (batched && nowS - a.at < 30)
    return settings.lastAlertAt;
  if (!a)
    return settings.lastAlertAt;
  const batch = batched ? pending.filter((x) => x.notification?.kind === a.notification?.kind && x.notification?.executor === a.notification?.executor && Math.abs(x.at - a.at) <= 30) : [a];
  const message = notificationMessage(a);
  if (batch.length > 1) {
    message.title = a.notification?.kind === "broken" ? `${executorName(a.notification.executor)} isn't starting` : `${batch.length} tasks failed on ${executorName(a.notification?.executor)}`;
    message.body = `${a.notification?.kind === "broken" ? `${batch.length} tasks affected` : shortGoal(a.notification?.goal ?? "")}
${a.notification?.nextExecutor ? `Moved to ${executorName(a.notification.nextExecutor)} automatically.` : "Open the pacer panel to retry."}`;
  }
  const delivered = await deliverNotification(host, message, nowS);
  if (!delivered)
    return settings.lastAlertAt;
  state.lastSent = nowS;
  for (const item of batch) {
    state.pending.delete(id(item));
    state.delivered.add(id(item));
  }
  settings.deliveredAlerts = [...settings.deliveredAlerts ?? [], ...batch.map((x) => ({ key: x.key, at: x.at }))].slice(-200);
  await host.call("settings.set", { key: "deliveredAlerts", value: settings.deliveredAlerts });
  const newest = Math.max(settings.lastAlertAt, ...batch.map((x) => x.at));
  settings.lastAlertAt = state.pending.size ? Math.min(newest, Math.min(...[...state.pending.values()].map((x) => x.at)) - 0.001) : newest;
  await host.call("settings.set", { key: "lastAlertAt", value: settings.lastAlertAt });
  return settings.lastAlertAt;
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

// src/view-model/format.ts
var displayName2 = (id) => parseRunnerId(id) || Object.hasOwn(names2, id) ? displayName(id) : id;

// orca-plugin/src/panel/shared.ts
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
var h = (v) => escapeHtml(String(v ?? ""));

// src/view-model/panel.ts
var providerLabel = (p) => p.agent ? runnerLabel(p) : displayName2(p.id);
var words = { ON_PACE: "Available", OK: "Available", UNMETERED: "Available", AHEAD: "Ahead of pace", BEHIND: "Behind pace", EXPIRING: "Expiring soon", EXPIRING_SOON: "Expiring soon", NEAR_LIMIT: "Near limit", EXHAUSTED: "Out of quota" };
var verdictWords = (v) => Object.hasOwn(words, v) ? words[v] : "Unknown";
var tone = (v) => v === "EXHAUSTED" ? "bad" : ["AHEAD", "NEAR_LIMIT", "EXPIRING", "EXPIRING_SOON"].includes(v) ? "warn" : ["OK", "ON_PACE", "BEHIND", "UNMETERED"].includes(v) ? "good" : "neutral";
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
// orca-plugin/src/panel/overview.ts
function placementLine(t) {
  return t.placement ? `<small class="muted">${h(`${t.placement.mode} worktree${t.placement.mode === "new" && t.worktree ? ` ${t.worktree}` : ""} (${t.placement.why})`)}</small>` : "";
}
function meter(p, slim = false) {
  if (p.usedPct === null)
    return "";
  const used = Math.max(0, Math.min(100, p.usedPct)), pace = p.pacePct == null ? null : Math.max(0, Math.min(100, p.pacePct));
  return `<div class="meter ${slim ? "slim" : ""} ${tone(p.verdict)}" role="progressbar" aria-label="${h(providerLabel(p))} usage${pace === null ? "" : `, pace ${pace}%`}" aria-valuenow="${used}" aria-valuemin="0" aria-valuemax="100"><div class="fill" style="width:${used}%"></div>${pace === null ? "" : `<div class="pace" style="left:${pace}%"></div>`}</div>`;
}
// orca-plugin/src/panel/icons.ts
var mark = `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48"><rect x="4" y="20" width="40" height="8" rx="4" fill="var(--border)"></rect><rect x="4" y="20" width="22" height="8" rx="4" fill="currentColor"></rect><rect class="brand-tick" x="29" y="12" width="4" height="24" rx="2"></rect></svg>`;

// orca-plugin/src/panel/style.ts
var style = `
*{box-sizing:border-box}body{margin:0;background:var(--background);color:var(--foreground);font:12px/1.4 var(--app-font-family,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif);font-variant-numeric:tabular-nums;--good:seagreen;--warn:darkorange;--bad:crimson}
.content{padding:12px;display:flex;flex-direction:column;gap:18px;min-width:0;overflow-wrap:anywhere}.stack{display:flex;flex-direction:column;gap:6px;min-width:0}.row,.name,header{display:flex;align-items:center;gap:8px}header{flex-wrap:wrap}.grow{flex:1;min-width:0}.brand{font-weight:600;font-size:14px}.brand-tick{fill:#65a30d}.pill{font-size:10px;padding:2px 6px;border-radius:6px;background:var(--muted)}.live,small,footer{font-size:11px;color:var(--muted-foreground)}h2{font-size:10px;letter-spacing:.06em;text-transform:uppercase;font-weight:500;margin:0;color:var(--muted-foreground)}.section{gap:8px}.card{border:1px solid var(--border);border-radius:8px;background:var(--card);padding:10px}.headline{font-weight:600}p{margin:0}.good{color:var(--good)}.warn{color:var(--warn)}.bad{color:var(--bad)}.meter{position:relative;height:6px;background:var(--border);border-radius:999px;margin:4px 0}.meter.slim{height:3px}.fill{height:100%;border-radius:999px;background:currentColor}.pace{position:absolute;width:2px;top:-4px;bottom:-4px;background:var(--foreground);border-radius:2px}.step{padding:8px;display:flex;gap:8px}.step.failed{color:var(--bad)}pre{margin:0;padding:10px;background:var(--muted);border-radius:8px;white-space:pre-wrap}code,pre{user-select: text;-webkit-user-select:text}code{font:11px ui-monospace,monospace;overflow-wrap:anywhere}footer{border-top:1px solid var(--border);padding-top:12px}
`;
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
  const { nowS } = view, providers = s.budget?.providers ?? [], planner = providers.find((p) => p.id === s.budget?.planner);
  const reset = (p, weekday = false) => p.resetsAt === null ? "Reset unknown" : `Resets ${absolute(p.resetsAt, nowS, weekday)}`;
  const mode = s.mode?.mode ?? s.budget?.mode ?? "unknown";
  const header = `<header><span class="brand name">${mark}pacer</span><span class="pill">${h(mode.replace(/^./, (c) => c.toUpperCase()))}</span><span class="grow"></span><span class="live">${view.reachable ? "Live · updated" : "Not connected · last data"} ${h(absolute(s.at, nowS))}</span></header>`;
  let content;
  if (view.bootstrap && !s.budget && !view.setup?.complete) {
    const steps = ["install", "start"].map((name) => {
      const step = view.bootstrap[name];
      return `<p><strong>${name}: ${h(step.status)}</strong>${step.detail ? ` · ${h(step.detail)}` : ""}</p>`;
    }).join("");
    content = section("Welcome to pacer", "<p>pacer tracks your AI account budgets and task status. It helps you pace planning and delegate work to available executors.</p>") + section("Install", `<pre><code>${h(MANUAL_INSTALL)}</code></pre><pre><code>pacer init</code></pre>${steps}`) + section("Live panel", "<p>The live panel opens automatically once pacer is installed and the plugin restarts.</p>") + section("Act in pacer", "<p>Run <code>pacer open</code> in a terminal to open the pacer app, where you delegate, review and change settings.</p>");
  } else {
    const accounts = accountGroups(providers).flatMap((group) => {
      const rows = group.account ? [group.rows] : group.rows.map((p) => [p]);
      return rows.map((runners) => {
        const p = runners[0];
        return `<div class="account card stack"><strong>${h(group.account ?? providerLabel(p))}</strong><span>${h(verdictWords(p.verdict))} · ${h(percent(p))}${p.stale ? ' · <span class="pill">stale</span>' : ""}</span>${meter(p, true)}<small>${h(p.window ?? "Window unknown")} · ${h(reset(p))}</small><small>Runners: ${h(runners.map(providerLabel).join(", "))}</small></div>`;
      });
    }).join("");
    const running = s.tasks.filter((t) => t.state === "running" || t.state === "queued").map((t) => `<div class="card stack"><strong>${h(t.goal.slice(0, 100))}</strong><small>${h(t.executor ? displayName2(t.executor) : "Executor pending")} · ${h(t.state)} · started ${h(absolute(t.attemptStartedAt ?? t.updatedAt, nowS))}${t.progress ? ` · ${h(t.progress.phase)}` : ""}</small>${placementLine(t)}</div>`).join("");
    const waiting = s.tasks.filter((t) => !t.review && !t.dismissed && (t.state === "partial" || t.state === "done")).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10).map((t) => `<div class="card stack"><strong>${h(t.goal)}</strong><small>${h(t.executor ? displayName2(t.executor) : "Executor unknown")} · finished ${h(absolute(t.updatedAt, nowS))}</small><small>${h(t.worktree ?? "Worktree unknown")}</small></div>`).join("");
    const alerts = s.alerts.filter((a) => a.level === "warn" || a.level === "error").sort((a, b) => b.at - a.at).slice(0, 5).map((a) => `<div class="card stack"><strong>${h(a.title)}</strong><p>${h(a.body.slice(0, 200))}</p><small>${h(absolute(a.at, nowS))}</small></div>`).join("");
    const versions = `<p>pacer ${h(view.updates?.cli ?? s.console?.version ?? "unknown")} · plugin ${h(view.updates?.plugin ?? "unknown")}</p>${view.updates?.available ? `<p>Update available: ${h(view.updates.latest ?? "unknown")} · <code>pacer update</code></p>` : ""}`;
    content = section("Planner", `<div class="card stack">${planner ? `<div class="row"><strong class="grow">${h(providerLabel(planner))}</strong><span>${h(percent(planner))}</span></div>${meter(planner)}<small>${h(reset(planner, true))}</small>` : "<small>Planner unknown · Reset unknown</small>"}<p class="headline">${h(headline(planner))}</p></div>`) + section("Accounts", accounts || "<small>No accounts reported.</small>") + section("Running", running || "<small>No tasks running.</small>") + section("Waiting for review", `${waiting || "<small>No tasks waiting for review.</small>"}<p>Review with <code>pacer review &lt;id&gt;</code> or in the pacer app.</p>`) + section("Alerts", alerts || "<small>No alerts.</small>") + section("Versions", versions);
  }
  if (view.setup && !view.setup.complete)
    content += section("Setup", `${checklist(view.setup)}<pre><code>pacer init</code></pre>`);
  const footer = "<footer>pacer shows information here. To delegate, review, block executors or change settings, run <code>pacer open</code> in a terminal to open the pacer app.</footer>";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"><title>pacer</title><style>${style}</style></head><body><main class="content">${header}${content}${footer}</main></body></html>`;
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
    const activatedAtS = deps.nowS();
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
    const bridge = bridgeTransport({ host: ctx.host, pollMs: settings.pollSeconds * 1000, timers });
    const transports = [
      apiTransport({ timers, log: (m) => ctx.log(m), connect: async () => {
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
      } }),
      httpTransport({ http: deps.http, readToken: () => deps.fs.readText(`${settings.pacerHome}/token`)?.trim() || null, port: settings.port, timers }),
      channelTransport({ host: ctx.host, registerEvent: (name, handler) => ctx.events.on(name, async (payload) => {
        await ensureConnected();
        if (!stopped)
          handler(payload);
      }) }),
      bridge
    ];
    let active = null, reachable = false, connecting = null;
    let lastSeenAt;
    let processing = Promise.resolve();
    let httpFailures = 0;
    let setup;
    let renderedHtml = null;
    let lastRenderAt = -Infinity;
    let userOutcome = false;
    const panelUpdates = () => {
      if (!deps.version)
        return updates;
      const cached = deps.cachedUpdate?.();
      const latest = cached?.latest ?? updates?.latest ?? null;
      const cli = store.snapshot.console?.version ?? updates?.cli ?? null;
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
          const html = renderStatusPage(store.snapshot, { nowS, transport: store.transport, reachable, setup, bootstrap: deps.bootstrap?.state, updates: panelUpdates() });
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
        const snapshot = store.snapshot;
        processing = processing.then(async () => {
          if (!stopped)
            await notifyNewAlerts(ctx.host, snapshot, settings, activatedAtS, deps.nowS());
        }).catch(logError);
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
    store.onChange(() => scheduleRender());
    timers.every(1000, () => {
      processing = processing.then(async () => {
        if (!stopped)
          await notifyNewAlerts(ctx.host, store.snapshot, settings, activatedAtS, deps.nowS());
      }).catch(logError);
    });
    timers.every(15000, () => {
      scheduleRender();
    });
    const replaceSnapshot = (snapshot) => {
      if (stopped)
        return;
      const previous = store.snapshot;
      const initiated = snapshot.budget?.strategy !== previous.budget?.strategy || snapshot.tasks.some((t) => !previous.tasks.some((p) => p.id === t.id) || t.dismissed !== previous.tasks.find((p) => p.id === t.id)?.dismissed || t.retriedBy !== previous.tasks.find((p) => p.id === t.id)?.retriedBy) || snapshot.alerts.some((a) => a.key === "strategy-build" && !previous.alerts.some((p) => p.key === a.key && p.at === a.at)) || snapshot.budget?.providers.some((p) => p.blockedReason !== previous.budget?.providers.find((x) => x.id === p.id)?.blockedReason);
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
      httpFailures = 0;
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
      reachable = chosen.reachable && active?.id !== "bridge";
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
      const snapshot = await active.snapshot().catch(() => null) ?? await bridge.snapshot();
      if (stopped)
        return;
      if (snapshot)
        replaceSnapshot(snapshot);
      stopWatch = active.watch((e) => {
        if (!stopped) {
          lastSeenAt = deps.nowS();
          store.apply(e);
        }
      }, active.id === "bridge" ? replaceSnapshot : acceptSnapshot, () => {
        handleHttpFailure().catch(logError);
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
    const handleHttpFailure = async () => {
      const failures = ++httpFailures;
      const snapshot = await bridge.snapshot();
      if (snapshot)
        replaceSnapshot(snapshot);
      if (stopped || active?.id !== "http")
        return;
      reachable = false;
      if (lastSeenAt !== undefined)
        timers.after(Math.max(0, (20 - (deps.nowS() - lastSeenAt)) * 1000), scheduleRender);
      if (failures >= 3) {
        stopWatch?.();
        stopWatch = null;
        httpFailures = 0;
        await ensureConnected();
      }
      scheduleRender();
    };
    const refreshSnapshot = async () => {
      try {
        const snapshot = await active?.snapshot().catch(() => null);
        if (snapshot) {
          if (active?.id === "bridge")
            replaceSnapshot(snapshot);
          else
            acceptSnapshot(snapshot);
        } else if (active?.id === "http")
          await handleHttpFailure();
        else {
          const fallback = await bridge.snapshot();
          if (fallback)
            replaceSnapshot(fallback);
        }
      } catch (e) {
        logError(e);
      }
    };
    let probing = false;
    timers.every(settings.pollSeconds * 1000, () => {
      if (stopped || probing || connecting || active?.id === "http" || active?.id === "api")
        return;
      probing = true;
      (async () => {
        if (active?.id === "channel")
          await refreshSnapshot();
        if (stopped || settings.transport !== "auto")
          return;
        const chosen = await chooseTransport(transports, settings.transport);
        if (stopped || chosen.transport?.id === active?.id)
          return;
        stopWatch?.();
        stopWatch = null;
        await ensureConnected();
      })().catch(logError).finally(() => {
        probing = false;
      });
    });
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
var pluginRoot = dirname(fileURLToPath3(import.meta.url));
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
var plugin = createPlugin({
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
      if (pluginMode(pluginRoot, { exists: existsSync3 }) !== "live" || resolve(path) !== resolve(pluginRoot, "panel", "live.html")) {
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
