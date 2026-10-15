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
  version: "0.1.24",
  bin: {
    pacer: "src/cli.ts"
  },
  scripts: {
    test: "TZ=Asia/Ho_Chi_Minh bun test",
    typecheck: "tsc --noEmit",
    build: "bun build --compile src/cli.ts --outfile dist/pacer",
    release: "bun scripts/release/build.ts",
    "release:prepare": "bun scripts/release/prepare.ts",
    "release:host": "bun scripts/release/build.ts --host",
    "plugin:build": "bun orca-plugin/build.ts",
    "release:npm": "bun scripts/release/npm.ts",
    "release:homebrew": "bun scripts/release/homebrew.ts",
    "brand:render": "bun scripts/brand/render.ts"
  },
  dependencies: {
    "@modelcontextprotocol/sdk": "1.32.1",
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
var setupKey = (s) => JSON.stringify(s.items);

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
import { dirname, join as join8, resolve } from "node:path";
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
import { join as join7 } from "node:path";

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
function liveConsole(s, nowS) {
  const c = s.console;
  return c && c.handle && nowS - c.heartbeatAt <= LIMITS.heartbeatS ? c : null;
}
var CMD_PREFIX = ": pacer '";
function encodeCmdLine(data) {
  const json = JSON.stringify({ v: 1, type: "cmd", data }).replace(/'/g, "\\u0027"), line = `${CMD_PREFIX}${json}'`;
  if (line.length > LIMITS.cmdLine)
    throw new Error(`pacer command line exceeds ${LIMITS.cmdLine} characters`);
  return line;
}
function summaryLine(b) {
  if (!b)
    return "pacer: no budget data yet";
  const p = b.providers.find((x) => x.id === b.planner), pct = p?.usedPct == null ? "?" : `${Math.round(p.usedPct)}%`;
  return clip(`pacer ${b.mode} | ${b.planner} ${pct} ${p?.verdict ?? "UNKNOWN"} | next: ${b.ranked[0]?.id ?? "none"}`, LIMITS.title);
}

// orca-plugin/src/settings.ts
function readSettings(raw, home) {
  const finite = (v) => typeof v === "number" && Number.isFinite(v);
  return {
    notifications: ["off", "important", "all"].includes(String(raw.notifications)) ? raw.notifications : "important",
    autoConsole: typeof raw.autoConsole === "boolean" ? raw.autoConsole : true,
    transport: ["auto", "http", "channel", "bridge"].includes(raw.transport) ? raw.transport : "auto",
    port: finite(raw.port) && Number.isInteger(raw.port) && raw.port >= 1 && raw.port <= 65535 ? raw.port : 4317,
    pacerHome: typeof raw.pacerHome === "string" && raw.pacerHome.length > 0 ? raw.pacerHome : `${home}/.pacer`,
    pollSeconds: finite(raw.pollSeconds) ? Math.max(5, Math.min(300, raw.pollSeconds)) : 10,
    ...Array.isArray(raw.deliveredAlerts) ? { deliveredAlerts: raw.deliveredAlerts.filter((a) => !!a && typeof a === "object" && typeof a.key === "string" && finite(a.at)).slice(-200) } : {},
    lastAlertAt: finite(raw.lastAlertAt) && raw.lastAlertAt >= 0 ? raw.lastAlertAt : 0
  };
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
var TRANSPORT_ORDER = ["http", "channel", "bridge"];
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

// orca-plugin/src/console-link.ts
async function focusedConsole(host, s, nowS) {
  try {
    const context = await host.call("workspace.readContext");
    const ids = new Set(context?.terminals.map((t) => t.id) ?? []);
    return [...s.consoles ?? [], ...s.console ? [s.console] : []].filter((c) => c.handle && ids.has(c.handle) && nowS - c.heartbeatAt <= 30).sort((a, b) => b.heartbeatAt - a.heartbeatAt)[0] ?? null;
  } catch {
    return null;
  }
}
var queues = new WeakMap;
async function sendToConsole(host, s, data, nowS) {
  const console2 = await focusedConsole(host, s, nowS);
  if (!console2)
    return "no-console";
  let byTerminal = queues.get(host);
  if (!byTerminal) {
    byTerminal = new Map;
    queues.set(host, byTerminal);
  }
  const key = console2.handle, queue = byTerminal.get(key) ?? { tail: Promise.resolve(), at: -Infinity };
  byTerminal.set(key, queue);
  const send = queue.tail.catch(() => {}).then(async () => {
    const delay = Math.max(0, 1000 - (Date.now() - queue.at), Math.min(1000, ((console2.busyUntil ?? nowS) - nowS) * 1000));
    if (delay)
      await new Promise((r) => setTimeout(r, delay));
    try {
      return (await host.call("terminal.sendText", { terminalId: key, text: encodeCmdLine(data), enter: true })).accepted ? "sent" : "rejected";
    } catch {
      return "rejected";
    } finally {
      queue.at = Date.now();
    }
  });
  queue.tail = send;
  return send;
}
var NO_CONSOLE = { title: "No console in this worktree", body: "Type `pacer console` into a terminal in this worktree and press Enter, then retry." };

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

// node_modules/yaml/browser/dist/nodes/identity.js
var ALIAS = Symbol.for("yaml.alias");
var DOC = Symbol.for("yaml.document");
var MAP = Symbol.for("yaml.map");
var PAIR = Symbol.for("yaml.pair");
var SCALAR = Symbol.for("yaml.scalar");
var SEQ = Symbol.for("yaml.seq");
var NODE_TYPE = Symbol.for("yaml.node.type");
var isAlias = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS;
var isDocument = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC;
var isMap = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP;
var isPair = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR;
var isScalar = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR;
var isSeq = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ;
function isCollection(node) {
  if (node && typeof node === "object")
    switch (node[NODE_TYPE]) {
      case MAP:
      case SEQ:
        return true;
    }
  return false;
}
function isNode(node) {
  if (node && typeof node === "object")
    switch (node[NODE_TYPE]) {
      case ALIAS:
      case MAP:
      case SCALAR:
      case SEQ:
        return true;
    }
  return false;
}
var hasAnchor = (node) => (isScalar(node) || isCollection(node)) && !!node.anchor;

// node_modules/yaml/browser/dist/visit.js
var BREAK = Symbol("break visit");
var SKIP = Symbol("skip children");
var REMOVE = Symbol("remove node");
function visit(node, visitor) {
  const visitor_ = initVisitor(visitor);
  if (isDocument(node)) {
    const cd = visit_(null, node.contents, visitor_, Object.freeze([node]));
    if (cd === REMOVE)
      node.contents = null;
  } else
    visit_(null, node, visitor_, Object.freeze([]));
}
visit.BREAK = BREAK;
visit.SKIP = SKIP;
visit.REMOVE = REMOVE;
function visit_(key, node, visitor, path) {
  const ctrl = callVisitor(key, node, visitor, path);
  if (isNode(ctrl) || isPair(ctrl)) {
    replaceNode(key, path, ctrl);
    return visit_(key, ctrl, visitor, path);
  }
  if (typeof ctrl !== "symbol") {
    if (isCollection(node)) {
      path = Object.freeze(path.concat(node));
      for (let i = 0;i < node.items.length; ++i) {
        const ci = visit_(i, node.items[i], visitor, path);
        if (typeof ci === "number")
          i = ci - 1;
        else if (ci === BREAK)
          return BREAK;
        else if (ci === REMOVE) {
          node.items.splice(i, 1);
          i -= 1;
        }
      }
    } else if (isPair(node)) {
      path = Object.freeze(path.concat(node));
      const ck = visit_("key", node.key, visitor, path);
      if (ck === BREAK)
        return BREAK;
      else if (ck === REMOVE)
        node.key = null;
      const cv = visit_("value", node.value, visitor, path);
      if (cv === BREAK)
        return BREAK;
      else if (cv === REMOVE)
        node.value = null;
    }
  }
  return ctrl;
}
async function visitAsync(node, visitor) {
  const visitor_ = initVisitor(visitor);
  if (isDocument(node)) {
    const cd = await visitAsync_(null, node.contents, visitor_, Object.freeze([node]));
    if (cd === REMOVE)
      node.contents = null;
  } else
    await visitAsync_(null, node, visitor_, Object.freeze([]));
}
visitAsync.BREAK = BREAK;
visitAsync.SKIP = SKIP;
visitAsync.REMOVE = REMOVE;
async function visitAsync_(key, node, visitor, path) {
  const ctrl = await callVisitor(key, node, visitor, path);
  if (isNode(ctrl) || isPair(ctrl)) {
    replaceNode(key, path, ctrl);
    return visitAsync_(key, ctrl, visitor, path);
  }
  if (typeof ctrl !== "symbol") {
    if (isCollection(node)) {
      path = Object.freeze(path.concat(node));
      for (let i = 0;i < node.items.length; ++i) {
        const ci = await visitAsync_(i, node.items[i], visitor, path);
        if (typeof ci === "number")
          i = ci - 1;
        else if (ci === BREAK)
          return BREAK;
        else if (ci === REMOVE) {
          node.items.splice(i, 1);
          i -= 1;
        }
      }
    } else if (isPair(node)) {
      path = Object.freeze(path.concat(node));
      const ck = await visitAsync_("key", node.key, visitor, path);
      if (ck === BREAK)
        return BREAK;
      else if (ck === REMOVE)
        node.key = null;
      const cv = await visitAsync_("value", node.value, visitor, path);
      if (cv === BREAK)
        return BREAK;
      else if (cv === REMOVE)
        node.value = null;
    }
  }
  return ctrl;
}
function initVisitor(visitor) {
  if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) {
    return Object.assign({
      Alias: visitor.Node,
      Map: visitor.Node,
      Scalar: visitor.Node,
      Seq: visitor.Node
    }, visitor.Value && {
      Map: visitor.Value,
      Scalar: visitor.Value,
      Seq: visitor.Value
    }, visitor.Collection && {
      Map: visitor.Collection,
      Seq: visitor.Collection
    }, visitor);
  }
  return visitor;
}
function callVisitor(key, node, visitor, path) {
  if (typeof visitor === "function")
    return visitor(key, node, path);
  if (isMap(node))
    return visitor.Map?.(key, node, path);
  if (isSeq(node))
    return visitor.Seq?.(key, node, path);
  if (isPair(node))
    return visitor.Pair?.(key, node, path);
  if (isScalar(node))
    return visitor.Scalar?.(key, node, path);
  if (isAlias(node))
    return visitor.Alias?.(key, node, path);
  return;
}
function replaceNode(key, path, node) {
  const parent = path[path.length - 1];
  if (isCollection(parent)) {
    parent.items[key] = node;
  } else if (isPair(parent)) {
    if (key === "key")
      parent.key = node;
    else
      parent.value = node;
  } else if (isDocument(parent)) {
    parent.contents = node;
  } else {
    const pt = isAlias(parent) ? "alias" : "scalar";
    throw new Error(`Cannot replace node with ${pt} parent`);
  }
}

// node_modules/yaml/browser/dist/doc/directives.js
var escapeChars = {
  "!": "%21",
  ",": "%2C",
  "[": "%5B",
  "]": "%5D",
  "{": "%7B",
  "}": "%7D"
};
var escapeTagName = (tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]);

class Directives {
  constructor(yaml, tags) {
    this.docStart = null;
    this.docEnd = false;
    this.yaml = Object.assign({}, Directives.defaultYaml, yaml);
    this.tags = Object.assign({}, Directives.defaultTags, tags);
  }
  clone() {
    const copy = new Directives(this.yaml, this.tags);
    copy.docStart = this.docStart;
    return copy;
  }
  atDocument() {
    const res = new Directives(this.yaml, this.tags);
    switch (this.yaml.version) {
      case "1.1":
        this.atNextDocument = true;
        break;
      case "1.2":
        this.atNextDocument = false;
        this.yaml = {
          explicit: Directives.defaultYaml.explicit,
          version: "1.2"
        };
        this.tags = Object.assign({}, Directives.defaultTags);
        break;
    }
    return res;
  }
  add(line, onError) {
    if (this.atNextDocument) {
      this.yaml = { explicit: Directives.defaultYaml.explicit, version: "1.1" };
      this.tags = Object.assign({}, Directives.defaultTags);
      this.atNextDocument = false;
    }
    const parts = line.trim().split(/[ \t]+/);
    const name = parts.shift();
    switch (name) {
      case "%TAG": {
        if (parts.length !== 2) {
          onError(0, "%TAG directive should contain exactly two parts");
          if (parts.length < 2)
            return false;
        }
        const [handle, prefix] = parts;
        this.tags[handle] = prefix;
        return true;
      }
      case "%YAML": {
        this.yaml.explicit = true;
        if (parts.length !== 1) {
          onError(0, "%YAML directive should contain exactly one part");
          return false;
        }
        const [version] = parts;
        if (version === "1.1" || version === "1.2") {
          this.yaml.version = version;
          return true;
        } else {
          const isValid = /^\d+\.\d+$/.test(version);
          onError(6, `Unsupported YAML version ${version}`, isValid);
          return false;
        }
      }
      default:
        onError(0, `Unknown directive ${name}`, true);
        return false;
    }
  }
  tagName(source, onError) {
    if (source === "!")
      return "!";
    if (source[0] !== "!") {
      onError(`Not a valid tag: ${source}`);
      return null;
    }
    if (source[1] === "<") {
      const verbatim = source.slice(2, -1);
      if (verbatim === "!" || verbatim === "!!") {
        onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
        return null;
      }
      if (source[source.length - 1] !== ">")
        onError("Verbatim tags must end with a >");
      return verbatim;
    }
    const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
    if (!suffix)
      onError(`The ${source} tag has no suffix`);
    const prefix = this.tags[handle];
    if (prefix) {
      try {
        return prefix + decodeURIComponent(suffix);
      } catch (error) {
        onError(String(error));
        return null;
      }
    }
    if (handle === "!")
      return source;
    onError(`Could not resolve tag: ${source}`);
    return null;
  }
  tagString(tag) {
    for (const [handle, prefix] of Object.entries(this.tags)) {
      if (tag.startsWith(prefix))
        return handle + escapeTagName(tag.substring(prefix.length));
    }
    return tag[0] === "!" ? tag : `!<${tag}>`;
  }
  toString(doc) {
    const lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
    const tagEntries = Object.entries(this.tags);
    let tagNames;
    if (doc && tagEntries.length > 0 && isNode(doc.contents)) {
      const tags = {};
      visit(doc.contents, (_key, node) => {
        if (isNode(node) && node.tag)
          tags[node.tag] = true;
      });
      tagNames = Object.keys(tags);
    } else
      tagNames = [];
    for (const [handle, prefix] of tagEntries) {
      if (handle === "!!" && prefix === "tag:yaml.org,2002:")
        continue;
      if (!doc || tagNames.some((tn) => tn.startsWith(prefix)))
        lines.push(`%TAG ${handle} ${prefix}`);
    }
    return lines.join(`
`);
  }
}
Directives.defaultYaml = { explicit: false, version: "1.2" };
Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };

// node_modules/yaml/browser/dist/doc/anchors.js
function anchorIsValid(anchor) {
  if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
    const sa = JSON.stringify(anchor);
    const msg = `Anchor must not contain whitespace or control characters: ${sa}`;
    throw new Error(msg);
  }
  return true;
}
function anchorNames(root) {
  const anchors = new Set;
  visit(root, {
    Value(_key, node) {
      if (node.anchor)
        anchors.add(node.anchor);
    }
  });
  return anchors;
}
function findNewAnchor(prefix, exclude) {
  for (let i = 1;; ++i) {
    const name = `${prefix}${i}`;
    if (!exclude.has(name))
      return name;
  }
}
function createNodeAnchors(doc, prefix) {
  const aliasObjects = [];
  const sourceObjects = new Map;
  let prevAnchors = null;
  return {
    onAnchor: (source) => {
      aliasObjects.push(source);
      prevAnchors ?? (prevAnchors = anchorNames(doc));
      const anchor = findNewAnchor(prefix, prevAnchors);
      prevAnchors.add(anchor);
      return anchor;
    },
    setAnchors: () => {
      for (const source of aliasObjects) {
        const ref = sourceObjects.get(source);
        if (typeof ref === "object" && ref.anchor && (isScalar(ref.node) || isCollection(ref.node))) {
          ref.node.anchor = ref.anchor;
        } else {
          const error = new Error("Failed to resolve repeated object (this should not happen)");
          error.source = source;
          throw error;
        }
      }
    },
    sourceObjects
  };
}

// node_modules/yaml/browser/dist/doc/applyReviver.js
function applyReviver(reviver, obj, key, val) {
  if (val && typeof val === "object") {
    if (Array.isArray(val)) {
      for (let i = 0, len = val.length;i < len; ++i) {
        const v0 = val[i];
        const v1 = applyReviver(reviver, val, String(i), v0);
        if (v1 === undefined)
          delete val[i];
        else if (v1 !== v0)
          val[i] = v1;
      }
    } else if (val instanceof Map) {
      for (const k of Array.from(val.keys())) {
        const v0 = val.get(k);
        const v1 = applyReviver(reviver, val, k, v0);
        if (v1 === undefined)
          val.delete(k);
        else if (v1 !== v0)
          val.set(k, v1);
      }
    } else if (val instanceof Set) {
      for (const v0 of Array.from(val)) {
        const v1 = applyReviver(reviver, val, v0, v0);
        if (v1 === undefined)
          val.delete(v0);
        else if (v1 !== v0) {
          val.delete(v0);
          val.add(v1);
        }
      }
    } else {
      for (const [k, v0] of Object.entries(val)) {
        const v1 = applyReviver(reviver, val, k, v0);
        if (v1 === undefined)
          delete val[k];
        else if (v1 !== v0)
          val[k] = v1;
      }
    }
  }
  return reviver.call(obj, key, val);
}

// node_modules/yaml/browser/dist/nodes/toJS.js
function toJS(value, arg, ctx) {
  if (Array.isArray(value))
    return value.map((v, i) => toJS(v, String(i), ctx));
  if (value && typeof value.toJSON === "function") {
    if (!ctx || !hasAnchor(value))
      return value.toJSON(arg, ctx);
    const data = { aliasCount: 0, count: 1, res: undefined };
    ctx.anchors.set(value, data);
    ctx.onCreate = (res) => {
      data.res = res;
      delete ctx.onCreate;
    };
    const res = value.toJSON(arg, ctx);
    if (ctx.onCreate)
      ctx.onCreate(res);
    return res;
  }
  if (typeof value === "bigint" && !ctx?.keep)
    return Number(value);
  return value;
}

// node_modules/yaml/browser/dist/nodes/Node.js
class NodeBase {
  constructor(type) {
    Object.defineProperty(this, NODE_TYPE, { value: type });
  }
  clone() {
    const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
    if (this.range)
      copy.range = this.range.slice();
    return copy;
  }
  toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
    if (!isDocument(doc))
      throw new TypeError("A document argument is required");
    const ctx = {
      anchors: new Map,
      doc,
      keep: true,
      mapAsMap: mapAsMap === true,
      mapKeyWarned: false,
      maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
    };
    const res = toJS(this, "", ctx);
    if (typeof onAnchor === "function")
      for (const { count, res } of ctx.anchors.values())
        onAnchor(res, count);
    return typeof reviver === "function" ? applyReviver(reviver, { "": res }, "", res) : res;
  }
}

// node_modules/yaml/browser/dist/nodes/Alias.js
class Alias extends NodeBase {
  constructor(source) {
    super(ALIAS);
    this.source = source;
    Object.defineProperty(this, "tag", {
      set() {
        throw new Error("Alias nodes cannot have tags");
      }
    });
  }
  resolve(doc, ctx) {
    let nodes;
    if (ctx?.aliasResolveCache) {
      nodes = ctx.aliasResolveCache;
    } else {
      nodes = [];
      visit(doc, {
        Node: (_key, node) => {
          if (isAlias(node) || hasAnchor(node))
            nodes.push(node);
        }
      });
      if (ctx)
        ctx.aliasResolveCache = nodes;
    }
    let found = undefined;
    for (const node of nodes) {
      if (node === this)
        break;
      if (node.anchor === this.source)
        found = node;
    }
    return found;
  }
  toJSON(_arg, ctx) {
    if (!ctx)
      return { source: this.source };
    const { anchors, doc, maxAliasCount } = ctx;
    const source = this.resolve(doc, ctx);
    if (!source) {
      const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
      throw new ReferenceError(msg);
    }
    let data = anchors.get(source);
    if (!data) {
      toJS(source, null, ctx);
      data = anchors.get(source);
    }
    if (data?.res === undefined) {
      const msg = "This should not happen: Alias anchor was not resolved?";
      throw new ReferenceError(msg);
    }
    if (maxAliasCount >= 0) {
      data.count += 1;
      if (data.aliasCount === 0)
        data.aliasCount = getAliasCount(doc, source, anchors);
      if (data.count * data.aliasCount > maxAliasCount) {
        const msg = "Excessive alias count indicates a resource exhaustion attack";
        throw new ReferenceError(msg);
      }
    }
    return data.res;
  }
  toString(ctx, _onComment, _onChompKeep) {
    const src = `*${this.source}`;
    if (ctx) {
      anchorIsValid(this.source);
      if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
        const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
        throw new Error(msg);
      }
      if (ctx.implicitKey)
        return `${src} `;
    }
    return src;
  }
}
function getAliasCount(doc, node, anchors) {
  if (isAlias(node)) {
    const source = node.resolve(doc);
    const anchor = anchors && source && anchors.get(source);
    return anchor ? anchor.count * anchor.aliasCount : 0;
  } else if (isCollection(node)) {
    let count = 0;
    for (const item of node.items) {
      const c = getAliasCount(doc, item, anchors);
      if (c > count)
        count = c;
    }
    return count;
  } else if (isPair(node)) {
    const kc = getAliasCount(doc, node.key, anchors);
    const vc = getAliasCount(doc, node.value, anchors);
    return Math.max(kc, vc);
  }
  return 1;
}

// node_modules/yaml/browser/dist/nodes/Scalar.js
var isScalarValue = (value) => !value || typeof value !== "function" && typeof value !== "object";

class Scalar extends NodeBase {
  constructor(value) {
    super(SCALAR);
    this.value = value;
  }
  toJSON(arg, ctx) {
    return ctx?.keep ? this.value : toJS(this.value, arg, ctx);
  }
  toString() {
    return String(this.value);
  }
}
Scalar.BLOCK_FOLDED = "BLOCK_FOLDED";
Scalar.BLOCK_LITERAL = "BLOCK_LITERAL";
Scalar.PLAIN = "PLAIN";
Scalar.QUOTE_DOUBLE = "QUOTE_DOUBLE";
Scalar.QUOTE_SINGLE = "QUOTE_SINGLE";

// node_modules/yaml/browser/dist/doc/createNode.js
var defaultTagPrefix = "tag:yaml.org,2002:";
function findTagObject(value, tagName, tags) {
  if (tagName) {
    const match = tags.filter((t) => t.tag === tagName);
    const tagObj = match.find((t) => !t.format) ?? match[0];
    if (!tagObj)
      throw new Error(`Tag ${tagName} not found`);
    return tagObj;
  }
  return tags.find((t) => t.identify?.(value) && !t.format);
}
function createNode(value, tagName, ctx) {
  if (isDocument(value))
    value = value.contents;
  if (isNode(value))
    return value;
  if (isPair(value)) {
    const map = ctx.schema[MAP].createNode?.(ctx.schema, null, ctx);
    map.items.push(value);
    return map;
  }
  if (value instanceof String || value instanceof Number || value instanceof Boolean || typeof BigInt !== "undefined" && value instanceof BigInt) {
    value = value.valueOf();
  }
  const { aliasDuplicateObjects, onAnchor, onTagObj, schema, sourceObjects } = ctx;
  let ref = undefined;
  if (aliasDuplicateObjects && value && typeof value === "object") {
    ref = sourceObjects.get(value);
    if (ref) {
      ref.anchor ?? (ref.anchor = onAnchor(value));
      return new Alias(ref.anchor);
    } else {
      ref = { anchor: null, node: null };
      sourceObjects.set(value, ref);
    }
  }
  if (tagName?.startsWith("!!"))
    tagName = defaultTagPrefix + tagName.slice(2);
  let tagObj = findTagObject(value, tagName, schema.tags);
  if (!tagObj) {
    if (value && typeof value.toJSON === "function") {
      value = value.toJSON();
    }
    if (!value || typeof value !== "object") {
      const node = new Scalar(value);
      if (ref)
        ref.node = node;
      return node;
    }
    tagObj = value instanceof Map ? schema[MAP] : (Symbol.iterator in Object(value)) ? schema[SEQ] : schema[MAP];
  }
  if (onTagObj) {
    onTagObj(tagObj);
    delete ctx.onTagObj;
  }
  const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar(value);
  if (tagName)
    node.tag = tagName;
  else if (!tagObj.default)
    node.tag = tagObj.tag;
  if (ref)
    ref.node = node;
  return node;
}

// node_modules/yaml/browser/dist/nodes/Collection.js
function collectionFromPath(schema, path, value) {
  let v = value;
  for (let i = path.length - 1;i >= 0; --i) {
    const k = path[i];
    if (typeof k === "number" && Number.isInteger(k) && k >= 0) {
      const a = [];
      a[k] = v;
      v = a;
    } else {
      v = new Map([[k, v]]);
    }
  }
  return createNode(v, undefined, {
    aliasDuplicateObjects: false,
    keepUndefined: false,
    onAnchor: () => {
      throw new Error("This should not happen, please report a bug.");
    },
    schema,
    sourceObjects: new Map
  });
}
var isEmptyPath = (path) => path == null || typeof path === "object" && !!path[Symbol.iterator]().next().done;

class Collection extends NodeBase {
  constructor(type, schema) {
    super(type);
    Object.defineProperty(this, "schema", {
      value: schema,
      configurable: true,
      enumerable: false,
      writable: true
    });
  }
  clone(schema) {
    const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
    if (schema)
      copy.schema = schema;
    copy.items = copy.items.map((it) => isNode(it) || isPair(it) ? it.clone(schema) : it);
    if (this.range)
      copy.range = this.range.slice();
    return copy;
  }
  addIn(path, value) {
    if (isEmptyPath(path))
      this.add(value);
    else {
      const [key, ...rest] = path;
      const node = this.get(key, true);
      if (isCollection(node))
        node.addIn(rest, value);
      else if (node === undefined && this.schema)
        this.set(key, collectionFromPath(this.schema, rest, value));
      else
        throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
    }
  }
  deleteIn(path) {
    const [key, ...rest] = path;
    if (rest.length === 0)
      return this.delete(key);
    const node = this.get(key, true);
    if (isCollection(node))
      return node.deleteIn(rest);
    else
      throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
  }
  getIn(path, keepScalar) {
    const [key, ...rest] = path;
    const node = this.get(key, true);
    if (rest.length === 0)
      return !keepScalar && isScalar(node) ? node.value : node;
    else
      return isCollection(node) ? node.getIn(rest, keepScalar) : undefined;
  }
  hasAllNullValues(allowScalar) {
    return this.items.every((node) => {
      if (!isPair(node))
        return false;
      const n = node.value;
      return n == null || allowScalar && isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
    });
  }
  hasIn(path) {
    const [key, ...rest] = path;
    if (rest.length === 0)
      return this.has(key);
    const node = this.get(key, true);
    return isCollection(node) ? node.hasIn(rest) : false;
  }
  setIn(path, value) {
    const [key, ...rest] = path;
    if (rest.length === 0) {
      this.set(key, value);
    } else {
      const node = this.get(key, true);
      if (isCollection(node))
        node.setIn(rest, value);
      else if (node === undefined && this.schema)
        this.set(key, collectionFromPath(this.schema, rest, value));
      else
        throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
    }
  }
}

// node_modules/yaml/browser/dist/stringify/stringifyComment.js
var stringifyComment = (str) => str.replace(/^(?!$)(?: $)?/gm, "#");
function indentComment(comment, indent) {
  if (/^\n+$/.test(comment))
    return comment.substring(1);
  return indent ? comment.replace(/^(?! *$)/gm, indent) : comment;
}
var lineComment = (str, indent, comment) => str.endsWith(`
`) ? indentComment(comment, indent) : comment.includes(`
`) ? `
` + indentComment(comment, indent) : (str.endsWith(" ") ? "" : " ") + comment;

// node_modules/yaml/browser/dist/stringify/foldFlowLines.js
var FOLD_FLOW = "flow";
var FOLD_BLOCK = "block";
var FOLD_QUOTED = "quoted";
function foldFlowLines(text, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
  if (!lineWidth || lineWidth < 0)
    return text;
  if (lineWidth < minContentWidth)
    minContentWidth = 0;
  const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
  if (text.length <= endStep)
    return text;
  const folds = [];
  const escapedFolds = {};
  let end = lineWidth - indent.length;
  if (typeof indentAtStart === "number") {
    if (indentAtStart > lineWidth - Math.max(2, minContentWidth))
      folds.push(0);
    else
      end = lineWidth - indentAtStart;
  }
  let split = undefined;
  let prev = undefined;
  let overflow = false;
  let i = -1;
  let escStart = -1;
  let escEnd = -1;
  if (mode === FOLD_BLOCK) {
    i = consumeMoreIndentedLines(text, i, indent.length);
    if (i !== -1)
      end = i + endStep;
  }
  for (let ch;ch = text[i += 1]; ) {
    if (mode === FOLD_QUOTED && ch === "\\") {
      escStart = i;
      switch (text[i + 1]) {
        case "x":
          i += 3;
          break;
        case "u":
          i += 5;
          break;
        case "U":
          i += 9;
          break;
        default:
          i += 1;
      }
      escEnd = i;
    }
    if (ch === `
`) {
      if (mode === FOLD_BLOCK)
        i = consumeMoreIndentedLines(text, i, indent.length);
      end = i + indent.length + endStep;
      split = undefined;
    } else {
      if (ch === " " && prev && prev !== " " && prev !== `
` && prev !== "\t") {
        const next = text[i + 1];
        if (next && next !== " " && next !== `
` && next !== "\t")
          split = i;
      }
      if (i >= end) {
        if (split) {
          folds.push(split);
          end = split + endStep;
          split = undefined;
        } else if (mode === FOLD_QUOTED) {
          while (prev === " " || prev === "\t") {
            prev = ch;
            ch = text[i += 1];
            overflow = true;
          }
          const j = i > escEnd + 1 ? i - 2 : escStart - 1;
          if (escapedFolds[j])
            return text;
          folds.push(j);
          escapedFolds[j] = true;
          end = j + endStep;
          split = undefined;
        } else {
          overflow = true;
        }
      }
    }
    prev = ch;
  }
  if (overflow && onOverflow)
    onOverflow();
  if (folds.length === 0)
    return text;
  if (onFold)
    onFold();
  let res = text.slice(0, folds[0]);
  for (let i = 0;i < folds.length; ++i) {
    const fold = folds[i];
    const end = folds[i + 1] || text.length;
    if (fold === 0)
      res = `
${indent}${text.slice(0, end)}`;
    else {
      if (mode === FOLD_QUOTED && escapedFolds[fold])
        res += `${text[fold]}\\`;
      res += `
${indent}${text.slice(fold + 1, end)}`;
    }
  }
  return res;
}
function consumeMoreIndentedLines(text, i, indent) {
  let end = i;
  let start = i + 1;
  let ch = text[start];
  while (ch === " " || ch === "\t") {
    if (i < start + indent) {
      ch = text[++i];
    } else {
      do {
        ch = text[++i];
      } while (ch && ch !== `
`);
      end = i;
      start = i + 1;
      ch = text[start];
    }
  }
  return end;
}

// node_modules/yaml/browser/dist/stringify/stringifyString.js
var getFoldOptions = (ctx, isBlock) => ({
  indentAtStart: isBlock ? ctx.indent.length : ctx.indentAtStart,
  lineWidth: ctx.options.lineWidth,
  minContentWidth: ctx.options.minContentWidth
});
var containsDocumentMarker = (str) => /^(%|---|\.\.\.)/m.test(str);
function lineLengthOverLimit(str, lineWidth, indentLength) {
  if (!lineWidth || lineWidth < 0)
    return false;
  const limit = lineWidth - indentLength;
  const strLen = str.length;
  if (strLen <= limit)
    return false;
  for (let i = 0, start = 0;i < strLen; ++i) {
    if (str[i] === `
`) {
      if (i - start > limit)
        return true;
      start = i + 1;
      if (strLen - start <= limit)
        return false;
    }
  }
  return true;
}
function doubleQuotedString(value, ctx) {
  const json = JSON.stringify(value);
  if (ctx.options.doubleQuotedAsJSON)
    return json;
  const { implicitKey } = ctx;
  const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
  const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
  let str = "";
  let start = 0;
  for (let i = 0, ch = json[i];ch; ch = json[++i]) {
    if (ch === " " && json[i + 1] === "\\" && json[i + 2] === "n") {
      str += json.slice(start, i) + "\\ ";
      i += 1;
      start = i;
      ch = "\\";
    }
    if (ch === "\\")
      switch (json[i + 1]) {
        case "u":
          {
            str += json.slice(start, i);
            const code = json.substr(i + 2, 4);
            switch (code) {
              case "0000":
                str += "\\0";
                break;
              case "0007":
                str += "\\a";
                break;
              case "000b":
                str += "\\v";
                break;
              case "001b":
                str += "\\e";
                break;
              case "0085":
                str += "\\N";
                break;
              case "00a0":
                str += "\\_";
                break;
              case "2028":
                str += "\\L";
                break;
              case "2029":
                str += "\\P";
                break;
              default:
                if (code.substr(0, 2) === "00")
                  str += "\\x" + code.substr(2);
                else
                  str += json.substr(i, 6);
            }
            i += 5;
            start = i + 1;
          }
          break;
        case "n":
          if (implicitKey || json[i + 2] === '"' || json.length < minMultiLineLength) {
            i += 1;
          } else {
            str += json.slice(start, i) + `

`;
            while (json[i + 2] === "\\" && json[i + 3] === "n" && json[i + 4] !== '"') {
              str += `
`;
              i += 2;
            }
            str += indent;
            if (json[i + 2] === " ")
              str += "\\";
            i += 1;
            start = i + 1;
          }
          break;
        default:
          i += 1;
      }
  }
  str = start ? str + json.slice(start) : json;
  return implicitKey ? str : foldFlowLines(str, indent, FOLD_QUOTED, getFoldOptions(ctx, false));
}
function singleQuotedString(value, ctx) {
  if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes(`
`) || /[ \t]\n|\n[ \t]/.test(value))
    return doubleQuotedString(value, ctx);
  const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
  const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&
${indent}`) + "'";
  return ctx.implicitKey ? res : foldFlowLines(res, indent, FOLD_FLOW, getFoldOptions(ctx, false));
}
function quotedString(value, ctx) {
  const { singleQuote } = ctx.options;
  let qs;
  if (singleQuote === false)
    qs = doubleQuotedString;
  else {
    const hasDouble = value.includes('"');
    const hasSingle = value.includes("'");
    if (hasDouble && !hasSingle)
      qs = singleQuotedString;
    else if (hasSingle && !hasDouble)
      qs = doubleQuotedString;
    else
      qs = singleQuote ? singleQuotedString : doubleQuotedString;
  }
  return qs(value, ctx);
}
var blockEndNewlines;
try {
  blockEndNewlines = new RegExp(`(^|(?<!
))
+(?!
|$)`, "g");
} catch {
  blockEndNewlines = /\n+(?!\n|$)/g;
}
function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
  const { blockQuote, commentString, lineWidth } = ctx.options;
  if (!blockQuote || /\n[\t ]+$/.test(value)) {
    return quotedString(value, ctx);
  }
  const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
  const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar.BLOCK_FOLDED ? false : type === Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent.length);
  if (!value)
    return literal ? `|
` : `>
`;
  let chomp;
  let endStart;
  for (endStart = value.length;endStart > 0; --endStart) {
    const ch = value[endStart - 1];
    if (ch !== `
` && ch !== "\t" && ch !== " ")
      break;
  }
  let end = value.substring(endStart);
  const endNlPos = end.indexOf(`
`);
  if (endNlPos === -1) {
    chomp = "-";
  } else if (value === end || endNlPos !== end.length - 1) {
    chomp = "+";
    if (onChompKeep)
      onChompKeep();
  } else {
    chomp = "";
  }
  if (end) {
    value = value.slice(0, -end.length);
    if (end[end.length - 1] === `
`)
      end = end.slice(0, -1);
    end = end.replace(blockEndNewlines, `$&${indent}`);
  }
  let startWithSpace = false;
  let startEnd;
  let startNlPos = -1;
  for (startEnd = 0;startEnd < value.length; ++startEnd) {
    const ch = value[startEnd];
    if (ch === " ")
      startWithSpace = true;
    else if (ch === `
`)
      startNlPos = startEnd;
    else
      break;
  }
  let start = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
  if (start) {
    value = value.substring(start.length);
    start = start.replace(/\n+/g, `$&${indent}`);
  }
  const indentSize = indent ? "2" : "1";
  let header = (startWithSpace ? indentSize : "") + chomp;
  if (comment) {
    header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
    if (onComment)
      onComment();
  }
  if (!literal) {
    const foldedValue = value.replace(/\n+/g, `
$&`).replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent}`);
    let literalFallback = false;
    const foldOptions = getFoldOptions(ctx, true);
    if (blockQuote !== "folded" && type !== Scalar.BLOCK_FOLDED) {
      foldOptions.onOverflow = () => {
        literalFallback = true;
      };
    }
    const body = foldFlowLines(`${start}${foldedValue}${end}`, indent, FOLD_BLOCK, foldOptions);
    if (!literalFallback)
      return `>${header}
${indent}${body}`;
  }
  value = value.replace(/\n+/g, `$&${indent}`);
  return `|${header}
${indent}${start}${value}${end}`;
}
function plainString(item, ctx, onComment, onChompKeep) {
  const { type, value } = item;
  const { actualString, implicitKey, indent, indentStep, inFlow } = ctx;
  if (implicitKey && value.includes(`
`) || inFlow && /[[\]{},]/.test(value)) {
    return quotedString(value, ctx);
  }
  if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) {
    return implicitKey || inFlow || !value.includes(`
`) ? quotedString(value, ctx) : blockString(item, ctx, onComment, onChompKeep);
  }
  if (!implicitKey && !inFlow && type !== Scalar.PLAIN && value.includes(`
`)) {
    return blockString(item, ctx, onComment, onChompKeep);
  }
  if (containsDocumentMarker(value)) {
    if (indent === "") {
      ctx.forceBlockIndent = true;
      return blockString(item, ctx, onComment, onChompKeep);
    } else if (implicitKey && indent === indentStep) {
      return quotedString(value, ctx);
    }
  }
  const str = value.replace(/\n+/g, `$&
${indent}`);
  if (actualString) {
    const test = (tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str);
    const { compat, tags } = ctx.doc.schema;
    if (tags.some(test) || compat?.some(test))
      return quotedString(value, ctx);
  }
  return implicitKey ? str : foldFlowLines(str, indent, FOLD_FLOW, getFoldOptions(ctx, false));
}
function stringifyString(item, ctx, onComment, onChompKeep) {
  const { implicitKey, inFlow } = ctx;
  const ss = typeof item.value === "string" ? item : Object.assign({}, item, { value: String(item.value) });
  let { type } = item;
  if (type !== Scalar.QUOTE_DOUBLE) {
    if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value))
      type = Scalar.QUOTE_DOUBLE;
  }
  const _stringify = (_type) => {
    switch (_type) {
      case Scalar.BLOCK_FOLDED:
      case Scalar.BLOCK_LITERAL:
        return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
      case Scalar.QUOTE_DOUBLE:
        return doubleQuotedString(ss.value, ctx);
      case Scalar.QUOTE_SINGLE:
        return singleQuotedString(ss.value, ctx);
      case Scalar.PLAIN:
        return plainString(ss, ctx, onComment, onChompKeep);
      default:
        return null;
    }
  };
  let res = _stringify(type);
  if (res === null) {
    const { defaultKeyType, defaultStringType } = ctx.options;
    const t = implicitKey && defaultKeyType || defaultStringType;
    res = _stringify(t);
    if (res === null)
      throw new Error(`Unsupported default string type ${t}`);
  }
  return res;
}

// node_modules/yaml/browser/dist/stringify/stringify.js
function createStringifyContext(doc, options) {
  const opt = Object.assign({
    blockQuote: true,
    commentString: stringifyComment,
    defaultKeyType: null,
    defaultStringType: "PLAIN",
    directives: null,
    doubleQuotedAsJSON: false,
    doubleQuotedMinMultiLineLength: 40,
    falseStr: "false",
    flowCollectionPadding: true,
    indentSeq: true,
    lineWidth: 80,
    minContentWidth: 20,
    nullStr: "null",
    simpleKeys: false,
    singleQuote: null,
    trueStr: "true",
    verifyAliasOrder: true
  }, doc.schema.toStringOptions, options);
  let inFlow;
  switch (opt.collectionStyle) {
    case "block":
      inFlow = false;
      break;
    case "flow":
      inFlow = true;
      break;
    default:
      inFlow = null;
  }
  return {
    anchors: new Set,
    doc,
    flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
    indent: "",
    indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
    inFlow,
    options: opt
  };
}
function getTagObject(tags, item) {
  if (item.tag) {
    const match = tags.filter((t) => t.tag === item.tag);
    if (match.length > 0)
      return match.find((t) => t.format === item.format) ?? match[0];
  }
  let tagObj = undefined;
  let obj;
  if (isScalar(item)) {
    obj = item.value;
    let match = tags.filter((t) => t.identify?.(obj));
    if (match.length > 1) {
      const testMatch = match.filter((t) => t.test);
      if (testMatch.length > 0)
        match = testMatch;
    }
    tagObj = match.find((t) => t.format === item.format) ?? match.find((t) => !t.format);
  } else {
    obj = item;
    tagObj = tags.find((t) => t.nodeClass && obj instanceof t.nodeClass);
  }
  if (!tagObj) {
    const name = obj?.constructor?.name ?? (obj === null ? "null" : typeof obj);
    throw new Error(`Tag not resolved for ${name} value`);
  }
  return tagObj;
}
function stringifyProps(node, tagObj, { anchors, doc }) {
  if (!doc.directives)
    return "";
  const props = [];
  const anchor = (isScalar(node) || isCollection(node)) && node.anchor;
  if (anchor && anchorIsValid(anchor)) {
    anchors.add(anchor);
    props.push(`&${anchor}`);
  }
  const tag = node.tag ?? (tagObj.default ? null : tagObj.tag);
  if (tag)
    props.push(doc.directives.tagString(tag));
  return props.join(" ");
}
function stringify(item, ctx, onComment, onChompKeep) {
  if (isPair(item))
    return item.toString(ctx, onComment, onChompKeep);
  if (isAlias(item)) {
    if (ctx.doc.directives)
      return item.toString(ctx);
    if (ctx.resolvedAliases?.has(item)) {
      throw new TypeError(`Cannot stringify circular structure without alias nodes`);
    } else {
      if (ctx.resolvedAliases)
        ctx.resolvedAliases.add(item);
      else
        ctx.resolvedAliases = new Set([item]);
      item = item.resolve(ctx.doc);
    }
  }
  let tagObj = undefined;
  const node = isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: (o) => tagObj = o });
  tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
  const props = stringifyProps(node, tagObj, ctx);
  if (props.length > 0)
    ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
  const str = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : isScalar(node) ? stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
  if (!props)
    return str;
  return isScalar(node) || str[0] === "{" || str[0] === "[" ? `${props} ${str}` : `${props}
${ctx.indent}${str}`;
}

// node_modules/yaml/browser/dist/stringify/stringifyPair.js
function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
  const { allNullValues, doc, indent, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
  let keyComment = isNode(key) && key.comment || null;
  if (simpleKeys) {
    if (keyComment) {
      throw new Error("With simple keys, key nodes cannot have comments");
    }
    if (isCollection(key) || !isNode(key) && typeof key === "object") {
      const msg = "With simple keys, collection cannot be used as a key value";
      throw new Error(msg);
    }
  }
  let explicitKey = !simpleKeys && (!key || keyComment && value == null && !ctx.inFlow || isCollection(key) || (isScalar(key) ? key.type === Scalar.BLOCK_FOLDED || key.type === Scalar.BLOCK_LITERAL : typeof key === "object"));
  ctx = Object.assign({}, ctx, {
    allNullValues: false,
    implicitKey: !explicitKey && (simpleKeys || !allNullValues),
    indent: indent + indentStep
  });
  let keyCommentDone = false;
  let chompKeep = false;
  let str = stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
  if (!explicitKey && !ctx.inFlow && str.length > 1024) {
    if (simpleKeys)
      throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
    explicitKey = true;
  }
  if (ctx.inFlow) {
    if (allNullValues || value == null) {
      if (keyCommentDone && onComment)
        onComment();
      return str === "" ? "?" : explicitKey ? `? ${str}` : str;
    }
  } else if (allNullValues && !simpleKeys || value == null && explicitKey) {
    str = `? ${str}`;
    if (keyComment && !keyCommentDone) {
      str += lineComment(str, ctx.indent, commentString(keyComment));
    } else if (chompKeep && onChompKeep)
      onChompKeep();
    return str;
  }
  if (keyCommentDone)
    keyComment = null;
  if (explicitKey) {
    if (keyComment)
      str += lineComment(str, ctx.indent, commentString(keyComment));
    str = `? ${str}
${indent}:`;
  } else {
    str = `${str}:`;
    if (keyComment)
      str += lineComment(str, ctx.indent, commentString(keyComment));
  }
  let vsb, vcb, valueComment;
  if (isNode(value)) {
    vsb = !!value.spaceBefore;
    vcb = value.commentBefore;
    valueComment = value.comment;
  } else {
    vsb = false;
    vcb = null;
    valueComment = null;
    if (value && typeof value === "object")
      value = doc.createNode(value);
  }
  ctx.implicitKey = false;
  if (!explicitKey && !keyComment && isScalar(value))
    ctx.indentAtStart = str.length + 1;
  chompKeep = false;
  if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && isSeq(value) && !value.flow && !value.tag && !value.anchor) {
    ctx.indent = ctx.indent.substring(2);
  }
  let valueCommentDone = false;
  const valueStr = stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
  let ws = " ";
  if (keyComment || vsb || vcb) {
    ws = vsb ? `
` : "";
    if (vcb) {
      const cs = commentString(vcb);
      ws += `
${indentComment(cs, ctx.indent)}`;
    }
    if (valueStr === "" && !ctx.inFlow) {
      if (ws === `
` && valueComment)
        ws = `

`;
    } else {
      ws += `
${ctx.indent}`;
    }
  } else if (!explicitKey && isCollection(value)) {
    const vs0 = valueStr[0];
    const nl0 = valueStr.indexOf(`
`);
    const hasNewline = nl0 !== -1;
    const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
    if (hasNewline || !flow) {
      let hasPropsLine = false;
      if (hasNewline && (vs0 === "&" || vs0 === "!")) {
        let sp0 = valueStr.indexOf(" ");
        if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") {
          sp0 = valueStr.indexOf(" ", sp0 + 1);
        }
        if (sp0 === -1 || nl0 < sp0)
          hasPropsLine = true;
      }
      if (!hasPropsLine)
        ws = `
${ctx.indent}`;
    }
  } else if (valueStr === "" || valueStr[0] === `
`) {
    ws = "";
  }
  str += ws + valueStr;
  if (ctx.inFlow) {
    if (valueCommentDone && onComment)
      onComment();
  } else if (valueComment && !valueCommentDone) {
    str += lineComment(str, ctx.indent, commentString(valueComment));
  } else if (chompKeep && onChompKeep) {
    onChompKeep();
  }
  return str;
}

// node_modules/yaml/browser/dist/log.js
function warn(logLevel, warning) {
  if (logLevel === "debug" || logLevel === "warn") {
    console.warn(warning);
  }
}

// node_modules/yaml/browser/dist/schema/yaml-1.1/merge.js
var MERGE_KEY = "<<";
var merge = {
  identify: (value) => value === MERGE_KEY || typeof value === "symbol" && value.description === MERGE_KEY,
  default: "key",
  tag: "tag:yaml.org,2002:merge",
  test: /^<<$/,
  resolve: () => Object.assign(new Scalar(Symbol(MERGE_KEY)), {
    addToJSMap: addMergeToJSMap
  }),
  stringify: () => MERGE_KEY
};
var isMergeKey = (ctx, key) => (merge.identify(key) || isScalar(key) && (!key.type || key.type === Scalar.PLAIN) && merge.identify(key.value)) && ctx?.doc.schema.tags.some((tag) => tag.tag === merge.tag && tag.default);
function addMergeToJSMap(ctx, map, value) {
  value = ctx && isAlias(value) ? value.resolve(ctx.doc) : value;
  if (isSeq(value))
    for (const it of value.items)
      mergeValue(ctx, map, it);
  else if (Array.isArray(value))
    for (const it of value)
      mergeValue(ctx, map, it);
  else
    mergeValue(ctx, map, value);
}
function mergeValue(ctx, map, value) {
  const source = ctx && isAlias(value) ? value.resolve(ctx.doc) : value;
  if (!isMap(source))
    throw new Error("Merge sources must be maps or map aliases");
  const srcMap = source.toJSON(null, ctx, Map);
  for (const [key, value] of srcMap) {
    if (map instanceof Map) {
      if (!map.has(key))
        map.set(key, value);
    } else if (map instanceof Set) {
      map.add(key);
    } else if (!Object.prototype.hasOwnProperty.call(map, key)) {
      Object.defineProperty(map, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true
      });
    }
  }
  return map;
}

// node_modules/yaml/browser/dist/nodes/addPairToJSMap.js
function addPairToJSMap(ctx, map, { key, value }) {
  if (isNode(key) && key.addToJSMap)
    key.addToJSMap(ctx, map, value);
  else if (isMergeKey(ctx, key))
    addMergeToJSMap(ctx, map, value);
  else {
    const jsKey = toJS(key, "", ctx);
    if (map instanceof Map) {
      map.set(jsKey, toJS(value, jsKey, ctx));
    } else if (map instanceof Set) {
      map.add(jsKey);
    } else {
      const stringKey = stringifyKey(key, jsKey, ctx);
      const jsValue = toJS(value, stringKey, ctx);
      if (stringKey in map)
        Object.defineProperty(map, stringKey, {
          value: jsValue,
          writable: true,
          enumerable: true,
          configurable: true
        });
      else
        map[stringKey] = jsValue;
    }
  }
  return map;
}
function stringifyKey(key, jsKey, ctx) {
  if (jsKey === null)
    return "";
  if (typeof jsKey !== "object")
    return String(jsKey);
  if (isNode(key) && ctx?.doc) {
    const strCtx = createStringifyContext(ctx.doc, {});
    strCtx.anchors = new Set;
    for (const node of ctx.anchors.keys())
      strCtx.anchors.add(node.anchor);
    strCtx.inFlow = true;
    strCtx.inStringifyKey = true;
    const strKey = key.toString(strCtx);
    if (!ctx.mapKeyWarned) {
      let jsonStr = JSON.stringify(strKey);
      if (jsonStr.length > 40)
        jsonStr = jsonStr.substring(0, 36) + '..."';
      warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
      ctx.mapKeyWarned = true;
    }
    return strKey;
  }
  return JSON.stringify(jsKey);
}

// node_modules/yaml/browser/dist/nodes/Pair.js
function createPair(key, value, ctx) {
  const k = createNode(key, undefined, ctx);
  const v = createNode(value, undefined, ctx);
  return new Pair(k, v);
}

class Pair {
  constructor(key, value = null) {
    Object.defineProperty(this, NODE_TYPE, { value: PAIR });
    this.key = key;
    this.value = value;
  }
  clone(schema) {
    let { key, value } = this;
    if (isNode(key))
      key = key.clone(schema);
    if (isNode(value))
      value = value.clone(schema);
    return new Pair(key, value);
  }
  toJSON(_, ctx) {
    const pair = ctx?.mapAsMap ? new Map : {};
    return addPairToJSMap(ctx, pair, this);
  }
  toString(ctx, onComment, onChompKeep) {
    return ctx?.doc ? stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
  }
}

// node_modules/yaml/browser/dist/stringify/stringifyCollection.js
function stringifyCollection(collection, ctx, options) {
  const flow = ctx.inFlow ?? collection.flow;
  const stringify = flow ? stringifyFlowCollection : stringifyBlockCollection;
  return stringify(collection, ctx, options);
}
function stringifyBlockCollection({ comment, items }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
  const { indent, options: { commentString } } = ctx;
  const itemCtx = Object.assign({}, ctx, { indent: itemIndent, type: null });
  let chompKeep = false;
  const lines = [];
  for (let i = 0;i < items.length; ++i) {
    const item = items[i];
    let comment = null;
    if (isNode(item)) {
      if (!chompKeep && item.spaceBefore)
        lines.push("");
      addCommentBefore(ctx, lines, item.commentBefore, chompKeep);
      if (item.comment)
        comment = item.comment;
    } else if (isPair(item)) {
      const ik = isNode(item.key) ? item.key : null;
      if (ik) {
        if (!chompKeep && ik.spaceBefore)
          lines.push("");
        addCommentBefore(ctx, lines, ik.commentBefore, chompKeep);
      }
    }
    chompKeep = false;
    let str = stringify(item, itemCtx, () => comment = null, () => chompKeep = true);
    if (comment)
      str += lineComment(str, itemIndent, commentString(comment));
    if (chompKeep && comment)
      chompKeep = false;
    lines.push(blockItemPrefix + str);
  }
  let str;
  if (lines.length === 0) {
    str = flowChars.start + flowChars.end;
  } else {
    str = lines[0];
    for (let i = 1;i < lines.length; ++i) {
      const line = lines[i];
      str += line ? `
${indent}${line}` : `
`;
    }
  }
  if (comment) {
    str += `
` + indentComment(commentString(comment), indent);
    if (onComment)
      onComment();
  } else if (chompKeep && onChompKeep)
    onChompKeep();
  return str;
}
function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
  const { indent, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
  itemIndent += indentStep;
  const itemCtx = Object.assign({}, ctx, {
    indent: itemIndent,
    inFlow: true,
    type: null
  });
  let reqNewline = false;
  let linesAtValue = 0;
  const lines = [];
  for (let i = 0;i < items.length; ++i) {
    const item = items[i];
    let comment = null;
    if (isNode(item)) {
      if (item.spaceBefore)
        lines.push("");
      addCommentBefore(ctx, lines, item.commentBefore, false);
      if (item.comment)
        comment = item.comment;
    } else if (isPair(item)) {
      const ik = isNode(item.key) ? item.key : null;
      if (ik) {
        if (ik.spaceBefore)
          lines.push("");
        addCommentBefore(ctx, lines, ik.commentBefore, false);
        if (ik.comment)
          reqNewline = true;
      }
      const iv = isNode(item.value) ? item.value : null;
      if (iv) {
        if (iv.comment)
          comment = iv.comment;
        if (iv.commentBefore)
          reqNewline = true;
      } else if (item.value == null && ik?.comment) {
        comment = ik.comment;
      }
    }
    if (comment)
      reqNewline = true;
    let str = stringify(item, itemCtx, () => comment = null);
    if (i < items.length - 1)
      str += ",";
    if (comment)
      str += lineComment(str, itemIndent, commentString(comment));
    if (!reqNewline && (lines.length > linesAtValue || str.includes(`
`)))
      reqNewline = true;
    lines.push(str);
    linesAtValue = lines.length;
  }
  const { start, end } = flowChars;
  if (lines.length === 0) {
    return start + end;
  } else {
    if (!reqNewline) {
      const len = lines.reduce((sum, line) => sum + line.length + 2, 2);
      reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
    }
    if (reqNewline) {
      let str = start;
      for (const line of lines)
        str += line ? `
${indentStep}${indent}${line}` : `
`;
      return `${str}
${indent}${end}`;
    } else {
      return `${start}${fcPadding}${lines.join(" ")}${fcPadding}${end}`;
    }
  }
}
function addCommentBefore({ indent, options: { commentString } }, lines, comment, chompKeep) {
  if (comment && chompKeep)
    comment = comment.replace(/^\n+/, "");
  if (comment) {
    const ic = indentComment(commentString(comment), indent);
    lines.push(ic.trimStart());
  }
}

// node_modules/yaml/browser/dist/nodes/YAMLMap.js
function findPair(items, key) {
  const k = isScalar(key) ? key.value : key;
  for (const it of items) {
    if (isPair(it)) {
      if (it.key === key || it.key === k)
        return it;
      if (isScalar(it.key) && it.key.value === k)
        return it;
    }
  }
  return;
}

class YAMLMap extends Collection {
  static get tagName() {
    return "tag:yaml.org,2002:map";
  }
  constructor(schema) {
    super(MAP, schema);
    this.items = [];
  }
  static from(schema, obj, ctx) {
    const { keepUndefined, replacer } = ctx;
    const map = new this(schema);
    const add = (key, value) => {
      if (typeof replacer === "function")
        value = replacer.call(obj, key, value);
      else if (Array.isArray(replacer) && !replacer.includes(key))
        return;
      if (value !== undefined || keepUndefined)
        map.items.push(createPair(key, value, ctx));
    };
    if (obj instanceof Map) {
      for (const [key, value] of obj)
        add(key, value);
    } else if (obj && typeof obj === "object") {
      for (const key of Object.keys(obj))
        add(key, obj[key]);
    }
    if (typeof schema.sortMapEntries === "function") {
      map.items.sort(schema.sortMapEntries);
    }
    return map;
  }
  add(pair, overwrite) {
    let _pair;
    if (isPair(pair))
      _pair = pair;
    else if (!pair || typeof pair !== "object" || !("key" in pair)) {
      _pair = new Pair(pair, pair?.value);
    } else
      _pair = new Pair(pair.key, pair.value);
    const prev = findPair(this.items, _pair.key);
    const sortEntries = this.schema?.sortMapEntries;
    if (prev) {
      if (!overwrite)
        throw new Error(`Key ${_pair.key} already set`);
      if (isScalar(prev.value) && isScalarValue(_pair.value))
        prev.value.value = _pair.value;
      else
        prev.value = _pair.value;
    } else if (sortEntries) {
      const i = this.items.findIndex((item) => sortEntries(_pair, item) < 0);
      if (i === -1)
        this.items.push(_pair);
      else
        this.items.splice(i, 0, _pair);
    } else {
      this.items.push(_pair);
    }
  }
  delete(key) {
    const it = findPair(this.items, key);
    if (!it)
      return false;
    const del = this.items.splice(this.items.indexOf(it), 1);
    return del.length > 0;
  }
  get(key, keepScalar) {
    const it = findPair(this.items, key);
    const node = it?.value;
    return (!keepScalar && isScalar(node) ? node.value : node) ?? undefined;
  }
  has(key) {
    return !!findPair(this.items, key);
  }
  set(key, value) {
    this.add(new Pair(key, value), true);
  }
  toJSON(_, ctx, Type) {
    const map = Type ? new Type : ctx?.mapAsMap ? new Map : {};
    if (ctx?.onCreate)
      ctx.onCreate(map);
    for (const item of this.items)
      addPairToJSMap(ctx, map, item);
    return map;
  }
  toString(ctx, onComment, onChompKeep) {
    if (!ctx)
      return JSON.stringify(this);
    for (const item of this.items) {
      if (!isPair(item))
        throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
    }
    if (!ctx.allNullValues && this.hasAllNullValues(false))
      ctx = Object.assign({}, ctx, { allNullValues: true });
    return stringifyCollection(this, ctx, {
      blockItemPrefix: "",
      flowChars: { start: "{", end: "}" },
      itemIndent: ctx.indent || "",
      onChompKeep,
      onComment
    });
  }
}

// node_modules/yaml/browser/dist/schema/common/map.js
var map = {
  collection: "map",
  default: true,
  nodeClass: YAMLMap,
  tag: "tag:yaml.org,2002:map",
  resolve(map, onError) {
    if (!isMap(map))
      onError("Expected a mapping for this tag");
    return map;
  },
  createNode: (schema, obj, ctx) => YAMLMap.from(schema, obj, ctx)
};

// node_modules/yaml/browser/dist/nodes/YAMLSeq.js
class YAMLSeq extends Collection {
  static get tagName() {
    return "tag:yaml.org,2002:seq";
  }
  constructor(schema) {
    super(SEQ, schema);
    this.items = [];
  }
  add(value) {
    this.items.push(value);
  }
  delete(key) {
    const idx = asItemIndex(key);
    if (typeof idx !== "number")
      return false;
    const del = this.items.splice(idx, 1);
    return del.length > 0;
  }
  get(key, keepScalar) {
    const idx = asItemIndex(key);
    if (typeof idx !== "number")
      return;
    const it = this.items[idx];
    return !keepScalar && isScalar(it) ? it.value : it;
  }
  has(key) {
    const idx = asItemIndex(key);
    return typeof idx === "number" && idx < this.items.length;
  }
  set(key, value) {
    const idx = asItemIndex(key);
    if (typeof idx !== "number")
      throw new Error(`Expected a valid index, not ${key}.`);
    const prev = this.items[idx];
    if (isScalar(prev) && isScalarValue(value))
      prev.value = value;
    else
      this.items[idx] = value;
  }
  toJSON(_, ctx) {
    const seq = [];
    if (ctx?.onCreate)
      ctx.onCreate(seq);
    let i = 0;
    for (const item of this.items)
      seq.push(toJS(item, String(i++), ctx));
    return seq;
  }
  toString(ctx, onComment, onChompKeep) {
    if (!ctx)
      return JSON.stringify(this);
    return stringifyCollection(this, ctx, {
      blockItemPrefix: "- ",
      flowChars: { start: "[", end: "]" },
      itemIndent: (ctx.indent || "") + "  ",
      onChompKeep,
      onComment
    });
  }
  static from(schema, obj, ctx) {
    const { replacer } = ctx;
    const seq = new this(schema);
    if (obj && Symbol.iterator in Object(obj)) {
      let i = 0;
      for (let it of obj) {
        if (typeof replacer === "function") {
          const key = obj instanceof Set ? it : String(i++);
          it = replacer.call(obj, key, it);
        }
        seq.items.push(createNode(it, undefined, ctx));
      }
    }
    return seq;
  }
}
function asItemIndex(key) {
  let idx = isScalar(key) ? key.value : key;
  if (idx && typeof idx === "string")
    idx = Number(idx);
  return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
}

// node_modules/yaml/browser/dist/schema/common/seq.js
var seq = {
  collection: "seq",
  default: true,
  nodeClass: YAMLSeq,
  tag: "tag:yaml.org,2002:seq",
  resolve(seq, onError) {
    if (!isSeq(seq))
      onError("Expected a sequence for this tag");
    return seq;
  },
  createNode: (schema, obj, ctx) => YAMLSeq.from(schema, obj, ctx)
};

// node_modules/yaml/browser/dist/schema/common/string.js
var string = {
  identify: (value) => typeof value === "string",
  default: true,
  tag: "tag:yaml.org,2002:str",
  resolve: (str) => str,
  stringify(item, ctx, onComment, onChompKeep) {
    ctx = Object.assign({ actualString: true }, ctx);
    return stringifyString(item, ctx, onComment, onChompKeep);
  }
};

// node_modules/yaml/browser/dist/schema/common/null.js
var nullTag = {
  identify: (value) => value == null,
  createNode: () => new Scalar(null),
  default: true,
  tag: "tag:yaml.org,2002:null",
  test: /^(?:~|[Nn]ull|NULL)?$/,
  resolve: () => new Scalar(null),
  stringify: ({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr
};

// node_modules/yaml/browser/dist/schema/core/bool.js
var boolTag = {
  identify: (value) => typeof value === "boolean",
  default: true,
  tag: "tag:yaml.org,2002:bool",
  test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
  resolve: (str) => new Scalar(str[0] === "t" || str[0] === "T"),
  stringify({ source, value }, ctx) {
    if (source && boolTag.test.test(source)) {
      const sv = source[0] === "t" || source[0] === "T";
      if (value === sv)
        return source;
    }
    return value ? ctx.options.trueStr : ctx.options.falseStr;
  }
};

// node_modules/yaml/browser/dist/stringify/stringifyNumber.js
function stringifyNumber({ format, minFractionDigits, tag, value }) {
  if (typeof value === "bigint")
    return String(value);
  const num = typeof value === "number" ? value : Number(value);
  if (!isFinite(num))
    return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
  let n = Object.is(value, -0) ? "-0" : JSON.stringify(value);
  if (!format && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^\d/.test(n)) {
    let i = n.indexOf(".");
    if (i < 0) {
      i = n.length;
      n += ".";
    }
    let d = minFractionDigits - (n.length - i - 1);
    while (d-- > 0)
      n += "0";
  }
  return n;
}

// node_modules/yaml/browser/dist/schema/core/float.js
var floatNaN = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
  resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
  stringify: stringifyNumber
};
var floatExp = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  format: "EXP",
  test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
  resolve: (str) => parseFloat(str),
  stringify(node) {
    const num = Number(node.value);
    return isFinite(num) ? num.toExponential() : stringifyNumber(node);
  }
};
var float = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
  resolve(str) {
    const node = new Scalar(parseFloat(str));
    const dot = str.indexOf(".");
    if (dot !== -1 && str[str.length - 1] === "0")
      node.minFractionDigits = str.length - dot - 1;
    return node;
  },
  stringify: stringifyNumber
};

// node_modules/yaml/browser/dist/schema/core/int.js
var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
var intResolve = (str, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix);
function intStringify(node, radix, prefix) {
  const { value } = node;
  if (intIdentify(value) && value >= 0)
    return prefix + value.toString(radix);
  return stringifyNumber(node);
}
var intOct = {
  identify: (value) => intIdentify(value) && value >= 0,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "OCT",
  test: /^0o[0-7]+$/,
  resolve: (str, _onError, opt) => intResolve(str, 2, 8, opt),
  stringify: (node) => intStringify(node, 8, "0o")
};
var int = {
  identify: intIdentify,
  default: true,
  tag: "tag:yaml.org,2002:int",
  test: /^[-+]?[0-9]+$/,
  resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
  stringify: stringifyNumber
};
var intHex = {
  identify: (value) => intIdentify(value) && value >= 0,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "HEX",
  test: /^0x[0-9a-fA-F]+$/,
  resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
  stringify: (node) => intStringify(node, 16, "0x")
};

// node_modules/yaml/browser/dist/schema/core/schema.js
var schema = [
  map,
  seq,
  string,
  nullTag,
  boolTag,
  intOct,
  int,
  intHex,
  floatNaN,
  floatExp,
  float
];

// node_modules/yaml/browser/dist/schema/json/schema.js
function intIdentify2(value) {
  return typeof value === "bigint" || Number.isInteger(value);
}
var stringifyJSON = ({ value }) => JSON.stringify(value);
var jsonScalars = [
  {
    identify: (value) => typeof value === "string",
    default: true,
    tag: "tag:yaml.org,2002:str",
    resolve: (str) => str,
    stringify: stringifyJSON
  },
  {
    identify: (value) => value == null,
    createNode: () => new Scalar(null),
    default: true,
    tag: "tag:yaml.org,2002:null",
    test: /^null$/,
    resolve: () => null,
    stringify: stringifyJSON
  },
  {
    identify: (value) => typeof value === "boolean",
    default: true,
    tag: "tag:yaml.org,2002:bool",
    test: /^true$|^false$/,
    resolve: (str) => str === "true",
    stringify: stringifyJSON
  },
  {
    identify: intIdentify2,
    default: true,
    tag: "tag:yaml.org,2002:int",
    test: /^-?(?:0|[1-9][0-9]*)$/,
    resolve: (str, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str, 10),
    stringify: ({ value }) => intIdentify2(value) ? value.toString() : JSON.stringify(value)
  },
  {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
    resolve: (str) => parseFloat(str),
    stringify: stringifyJSON
  }
];
var jsonError = {
  default: true,
  tag: "",
  test: /^/,
  resolve(str, onError) {
    onError(`Unresolved plain scalar ${JSON.stringify(str)}`);
    return str;
  }
};
var schema2 = [map, seq].concat(jsonScalars, jsonError);

// node_modules/yaml/browser/dist/schema/yaml-1.1/binary.js
var binary = {
  identify: (value) => value instanceof Uint8Array,
  default: false,
  tag: "tag:yaml.org,2002:binary",
  resolve(src, onError) {
    if (typeof atob === "function") {
      const str = atob(src.replace(/[\n\r]/g, ""));
      const buffer = new Uint8Array(str.length);
      for (let i = 0;i < str.length; ++i)
        buffer[i] = str.charCodeAt(i);
      return buffer;
    } else {
      onError("This environment does not support reading binary tags; either Buffer or atob is required");
      return src;
    }
  },
  stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
    if (!value)
      return "";
    const buf = value;
    let str;
    if (typeof btoa === "function") {
      let s = "";
      for (let i = 0;i < buf.length; ++i)
        s += String.fromCharCode(buf[i]);
      str = btoa(s);
    } else {
      throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
    }
    type ?? (type = Scalar.BLOCK_LITERAL);
    if (type !== Scalar.QUOTE_DOUBLE) {
      const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
      const n = Math.ceil(str.length / lineWidth);
      const lines = new Array(n);
      for (let i = 0, o = 0;i < n; ++i, o += lineWidth) {
        lines[i] = str.substr(o, lineWidth);
      }
      str = lines.join(type === Scalar.BLOCK_LITERAL ? `
` : " ");
    }
    return stringifyString({ comment, type, value: str }, ctx, onComment, onChompKeep);
  }
};

// node_modules/yaml/browser/dist/schema/yaml-1.1/pairs.js
function resolvePairs(seq, onError) {
  if (isSeq(seq)) {
    for (let i = 0;i < seq.items.length; ++i) {
      let item = seq.items[i];
      if (isPair(item))
        continue;
      else if (isMap(item)) {
        if (item.items.length > 1)
          onError("Each pair must have its own sequence indicator");
        const pair = item.items[0] || new Pair(new Scalar(null));
        if (item.commentBefore)
          pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}
${pair.key.commentBefore}` : item.commentBefore;
        if (item.comment) {
          const cn = pair.value ?? pair.key;
          cn.comment = cn.comment ? `${item.comment}
${cn.comment}` : item.comment;
        }
        item = pair;
      }
      seq.items[i] = isPair(item) ? item : new Pair(item);
    }
  } else
    onError("Expected a sequence for this tag");
  return seq;
}
function createPairs(schema, iterable, ctx) {
  const { replacer } = ctx;
  const pairs = new YAMLSeq(schema);
  pairs.tag = "tag:yaml.org,2002:pairs";
  let i = 0;
  if (iterable && Symbol.iterator in Object(iterable))
    for (let it of iterable) {
      if (typeof replacer === "function")
        it = replacer.call(iterable, String(i++), it);
      let key, value;
      if (Array.isArray(it)) {
        if (it.length === 2) {
          key = it[0];
          value = it[1];
        } else
          throw new TypeError(`Expected [key, value] tuple: ${it}`);
      } else if (it && it instanceof Object) {
        const keys = Object.keys(it);
        if (keys.length === 1) {
          key = keys[0];
          value = it[key];
        } else {
          throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
        }
      } else {
        key = it;
      }
      pairs.items.push(createPair(key, value, ctx));
    }
  return pairs;
}
var pairs = {
  collection: "seq",
  default: false,
  tag: "tag:yaml.org,2002:pairs",
  resolve: resolvePairs,
  createNode: createPairs
};

// node_modules/yaml/browser/dist/schema/yaml-1.1/omap.js
class YAMLOMap extends YAMLSeq {
  constructor() {
    super();
    this.add = YAMLMap.prototype.add.bind(this);
    this.delete = YAMLMap.prototype.delete.bind(this);
    this.get = YAMLMap.prototype.get.bind(this);
    this.has = YAMLMap.prototype.has.bind(this);
    this.set = YAMLMap.prototype.set.bind(this);
    this.tag = YAMLOMap.tag;
  }
  toJSON(_, ctx) {
    if (!ctx)
      return super.toJSON(_);
    const map = new Map;
    if (ctx?.onCreate)
      ctx.onCreate(map);
    for (const pair of this.items) {
      let key, value;
      if (isPair(pair)) {
        key = toJS(pair.key, "", ctx);
        value = toJS(pair.value, key, ctx);
      } else {
        key = toJS(pair, "", ctx);
      }
      if (map.has(key))
        throw new Error("Ordered maps must not include duplicate keys");
      map.set(key, value);
    }
    return map;
  }
  static from(schema, iterable, ctx) {
    const pairs = createPairs(schema, iterable, ctx);
    const omap = new this;
    omap.items = pairs.items;
    return omap;
  }
}
YAMLOMap.tag = "tag:yaml.org,2002:omap";
var omap = {
  collection: "seq",
  identify: (value) => value instanceof Map,
  nodeClass: YAMLOMap,
  default: false,
  tag: "tag:yaml.org,2002:omap",
  resolve(seq, onError) {
    const pairs = resolvePairs(seq, onError);
    const seenKeys = [];
    for (const { key } of pairs.items) {
      if (isScalar(key)) {
        if (seenKeys.includes(key.value)) {
          onError(`Ordered maps must not include duplicate keys: ${key.value}`);
        } else {
          seenKeys.push(key.value);
        }
      }
    }
    return Object.assign(new YAMLOMap, pairs);
  },
  createNode: (schema, iterable, ctx) => YAMLOMap.from(schema, iterable, ctx)
};

// node_modules/yaml/browser/dist/schema/yaml-1.1/bool.js
function boolStringify({ value, source }, ctx) {
  const boolObj = value ? trueTag : falseTag;
  if (source && boolObj.test.test(source))
    return source;
  return value ? ctx.options.trueStr : ctx.options.falseStr;
}
var trueTag = {
  identify: (value) => value === true,
  default: true,
  tag: "tag:yaml.org,2002:bool",
  test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
  resolve: () => new Scalar(true),
  stringify: boolStringify
};
var falseTag = {
  identify: (value) => value === false,
  default: true,
  tag: "tag:yaml.org,2002:bool",
  test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
  resolve: () => new Scalar(false),
  stringify: boolStringify
};

// node_modules/yaml/browser/dist/schema/yaml-1.1/float.js
var floatNaN2 = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
  resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
  stringify: stringifyNumber
};
var floatExp2 = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  format: "EXP",
  test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
  resolve: (str) => parseFloat(str.replace(/_/g, "")),
  stringify(node) {
    const num = Number(node.value);
    return isFinite(num) ? num.toExponential() : stringifyNumber(node);
  }
};
var float2 = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
  resolve(str) {
    const node = new Scalar(parseFloat(str.replace(/_/g, "")));
    const dot = str.indexOf(".");
    if (dot !== -1) {
      const f = str.substring(dot + 1).replace(/_/g, "");
      if (f[f.length - 1] === "0")
        node.minFractionDigits = f.length;
    }
    return node;
  },
  stringify: stringifyNumber
};

// node_modules/yaml/browser/dist/schema/yaml-1.1/int.js
var intIdentify3 = (value) => typeof value === "bigint" || Number.isInteger(value);
function intResolve2(str, offset, radix, { intAsBigInt }) {
  const sign = str[0];
  if (sign === "-" || sign === "+")
    offset += 1;
  str = str.substring(offset).replace(/_/g, "");
  if (intAsBigInt) {
    switch (radix) {
      case 2:
        str = `0b${str}`;
        break;
      case 8:
        str = `0o${str}`;
        break;
      case 16:
        str = `0x${str}`;
        break;
    }
    const n = BigInt(str);
    return sign === "-" ? BigInt(-1) * n : n;
  }
  const n = parseInt(str, radix);
  return sign === "-" ? -1 * n : n;
}
function intStringify2(node, radix, prefix) {
  const { value } = node;
  if (intIdentify3(value)) {
    const str = value.toString(radix);
    return value < 0 ? "-" + prefix + str.substr(1) : prefix + str;
  }
  return stringifyNumber(node);
}
var intBin = {
  identify: intIdentify3,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "BIN",
  test: /^[-+]?0b[0-1_]+$/,
  resolve: (str, _onError, opt) => intResolve2(str, 2, 2, opt),
  stringify: (node) => intStringify2(node, 2, "0b")
};
var intOct2 = {
  identify: intIdentify3,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "OCT",
  test: /^[-+]?0[0-7_]+$/,
  resolve: (str, _onError, opt) => intResolve2(str, 1, 8, opt),
  stringify: (node) => intStringify2(node, 8, "0")
};
var int2 = {
  identify: intIdentify3,
  default: true,
  tag: "tag:yaml.org,2002:int",
  test: /^[-+]?[0-9][0-9_]*$/,
  resolve: (str, _onError, opt) => intResolve2(str, 0, 10, opt),
  stringify: stringifyNumber
};
var intHex2 = {
  identify: intIdentify3,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "HEX",
  test: /^[-+]?0x[0-9a-fA-F_]+$/,
  resolve: (str, _onError, opt) => intResolve2(str, 2, 16, opt),
  stringify: (node) => intStringify2(node, 16, "0x")
};

// node_modules/yaml/browser/dist/schema/yaml-1.1/set.js
class YAMLSet extends YAMLMap {
  constructor(schema) {
    super(schema);
    this.tag = YAMLSet.tag;
  }
  add(key) {
    let pair;
    if (isPair(key))
      pair = key;
    else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null)
      pair = new Pair(key.key, null);
    else
      pair = new Pair(key, null);
    const prev = findPair(this.items, pair.key);
    if (!prev)
      this.items.push(pair);
  }
  get(key, keepPair) {
    const pair = findPair(this.items, key);
    return !keepPair && isPair(pair) ? isScalar(pair.key) ? pair.key.value : pair.key : pair;
  }
  set(key, value) {
    if (typeof value !== "boolean")
      throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
    const prev = findPair(this.items, key);
    if (prev && !value) {
      this.items.splice(this.items.indexOf(prev), 1);
    } else if (!prev && value) {
      this.items.push(new Pair(key));
    }
  }
  toJSON(_, ctx) {
    return super.toJSON(_, ctx, Set);
  }
  toString(ctx, onComment, onChompKeep) {
    if (!ctx)
      return JSON.stringify(this);
    if (this.hasAllNullValues(true))
      return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
    else
      throw new Error("Set items must all have null values");
  }
  static from(schema, iterable, ctx) {
    const { replacer } = ctx;
    const set = new this(schema);
    if (iterable && Symbol.iterator in Object(iterable))
      for (let value of iterable) {
        if (typeof replacer === "function")
          value = replacer.call(iterable, value, value);
        set.items.push(createPair(value, null, ctx));
      }
    return set;
  }
}
YAMLSet.tag = "tag:yaml.org,2002:set";
var set = {
  collection: "map",
  identify: (value) => value instanceof Set,
  nodeClass: YAMLSet,
  default: false,
  tag: "tag:yaml.org,2002:set",
  createNode: (schema, iterable, ctx) => YAMLSet.from(schema, iterable, ctx),
  resolve(map, onError) {
    if (isMap(map)) {
      if (map.hasAllNullValues(true))
        return Object.assign(new YAMLSet, map);
      else
        onError("Set items must all have null values");
    } else
      onError("Expected a mapping for this tag");
    return map;
  }
};

// node_modules/yaml/browser/dist/schema/yaml-1.1/timestamp.js
function parseSexagesimal(str, asBigInt) {
  const sign = str[0];
  const parts = sign === "-" || sign === "+" ? str.substring(1) : str;
  const num = (n) => asBigInt ? BigInt(n) : Number(n);
  const res = parts.replace(/_/g, "").split(":").reduce((res, p) => res * num(60) + num(p), num(0));
  return sign === "-" ? num(-1) * res : res;
}
function stringifySexagesimal(node) {
  let { value } = node;
  let num = (n) => n;
  if (typeof value === "bigint")
    num = (n) => BigInt(n);
  else if (isNaN(value) || !isFinite(value))
    return stringifyNumber(node);
  let sign = "";
  if (value < 0) {
    sign = "-";
    value *= num(-1);
  }
  const _60 = num(60);
  const parts = [value % _60];
  if (value < 60) {
    parts.unshift(0);
  } else {
    value = (value - parts[0]) / _60;
    parts.unshift(value % _60);
    if (value >= 60) {
      value = (value - parts[0]) / _60;
      parts.unshift(value);
    }
  }
  return sign + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
}
var intTime = {
  identify: (value) => typeof value === "bigint" || Number.isInteger(value),
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "TIME",
  test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
  resolve: (str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt),
  stringify: stringifySexagesimal
};
var floatTime = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  format: "TIME",
  test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
  resolve: (str) => parseSexagesimal(str, false),
  stringify: stringifySexagesimal
};
var timestamp = {
  identify: (value) => value instanceof Date,
  default: true,
  tag: "tag:yaml.org,2002:timestamp",
  test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})" + "(?:" + "(?:t|T|[ \\t]+)" + "([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)" + "(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?" + ")?$"),
  resolve(str) {
    const match = str.match(timestamp.test);
    if (!match)
      throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
    const [, year, month, day, hour, minute, second] = match.map(Number);
    const millisec = match[7] ? Number((match[7] + "00").substr(1, 3)) : 0;
    let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
    const tz = match[8];
    if (tz && tz !== "Z") {
      let d = parseSexagesimal(tz, false);
      if (Math.abs(d) < 30)
        d *= 60;
      date -= 60000 * d;
    }
    return new Date(date);
  },
  stringify: ({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? ""
};

// node_modules/yaml/browser/dist/schema/yaml-1.1/schema.js
var schema3 = [
  map,
  seq,
  string,
  nullTag,
  trueTag,
  falseTag,
  intBin,
  intOct2,
  int2,
  intHex2,
  floatNaN2,
  floatExp2,
  float2,
  binary,
  merge,
  omap,
  pairs,
  set,
  intTime,
  floatTime,
  timestamp
];

// node_modules/yaml/browser/dist/schema/tags.js
var schemas = new Map([
  ["core", schema],
  ["failsafe", [map, seq, string]],
  ["json", schema2],
  ["yaml11", schema3],
  ["yaml-1.1", schema3]
]);
var tagsByName = {
  binary,
  bool: boolTag,
  float,
  floatExp,
  floatNaN,
  floatTime,
  int,
  intHex,
  intOct,
  intTime,
  map,
  merge,
  null: nullTag,
  omap,
  pairs,
  seq,
  set,
  timestamp
};
var coreKnownTags = {
  "tag:yaml.org,2002:binary": binary,
  "tag:yaml.org,2002:merge": merge,
  "tag:yaml.org,2002:omap": omap,
  "tag:yaml.org,2002:pairs": pairs,
  "tag:yaml.org,2002:set": set,
  "tag:yaml.org,2002:timestamp": timestamp
};
function getTags(customTags, schemaName, addMergeTag) {
  const schemaTags = schemas.get(schemaName);
  if (schemaTags && !customTags) {
    return addMergeTag && !schemaTags.includes(merge) ? schemaTags.concat(merge) : schemaTags.slice();
  }
  let tags = schemaTags;
  if (!tags) {
    if (Array.isArray(customTags))
      tags = [];
    else {
      const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
      throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
    }
  }
  if (Array.isArray(customTags)) {
    for (const tag of customTags)
      tags = tags.concat(tag);
  } else if (typeof customTags === "function") {
    tags = customTags(tags.slice());
  }
  if (addMergeTag)
    tags = tags.concat(merge);
  return tags.reduce((tags, tag) => {
    const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
    if (!tagObj) {
      const tagName = JSON.stringify(tag);
      const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
      throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
    }
    if (!tags.includes(tagObj))
      tags.push(tagObj);
    return tags;
  }, []);
}

// node_modules/yaml/browser/dist/schema/Schema.js
var sortMapEntriesByKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

class Schema {
  constructor({ compat, customTags, merge, resolveKnownTags, schema, sortMapEntries, toStringDefaults }) {
    this.compat = Array.isArray(compat) ? getTags(compat, "compat") : compat ? getTags(null, compat) : null;
    this.name = typeof schema === "string" && schema || "core";
    this.knownTags = resolveKnownTags ? coreKnownTags : {};
    this.tags = getTags(customTags, this.name, merge);
    this.toStringOptions = toStringDefaults ?? null;
    Object.defineProperty(this, MAP, { value: map });
    Object.defineProperty(this, SCALAR, { value: string });
    Object.defineProperty(this, SEQ, { value: seq });
    this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
  }
  clone() {
    const copy = Object.create(Schema.prototype, Object.getOwnPropertyDescriptors(this));
    copy.tags = this.tags.slice();
    return copy;
  }
}

// node_modules/yaml/browser/dist/stringify/stringifyDocument.js
function stringifyDocument(doc, options) {
  const lines = [];
  let hasDirectives = options.directives === true;
  if (options.directives !== false && doc.directives) {
    const dir = doc.directives.toString(doc);
    if (dir) {
      lines.push(dir);
      hasDirectives = true;
    } else if (doc.directives.docStart)
      hasDirectives = true;
  }
  if (hasDirectives)
    lines.push("---");
  const ctx = createStringifyContext(doc, options);
  const { commentString } = ctx.options;
  if (doc.commentBefore) {
    if (lines.length !== 1)
      lines.unshift("");
    const cs = commentString(doc.commentBefore);
    lines.unshift(indentComment(cs, ""));
  }
  let chompKeep = false;
  let contentComment = null;
  if (doc.contents) {
    if (isNode(doc.contents)) {
      if (doc.contents.spaceBefore && hasDirectives)
        lines.push("");
      if (doc.contents.commentBefore) {
        const cs = commentString(doc.contents.commentBefore);
        lines.push(indentComment(cs, ""));
      }
      ctx.forceBlockIndent = !!doc.comment;
      contentComment = doc.contents.comment;
    }
    const onChompKeep = contentComment ? undefined : () => chompKeep = true;
    let body = stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
    if (contentComment)
      body += lineComment(body, "", commentString(contentComment));
    if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") {
      lines[lines.length - 1] = `--- ${body}`;
    } else
      lines.push(body);
  } else {
    lines.push(stringify(doc.contents, ctx));
  }
  if (doc.directives?.docEnd) {
    if (doc.comment) {
      const cs = commentString(doc.comment);
      if (cs.includes(`
`)) {
        lines.push("...");
        lines.push(indentComment(cs, ""));
      } else {
        lines.push(`... ${cs}`);
      }
    } else {
      lines.push("...");
    }
  } else {
    let dc = doc.comment;
    if (dc && chompKeep)
      dc = dc.replace(/^\n+/, "");
    if (dc) {
      if ((!chompKeep || contentComment) && lines[lines.length - 1] !== "")
        lines.push("");
      lines.push(indentComment(commentString(dc), ""));
    }
  }
  return lines.join(`
`) + `
`;
}

// node_modules/yaml/browser/dist/doc/Document.js
class Document {
  constructor(value, replacer, options) {
    this.commentBefore = null;
    this.comment = null;
    this.errors = [];
    this.warnings = [];
    Object.defineProperty(this, NODE_TYPE, { value: DOC });
    let _replacer = null;
    if (typeof replacer === "function" || Array.isArray(replacer)) {
      _replacer = replacer;
    } else if (options === undefined && replacer) {
      options = replacer;
      replacer = undefined;
    }
    const opt = Object.assign({
      intAsBigInt: false,
      keepSourceTokens: false,
      logLevel: "warn",
      prettyErrors: true,
      strict: true,
      stringKeys: false,
      uniqueKeys: true,
      version: "1.2"
    }, options);
    this.options = opt;
    let { version } = opt;
    if (options?._directives) {
      this.directives = options._directives.atDocument();
      if (this.directives.yaml.explicit)
        version = this.directives.yaml.version;
    } else
      this.directives = new Directives({ version });
    this.setSchema(version, options);
    this.contents = value === undefined ? null : this.createNode(value, _replacer, options);
  }
  clone() {
    const copy = Object.create(Document.prototype, {
      [NODE_TYPE]: { value: DOC }
    });
    copy.commentBefore = this.commentBefore;
    copy.comment = this.comment;
    copy.errors = this.errors.slice();
    copy.warnings = this.warnings.slice();
    copy.options = Object.assign({}, this.options);
    if (this.directives)
      copy.directives = this.directives.clone();
    copy.schema = this.schema.clone();
    copy.contents = isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
    if (this.range)
      copy.range = this.range.slice();
    return copy;
  }
  add(value) {
    if (assertCollection(this.contents))
      this.contents.add(value);
  }
  addIn(path, value) {
    if (assertCollection(this.contents))
      this.contents.addIn(path, value);
  }
  createAlias(node, name) {
    if (!node.anchor) {
      const prev = anchorNames(this);
      node.anchor = !name || prev.has(name) ? findNewAnchor(name || "a", prev) : name;
    }
    return new Alias(node.anchor);
  }
  createNode(value, replacer, options) {
    let _replacer = undefined;
    if (typeof replacer === "function") {
      value = replacer.call({ "": value }, "", value);
      _replacer = replacer;
    } else if (Array.isArray(replacer)) {
      const keyToStr = (v) => typeof v === "number" || v instanceof String || v instanceof Number;
      const asStr = replacer.filter(keyToStr).map(String);
      if (asStr.length > 0)
        replacer = replacer.concat(asStr);
      _replacer = replacer;
    } else if (options === undefined && replacer) {
      options = replacer;
      replacer = undefined;
    }
    const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options ?? {};
    const { onAnchor, setAnchors, sourceObjects } = createNodeAnchors(this, anchorPrefix || "a");
    const ctx = {
      aliasDuplicateObjects: aliasDuplicateObjects ?? true,
      keepUndefined: keepUndefined ?? false,
      onAnchor,
      onTagObj,
      replacer: _replacer,
      schema: this.schema,
      sourceObjects
    };
    const node = createNode(value, tag, ctx);
    if (flow && isCollection(node))
      node.flow = true;
    setAnchors();
    return node;
  }
  createPair(key, value, options = {}) {
    const k = this.createNode(key, null, options);
    const v = this.createNode(value, null, options);
    return new Pair(k, v);
  }
  delete(key) {
    return assertCollection(this.contents) ? this.contents.delete(key) : false;
  }
  deleteIn(path) {
    if (isEmptyPath(path)) {
      if (this.contents == null)
        return false;
      this.contents = null;
      return true;
    }
    return assertCollection(this.contents) ? this.contents.deleteIn(path) : false;
  }
  get(key, keepScalar) {
    return isCollection(this.contents) ? this.contents.get(key, keepScalar) : undefined;
  }
  getIn(path, keepScalar) {
    if (isEmptyPath(path))
      return !keepScalar && isScalar(this.contents) ? this.contents.value : this.contents;
    return isCollection(this.contents) ? this.contents.getIn(path, keepScalar) : undefined;
  }
  has(key) {
    return isCollection(this.contents) ? this.contents.has(key) : false;
  }
  hasIn(path) {
    if (isEmptyPath(path))
      return this.contents !== undefined;
    return isCollection(this.contents) ? this.contents.hasIn(path) : false;
  }
  set(key, value) {
    if (this.contents == null) {
      this.contents = collectionFromPath(this.schema, [key], value);
    } else if (assertCollection(this.contents)) {
      this.contents.set(key, value);
    }
  }
  setIn(path, value) {
    if (isEmptyPath(path)) {
      this.contents = value;
    } else if (this.contents == null) {
      this.contents = collectionFromPath(this.schema, Array.from(path), value);
    } else if (assertCollection(this.contents)) {
      this.contents.setIn(path, value);
    }
  }
  setSchema(version, options = {}) {
    if (typeof version === "number")
      version = String(version);
    let opt;
    switch (version) {
      case "1.1":
        if (this.directives)
          this.directives.yaml.version = "1.1";
        else
          this.directives = new Directives({ version: "1.1" });
        opt = { resolveKnownTags: false, schema: "yaml-1.1" };
        break;
      case "1.2":
      case "next":
        if (this.directives)
          this.directives.yaml.version = version;
        else
          this.directives = new Directives({ version });
        opt = { resolveKnownTags: true, schema: "core" };
        break;
      case null:
        if (this.directives)
          delete this.directives;
        opt = null;
        break;
      default: {
        const sv = JSON.stringify(version);
        throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
      }
    }
    if (options.schema instanceof Object)
      this.schema = options.schema;
    else if (opt)
      this.schema = new Schema(Object.assign(opt, options));
    else
      throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
  }
  toJS({ json, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
    const ctx = {
      anchors: new Map,
      doc: this,
      keep: !json,
      mapAsMap: mapAsMap === true,
      mapKeyWarned: false,
      maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
    };
    const res = toJS(this.contents, jsonArg ?? "", ctx);
    if (typeof onAnchor === "function")
      for (const { count, res } of ctx.anchors.values())
        onAnchor(res, count);
    return typeof reviver === "function" ? applyReviver(reviver, { "": res }, "", res) : res;
  }
  toJSON(jsonArg, onAnchor) {
    return this.toJS({ json: true, jsonArg, mapAsMap: false, onAnchor });
  }
  toString(options = {}) {
    if (this.errors.length > 0)
      throw new Error("Document with errors cannot be stringified");
    if ("indent" in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
      const s = JSON.stringify(options.indent);
      throw new Error(`"indent" option must be a positive integer, not ${s}`);
    }
    return stringifyDocument(this, options);
  }
}
function assertCollection(contents) {
  if (isCollection(contents))
    return true;
  throw new Error("Expected a YAML collection as document contents");
}

// node_modules/yaml/browser/dist/errors.js
class YAMLError extends Error {
  constructor(name, pos, code, message) {
    super();
    this.name = name;
    this.code = code;
    this.message = message;
    this.pos = pos;
  }
}

class YAMLParseError extends YAMLError {
  constructor(pos, code, message) {
    super("YAMLParseError", pos, code, message);
  }
}

class YAMLWarning extends YAMLError {
  constructor(pos, code, message) {
    super("YAMLWarning", pos, code, message);
  }
}
var prettifyError = (src, lc) => (error) => {
  if (error.pos[0] === -1)
    return;
  error.linePos = error.pos.map((pos) => lc.linePos(pos));
  const { line, col } = error.linePos[0];
  error.message += ` at line ${line}, column ${col}`;
  let ci = col - 1;
  let lineStr = src.substring(lc.lineStarts[line - 1], lc.lineStarts[line]).replace(/[\n\r]+$/, "");
  if (ci >= 60 && lineStr.length > 80) {
    const trimStart = Math.min(ci - 39, lineStr.length - 79);
    lineStr = "…" + lineStr.substring(trimStart);
    ci -= trimStart - 1;
  }
  if (lineStr.length > 80)
    lineStr = lineStr.substring(0, 79) + "…";
  if (line > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
    let prev = src.substring(lc.lineStarts[line - 2], lc.lineStarts[line - 1]);
    if (prev.length > 80)
      prev = prev.substring(0, 79) + `…
`;
    lineStr = prev + lineStr;
  }
  if (/[^ ]/.test(lineStr)) {
    let count = 1;
    const end = error.linePos[1];
    if (end?.line === line && end.col > col) {
      count = Math.max(1, Math.min(end.col - col, 80 - ci));
    }
    const pointer = " ".repeat(ci) + "^".repeat(count);
    error.message += `:

${lineStr}
${pointer}
`;
  }
};

// node_modules/yaml/browser/dist/compose/resolve-props.js
function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
  let spaceBefore = false;
  let atNewline = startOnNewline;
  let hasSpace = startOnNewline;
  let comment = "";
  let commentSep = "";
  let hasNewline = false;
  let reqSpace = false;
  let tab = null;
  let anchor = null;
  let tag = null;
  let newlineAfterProp = null;
  let comma = null;
  let found = null;
  let start = null;
  for (const token of tokens) {
    if (reqSpace) {
      if (token.type !== "space" && token.type !== "newline" && token.type !== "comma")
        onError(token.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
      reqSpace = false;
    }
    if (tab) {
      if (atNewline && token.type !== "comment" && token.type !== "newline") {
        onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
      }
      tab = null;
    }
    switch (token.type) {
      case "space":
        if (!flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token.source.includes("\t")) {
          tab = token;
        }
        hasSpace = true;
        break;
      case "comment": {
        if (!hasSpace)
          onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
        const cb = token.source.substring(1) || " ";
        if (!comment)
          comment = cb;
        else
          comment += commentSep + cb;
        commentSep = "";
        atNewline = false;
        break;
      }
      case "newline":
        if (atNewline) {
          if (comment)
            comment += token.source;
          else if (!found || indicator !== "seq-item-ind")
            spaceBefore = true;
        } else
          commentSep += token.source;
        atNewline = true;
        hasNewline = true;
        if (anchor || tag)
          newlineAfterProp = token;
        hasSpace = true;
        break;
      case "anchor":
        if (anchor)
          onError(token, "MULTIPLE_ANCHORS", "A node can have at most one anchor");
        if (token.source.endsWith(":"))
          onError(token.offset + token.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", true);
        anchor = token;
        start ?? (start = token.offset);
        atNewline = false;
        hasSpace = false;
        reqSpace = true;
        break;
      case "tag": {
        if (tag)
          onError(token, "MULTIPLE_TAGS", "A node can have at most one tag");
        tag = token;
        start ?? (start = token.offset);
        atNewline = false;
        hasSpace = false;
        reqSpace = true;
        break;
      }
      case indicator:
        if (anchor || tag)
          onError(token, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token.source} indicator`);
        if (found)
          onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.source} in ${flow ?? "collection"}`);
        found = token;
        atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
        hasSpace = false;
        break;
      case "comma":
        if (flow) {
          if (comma)
            onError(token, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`);
          comma = token;
          atNewline = false;
          hasSpace = false;
          break;
        }
      default:
        onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.type} token`);
        atNewline = false;
        hasSpace = false;
    }
  }
  const last = tokens[tokens.length - 1];
  const end = last ? last.offset + last.source.length : offset;
  if (reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "")) {
    onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
  }
  if (tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq"))
    onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
  return {
    comma,
    found,
    spaceBefore,
    comment,
    hasNewline,
    anchor,
    tag,
    newlineAfterProp,
    end,
    start: start ?? end
  };
}

// node_modules/yaml/browser/dist/compose/util-contains-newline.js
function containsNewline(key) {
  if (!key)
    return null;
  switch (key.type) {
    case "alias":
    case "scalar":
    case "double-quoted-scalar":
    case "single-quoted-scalar":
      if (key.source.includes(`
`))
        return true;
      if (key.end) {
        for (const st of key.end)
          if (st.type === "newline")
            return true;
      }
      return false;
    case "flow-collection":
      for (const it of key.items) {
        for (const st of it.start)
          if (st.type === "newline")
            return true;
        if (it.sep) {
          for (const st of it.sep)
            if (st.type === "newline")
              return true;
        }
        if (containsNewline(it.key) || containsNewline(it.value))
          return true;
      }
      return false;
    default:
      return true;
  }
}

// node_modules/yaml/browser/dist/compose/util-flow-indent-check.js
function flowIndentCheck(indent, fc, onError) {
  if (fc?.type === "flow-collection") {
    const end = fc.end[0];
    if (end.indent === indent && (end.source === "]" || end.source === "}") && containsNewline(fc)) {
      const msg = "Flow end indicator should be more indented than parent";
      onError(end, "BAD_INDENT", msg, true);
    }
  }
}

// node_modules/yaml/browser/dist/compose/util-map-includes.js
function mapIncludes(ctx, items, search) {
  const { uniqueKeys } = ctx.options;
  if (uniqueKeys === false)
    return false;
  const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || isScalar(a) && isScalar(b) && a.value === b.value;
  return items.some((pair) => isEqual(pair.key, search));
}

// node_modules/yaml/browser/dist/compose/resolve-block-map.js
var startColMsg = "All mapping items must start at the same column";
function resolveBlockMap({ composeNode, composeEmptyNode }, ctx, bm, onError, tag) {
  const NodeClass = tag?.nodeClass ?? YAMLMap;
  const map = new NodeClass(ctx.schema);
  if (ctx.atRoot)
    ctx.atRoot = false;
  let offset = bm.offset;
  let commentEnd = null;
  for (const collItem of bm.items) {
    const { start, key, sep, value } = collItem;
    const keyProps = resolveProps(start, {
      indicator: "explicit-key-ind",
      next: key ?? sep?.[0],
      offset,
      onError,
      parentIndent: bm.indent,
      startOnNewline: true
    });
    const implicitKey = !keyProps.found;
    if (implicitKey) {
      if (key) {
        if (key.type === "block-seq")
          onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
        else if ("indent" in key && key.indent !== bm.indent)
          onError(offset, "BAD_INDENT", startColMsg);
      }
      if (!keyProps.anchor && !keyProps.tag && !sep) {
        commentEnd = keyProps.end;
        if (keyProps.comment) {
          if (map.comment)
            map.comment += `
` + keyProps.comment;
          else
            map.comment = keyProps.comment;
        }
        continue;
      }
      if (keyProps.newlineAfterProp || containsNewline(key)) {
        onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
      }
    } else if (keyProps.found?.indent !== bm.indent) {
      onError(offset, "BAD_INDENT", startColMsg);
    }
    ctx.atKey = true;
    const keyStart = keyProps.end;
    const keyNode = key ? composeNode(ctx, key, keyProps, onError) : composeEmptyNode(ctx, keyStart, start, null, keyProps, onError);
    if (ctx.schema.compat)
      flowIndentCheck(bm.indent, key, onError);
    ctx.atKey = false;
    if (mapIncludes(ctx, map.items, keyNode))
      onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
    const valueProps = resolveProps(sep ?? [], {
      indicator: "map-value-ind",
      next: value,
      offset: keyNode.range[2],
      onError,
      parentIndent: bm.indent,
      startOnNewline: !key || key.type === "block-scalar"
    });
    offset = valueProps.end;
    if (valueProps.found) {
      if (implicitKey) {
        if (value?.type === "block-map" && !valueProps.hasNewline)
          onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
        if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024)
          onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
      }
      const valueNode = value ? composeNode(ctx, value, valueProps, onError) : composeEmptyNode(ctx, offset, sep, null, valueProps, onError);
      if (ctx.schema.compat)
        flowIndentCheck(bm.indent, value, onError);
      offset = valueNode.range[2];
      const pair = new Pair(keyNode, valueNode);
      if (ctx.options.keepSourceTokens)
        pair.srcToken = collItem;
      map.items.push(pair);
    } else {
      if (implicitKey)
        onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values");
      if (valueProps.comment) {
        if (keyNode.comment)
          keyNode.comment += `
` + valueProps.comment;
        else
          keyNode.comment = valueProps.comment;
      }
      const pair = new Pair(keyNode);
      if (ctx.options.keepSourceTokens)
        pair.srcToken = collItem;
      map.items.push(pair);
    }
  }
  if (commentEnd && commentEnd < offset)
    onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
  map.range = [bm.offset, offset, commentEnd ?? offset];
  return map;
}

// node_modules/yaml/browser/dist/compose/resolve-block-seq.js
function resolveBlockSeq({ composeNode, composeEmptyNode }, ctx, bs, onError, tag) {
  const NodeClass = tag?.nodeClass ?? YAMLSeq;
  const seq = new NodeClass(ctx.schema);
  if (ctx.atRoot)
    ctx.atRoot = false;
  if (ctx.atKey)
    ctx.atKey = false;
  let offset = bs.offset;
  let commentEnd = null;
  for (const { start, value } of bs.items) {
    const props = resolveProps(start, {
      indicator: "seq-item-ind",
      next: value,
      offset,
      onError,
      parentIndent: bs.indent,
      startOnNewline: true
    });
    if (!props.found) {
      if (props.anchor || props.tag || value) {
        if (value?.type === "block-seq")
          onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
        else
          onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
      } else {
        commentEnd = props.end;
        if (props.comment)
          seq.comment = props.comment;
        continue;
      }
    }
    const node = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
    if (ctx.schema.compat)
      flowIndentCheck(bs.indent, value, onError);
    offset = node.range[2];
    seq.items.push(node);
  }
  seq.range = [bs.offset, offset, commentEnd ?? offset];
  return seq;
}

// node_modules/yaml/browser/dist/compose/resolve-end.js
function resolveEnd(end, offset, reqSpace, onError) {
  let comment = "";
  if (end) {
    let hasSpace = false;
    let sep = "";
    for (const token of end) {
      const { source, type } = token;
      switch (type) {
        case "space":
          hasSpace = true;
          break;
        case "comment": {
          if (reqSpace && !hasSpace)
            onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
          const cb = source.substring(1) || " ";
          if (!comment)
            comment = cb;
          else
            comment += sep + cb;
          sep = "";
          break;
        }
        case "newline":
          if (comment)
            sep += source;
          hasSpace = true;
          break;
        default:
          onError(token, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
      }
      offset += source.length;
    }
  }
  return { comment, offset };
}

// node_modules/yaml/browser/dist/compose/resolve-flow-collection.js
var blockMsg = "Block collections are not allowed within flow collections";
var isBlock = (token) => token && (token.type === "block-map" || token.type === "block-seq");
function resolveFlowCollection({ composeNode, composeEmptyNode }, ctx, fc, onError, tag) {
  const isMap = fc.start.source === "{";
  const fcName = isMap ? "flow map" : "flow sequence";
  const NodeClass = tag?.nodeClass ?? (isMap ? YAMLMap : YAMLSeq);
  const coll = new NodeClass(ctx.schema);
  coll.flow = true;
  const atRoot = ctx.atRoot;
  if (atRoot)
    ctx.atRoot = false;
  if (ctx.atKey)
    ctx.atKey = false;
  let offset = fc.offset + fc.start.source.length;
  for (let i = 0;i < fc.items.length; ++i) {
    const collItem = fc.items[i];
    const { start, key, sep, value } = collItem;
    const props = resolveProps(start, {
      flow: fcName,
      indicator: "explicit-key-ind",
      next: key ?? sep?.[0],
      offset,
      onError,
      parentIndent: fc.indent,
      startOnNewline: false
    });
    if (!props.found) {
      if (!props.anchor && !props.tag && !sep && !value) {
        if (i === 0 && props.comma)
          onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
        else if (i < fc.items.length - 1)
          onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`);
        if (props.comment) {
          if (coll.comment)
            coll.comment += `
` + props.comment;
          else
            coll.comment = props.comment;
        }
        offset = props.end;
        continue;
      }
      if (!isMap && ctx.options.strict && containsNewline(key))
        onError(key, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
    }
    if (i === 0) {
      if (props.comma)
        onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
    } else {
      if (!props.comma)
        onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`);
      if (props.comment) {
        let prevItemComment = "";
        loop:
          for (const st of start) {
            switch (st.type) {
              case "comma":
              case "space":
                break;
              case "comment":
                prevItemComment = st.source.substring(1);
                break loop;
              default:
                break loop;
            }
          }
        if (prevItemComment) {
          let prev = coll.items[coll.items.length - 1];
          if (isPair(prev))
            prev = prev.value ?? prev.key;
          if (prev.comment)
            prev.comment += `
` + prevItemComment;
          else
            prev.comment = prevItemComment;
          props.comment = props.comment.substring(prevItemComment.length + 1);
        }
      }
    }
    if (!isMap && !sep && !props.found) {
      const valueNode = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, sep, null, props, onError);
      coll.items.push(valueNode);
      offset = valueNode.range[2];
      if (isBlock(value))
        onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
    } else {
      ctx.atKey = true;
      const keyStart = props.end;
      const keyNode = key ? composeNode(ctx, key, props, onError) : composeEmptyNode(ctx, keyStart, start, null, props, onError);
      if (isBlock(key))
        onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
      ctx.atKey = false;
      const valueProps = resolveProps(sep ?? [], {
        flow: fcName,
        indicator: "map-value-ind",
        next: value,
        offset: keyNode.range[2],
        onError,
        parentIndent: fc.indent,
        startOnNewline: false
      });
      if (valueProps.found) {
        if (!isMap && !props.found && ctx.options.strict) {
          if (sep)
            for (const st of sep) {
              if (st === valueProps.found)
                break;
              if (st.type === "newline") {
                onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
                break;
              }
            }
          if (props.start < valueProps.found.offset - 1024)
            onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
        }
      } else if (value) {
        if ("source" in value && value.source?.[0] === ":")
          onError(value, "MISSING_CHAR", `Missing space after : in ${fcName}`);
        else
          onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`);
      }
      const valueNode = value ? composeNode(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode(ctx, valueProps.end, sep, null, valueProps, onError) : null;
      if (valueNode) {
        if (isBlock(value))
          onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
      } else if (valueProps.comment) {
        if (keyNode.comment)
          keyNode.comment += `
` + valueProps.comment;
        else
          keyNode.comment = valueProps.comment;
      }
      const pair = new Pair(keyNode, valueNode);
      if (ctx.options.keepSourceTokens)
        pair.srcToken = collItem;
      if (isMap) {
        const map = coll;
        if (mapIncludes(ctx, map.items, keyNode))
          onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
        map.items.push(pair);
      } else {
        const map = new YAMLMap(ctx.schema);
        map.flow = true;
        map.items.push(pair);
        const endRange = (valueNode ?? keyNode).range;
        map.range = [keyNode.range[0], endRange[1], endRange[2]];
        coll.items.push(map);
      }
      offset = valueNode ? valueNode.range[2] : valueProps.end;
    }
  }
  const expectedEnd = isMap ? "}" : "]";
  const [ce, ...ee] = fc.end;
  let cePos = offset;
  if (ce?.source === expectedEnd)
    cePos = ce.offset + ce.source.length;
  else {
    const name = fcName[0].toUpperCase() + fcName.substring(1);
    const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
    onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
    if (ce && ce.source.length !== 1)
      ee.unshift(ce);
  }
  if (ee.length > 0) {
    const end = resolveEnd(ee, cePos, ctx.options.strict, onError);
    if (end.comment) {
      if (coll.comment)
        coll.comment += `
` + end.comment;
      else
        coll.comment = end.comment;
    }
    coll.range = [fc.offset, cePos, end.offset];
  } else {
    coll.range = [fc.offset, cePos, cePos];
  }
  return coll;
}

// node_modules/yaml/browser/dist/compose/compose-collection.js
function resolveCollection(CN, ctx, token, onError, tagName, tag) {
  const coll = token.type === "block-map" ? resolveBlockMap(CN, ctx, token, onError, tag) : token.type === "block-seq" ? resolveBlockSeq(CN, ctx, token, onError, tag) : resolveFlowCollection(CN, ctx, token, onError, tag);
  const Coll = coll.constructor;
  if (tagName === "!" || tagName === Coll.tagName) {
    coll.tag = Coll.tagName;
    return coll;
  }
  if (tagName)
    coll.tag = tagName;
  return coll;
}
function composeCollection(CN, ctx, token, props, onError) {
  const tagToken = props.tag;
  const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg));
  if (token.type === "block-seq") {
    const { anchor, newlineAfterProp: nl } = props;
    const lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
    if (lastProp && (!nl || nl.offset < lastProp.offset)) {
      const message = "Missing newline after block sequence props";
      onError(lastProp, "MISSING_CHAR", message);
    }
  }
  const expType = token.type === "block-map" ? "map" : token.type === "block-seq" ? "seq" : token.start.source === "{" ? "map" : "seq";
  if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap.tagName && expType === "map" || tagName === YAMLSeq.tagName && expType === "seq") {
    return resolveCollection(CN, ctx, token, onError, tagName);
  }
  let tag = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
  if (!tag) {
    const kt = ctx.schema.knownTags[tagName];
    if (kt?.collection === expType) {
      ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
      tag = kt;
    } else {
      if (kt) {
        onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, true);
      } else {
        onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, true);
      }
      return resolveCollection(CN, ctx, token, onError, tagName);
    }
  }
  const coll = resolveCollection(CN, ctx, token, onError, tagName, tag);
  const res = tag.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll;
  const node = isNode(res) ? res : new Scalar(res);
  node.range = coll.range;
  node.tag = tagName;
  if (tag?.format)
    node.format = tag.format;
  return node;
}

// node_modules/yaml/browser/dist/compose/resolve-block-scalar.js
function resolveBlockScalar(ctx, scalar, onError) {
  const start = scalar.offset;
  const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
  if (!header)
    return { value: "", type: null, comment: "", range: [start, start, start] };
  const type = header.mode === ">" ? Scalar.BLOCK_FOLDED : Scalar.BLOCK_LITERAL;
  const lines = scalar.source ? splitLines(scalar.source) : [];
  let chompStart = lines.length;
  for (let i = lines.length - 1;i >= 0; --i) {
    const content = lines[i][1];
    if (content === "" || content === "\r")
      chompStart = i;
    else
      break;
  }
  if (chompStart === 0) {
    const value = header.chomp === "+" && lines.length > 0 ? `
`.repeat(Math.max(1, lines.length - 1)) : "";
    let end = start + header.length;
    if (scalar.source)
      end += scalar.source.length;
    return { value, type, comment: header.comment, range: [start, end, end] };
  }
  let trimIndent = scalar.indent + header.indent;
  let offset = scalar.offset + header.length;
  let contentStart = 0;
  for (let i = 0;i < chompStart; ++i) {
    const [indent, content] = lines[i];
    if (content === "" || content === "\r") {
      if (header.indent === 0 && indent.length > trimIndent)
        trimIndent = indent.length;
    } else {
      if (indent.length < trimIndent) {
        const message = "Block scalars with more-indented leading empty lines must use an explicit indentation indicator";
        onError(offset + indent.length, "MISSING_CHAR", message);
      }
      if (header.indent === 0)
        trimIndent = indent.length;
      contentStart = i;
      if (trimIndent === 0 && !ctx.atRoot) {
        const message = "Block scalar values in collections must be indented";
        onError(offset, "BAD_INDENT", message);
      }
      break;
    }
    offset += indent.length + content.length + 1;
  }
  for (let i = lines.length - 1;i >= chompStart; --i) {
    if (lines[i][0].length > trimIndent)
      chompStart = i + 1;
  }
  let value = "";
  let sep = "";
  let prevMoreIndented = false;
  for (let i = 0;i < contentStart; ++i)
    value += lines[i][0].slice(trimIndent) + `
`;
  for (let i = contentStart;i < chompStart; ++i) {
    let [indent, content] = lines[i];
    offset += indent.length + content.length + 1;
    const crlf = content[content.length - 1] === "\r";
    if (crlf)
      content = content.slice(0, -1);
    if (content && indent.length < trimIndent) {
      const src = header.indent ? "explicit indentation indicator" : "first line";
      const message = `Block scalar lines must not be less indented than their ${src}`;
      onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message);
      indent = "";
    }
    if (type === Scalar.BLOCK_LITERAL) {
      value += sep + indent.slice(trimIndent) + content;
      sep = `
`;
    } else if (indent.length > trimIndent || content[0] === "\t") {
      if (sep === " ")
        sep = `
`;
      else if (!prevMoreIndented && sep === `
`)
        sep = `

`;
      value += sep + indent.slice(trimIndent) + content;
      sep = `
`;
      prevMoreIndented = true;
    } else if (content === "") {
      if (sep === `
`)
        value += `
`;
      else
        sep = `
`;
    } else {
      value += sep + content;
      sep = " ";
      prevMoreIndented = false;
    }
  }
  switch (header.chomp) {
    case "-":
      break;
    case "+":
      for (let i = chompStart;i < lines.length; ++i)
        value += `
` + lines[i][0].slice(trimIndent);
      if (value[value.length - 1] !== `
`)
        value += `
`;
      break;
    default:
      value += `
`;
  }
  const end = start + header.length + scalar.source.length;
  return { value, type, comment: header.comment, range: [start, end, end] };
}
function parseBlockScalarHeader({ offset, props }, strict, onError) {
  if (props[0].type !== "block-scalar-header") {
    onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
    return null;
  }
  const { source } = props[0];
  const mode = source[0];
  let indent = 0;
  let chomp = "";
  let error = -1;
  for (let i = 1;i < source.length; ++i) {
    const ch = source[i];
    if (!chomp && (ch === "-" || ch === "+"))
      chomp = ch;
    else {
      const n = Number(ch);
      if (!indent && n)
        indent = n;
      else if (error === -1)
        error = offset + i;
    }
  }
  if (error !== -1)
    onError(error, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
  let hasSpace = false;
  let comment = "";
  let length = source.length;
  for (let i = 1;i < props.length; ++i) {
    const token = props[i];
    switch (token.type) {
      case "space":
        hasSpace = true;
      case "newline":
        length += token.source.length;
        break;
      case "comment":
        if (strict && !hasSpace) {
          const message = "Comments must be separated from other tokens by white space characters";
          onError(token, "MISSING_CHAR", message);
        }
        length += token.source.length;
        comment = token.source.substring(1);
        break;
      case "error":
        onError(token, "UNEXPECTED_TOKEN", token.message);
        length += token.source.length;
        break;
      default: {
        const message = `Unexpected token in block scalar header: ${token.type}`;
        onError(token, "UNEXPECTED_TOKEN", message);
        const ts = token.source;
        if (ts && typeof ts === "string")
          length += ts.length;
      }
    }
  }
  return { mode, indent, chomp, comment, length };
}
function splitLines(source) {
  const split = source.split(/\n( *)/);
  const first = split[0];
  const m = first.match(/^( *)/);
  const line0 = m?.[1] ? [m[1], first.slice(m[1].length)] : ["", first];
  const lines = [line0];
  for (let i = 1;i < split.length; i += 2)
    lines.push([split[i], split[i + 1]]);
  return lines;
}

// node_modules/yaml/browser/dist/compose/resolve-flow-scalar.js
function resolveFlowScalar(scalar, strict, onError) {
  const { offset, type, source, end } = scalar;
  let _type;
  let value;
  const _onError = (rel, code, msg) => onError(offset + rel, code, msg);
  switch (type) {
    case "scalar":
      _type = Scalar.PLAIN;
      value = plainValue(source, _onError);
      break;
    case "single-quoted-scalar":
      _type = Scalar.QUOTE_SINGLE;
      value = singleQuotedValue(source, _onError);
      break;
    case "double-quoted-scalar":
      _type = Scalar.QUOTE_DOUBLE;
      value = doubleQuotedValue(source, _onError);
      break;
    default:
      onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`);
      return {
        value: "",
        type: null,
        comment: "",
        range: [offset, offset + source.length, offset + source.length]
      };
  }
  const valueEnd = offset + source.length;
  const re = resolveEnd(end, valueEnd, strict, onError);
  return {
    value,
    type: _type,
    comment: re.comment,
    range: [offset, valueEnd, re.offset]
  };
}
function plainValue(source, onError) {
  let badChar = "";
  switch (source[0]) {
    case "\t":
      badChar = "a tab character";
      break;
    case ",":
      badChar = "flow indicator character ,";
      break;
    case "%":
      badChar = "directive indicator character %";
      break;
    case "|":
    case ">": {
      badChar = `block scalar indicator ${source[0]}`;
      break;
    }
    case "@":
    case "`": {
      badChar = `reserved character ${source[0]}`;
      break;
    }
  }
  if (badChar)
    onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`);
  return foldLines(source);
}
function singleQuotedValue(source, onError) {
  if (source[source.length - 1] !== "'" || source.length === 1)
    onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
  return foldLines(source.slice(1, -1)).replace(/''/g, "'");
}
function foldLines(source) {
  let first, line;
  try {
    first = new RegExp(`(.*?)(?<![ 	])[ 	]*\r?
`, "sy");
    line = new RegExp(`[ 	]*(.*?)(?:(?<![ 	])[ 	]*)?\r?
`, "sy");
  } catch {
    first = /(.*?)[ \t]*\r?\n/sy;
    line = /[ \t]*(.*?)[ \t]*\r?\n/sy;
  }
  let match = first.exec(source);
  if (!match)
    return source;
  let res = match[1];
  let sep = " ";
  let pos = first.lastIndex;
  line.lastIndex = pos;
  while (match = line.exec(source)) {
    if (match[1] === "") {
      if (sep === `
`)
        res += sep;
      else
        sep = `
`;
    } else {
      res += sep + match[1];
      sep = " ";
    }
    pos = line.lastIndex;
  }
  const last = /[ \t]*(.*)/sy;
  last.lastIndex = pos;
  match = last.exec(source);
  return res + sep + (match?.[1] ?? "");
}
function doubleQuotedValue(source, onError) {
  let res = "";
  for (let i = 1;i < source.length - 1; ++i) {
    const ch = source[i];
    if (ch === "\r" && source[i + 1] === `
`)
      continue;
    if (ch === `
`) {
      const { fold, offset } = foldNewline(source, i);
      res += fold;
      i = offset;
    } else if (ch === "\\") {
      let next = source[++i];
      const cc = escapeCodes[next];
      if (cc)
        res += cc;
      else if (next === `
`) {
        next = source[i + 1];
        while (next === " " || next === "\t")
          next = source[++i + 1];
      } else if (next === "\r" && source[i + 1] === `
`) {
        next = source[++i + 1];
        while (next === " " || next === "\t")
          next = source[++i + 1];
      } else if (next === "x" || next === "u" || next === "U") {
        const length = { x: 2, u: 4, U: 8 }[next];
        res += parseCharCode(source, i + 1, length, onError);
        i += length;
      } else {
        const raw = source.substr(i - 1, 2);
        onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
        res += raw;
      }
    } else if (ch === " " || ch === "\t") {
      const wsStart = i;
      let next = source[i + 1];
      while (next === " " || next === "\t")
        next = source[++i + 1];
      if (next !== `
` && !(next === "\r" && source[i + 2] === `
`))
        res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
    } else {
      res += ch;
    }
  }
  if (source[source.length - 1] !== '"' || source.length === 1)
    onError(source.length, "MISSING_CHAR", 'Missing closing "quote');
  return res;
}
function foldNewline(source, offset) {
  let fold = "";
  let ch = source[offset + 1];
  while (ch === " " || ch === "\t" || ch === `
` || ch === "\r") {
    if (ch === "\r" && source[offset + 2] !== `
`)
      break;
    if (ch === `
`)
      fold += `
`;
    offset += 1;
    ch = source[offset + 1];
  }
  if (!fold)
    fold = " ";
  return { fold, offset };
}
var escapeCodes = {
  "0": "\x00",
  a: "\x07",
  b: "\b",
  e: "\x1B",
  f: "\f",
  n: `
`,
  r: "\r",
  t: "\t",
  v: "\v",
  N: "",
  _: " ",
  L: "\u2028",
  P: "\u2029",
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  "\t": "\t"
};
function parseCharCode(source, offset, length, onError) {
  const cc = source.substr(offset, length);
  const ok = cc.length === length && /^[0-9a-fA-F]+$/.test(cc);
  const code = ok ? parseInt(cc, 16) : NaN;
  if (isNaN(code)) {
    const raw = source.substr(offset - 2, length + 2);
    onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
    return raw;
  }
  return String.fromCodePoint(code);
}

// node_modules/yaml/browser/dist/compose/compose-scalar.js
function composeScalar(ctx, token, tagToken, onError) {
  const { value, type, comment, range } = token.type === "block-scalar" ? resolveBlockScalar(ctx, token, onError) : resolveFlowScalar(token, ctx.options.strict, onError);
  const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
  let tag;
  if (ctx.options.stringKeys && ctx.atKey) {
    tag = ctx.schema[SCALAR];
  } else if (tagName)
    tag = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError);
  else if (token.type === "scalar")
    tag = findScalarTagByTest(ctx, value, token, onError);
  else
    tag = ctx.schema[SCALAR];
  let scalar;
  try {
    const res = tag.resolve(value, (msg) => onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg), ctx.options);
    scalar = isScalar(res) ? res : new Scalar(res);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg);
    scalar = new Scalar(value);
  }
  scalar.range = range;
  scalar.source = value;
  if (type)
    scalar.type = type;
  if (tagName)
    scalar.tag = tagName;
  if (tag.format)
    scalar.format = tag.format;
  if (comment)
    scalar.comment = comment;
  return scalar;
}
function findScalarTagByName(schema, value, tagName, tagToken, onError) {
  if (tagName === "!")
    return schema[SCALAR];
  const matchWithTest = [];
  for (const tag of schema.tags) {
    if (!tag.collection && tag.tag === tagName) {
      if (tag.default && tag.test)
        matchWithTest.push(tag);
      else
        return tag;
    }
  }
  for (const tag of matchWithTest)
    if (tag.test?.test(value))
      return tag;
  const kt = schema.knownTags[tagName];
  if (kt && !kt.collection) {
    schema.tags.push(Object.assign({}, kt, { default: false, test: undefined }));
    return kt;
  }
  onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str");
  return schema[SCALAR];
}
function findScalarTagByTest({ atKey, directives, schema }, value, token, onError) {
  const tag = schema.tags.find((tag) => (tag.default === true || atKey && tag.default === "key") && tag.test?.test(value)) || schema[SCALAR];
  if (schema.compat) {
    const compat = schema.compat.find((tag) => tag.default && tag.test?.test(value)) ?? schema[SCALAR];
    if (tag.tag !== compat.tag) {
      const ts = directives.tagString(tag.tag);
      const cs = directives.tagString(compat.tag);
      const msg = `Value may be parsed as either ${ts} or ${cs}`;
      onError(token, "TAG_RESOLVE_FAILED", msg, true);
    }
  }
  return tag;
}

// node_modules/yaml/browser/dist/compose/util-empty-scalar-position.js
function emptyScalarPosition(offset, before, pos) {
  if (before) {
    pos ?? (pos = before.length);
    for (let i = pos - 1;i >= 0; --i) {
      let st = before[i];
      switch (st.type) {
        case "space":
        case "comment":
        case "newline":
          offset -= st.source.length;
          continue;
      }
      st = before[++i];
      while (st?.type === "space") {
        offset += st.source.length;
        st = before[++i];
      }
      break;
    }
  }
  return offset;
}

// node_modules/yaml/browser/dist/compose/compose-node.js
var CN = { composeNode, composeEmptyNode };
function composeNode(ctx, token, props, onError) {
  const atKey = ctx.atKey;
  const { spaceBefore, comment, anchor, tag } = props;
  let node;
  let isSrcToken = true;
  switch (token.type) {
    case "alias":
      node = composeAlias(ctx, token, onError);
      if (anchor || tag)
        onError(token, "ALIAS_PROPS", "An alias node must not specify any properties");
      break;
    case "scalar":
    case "single-quoted-scalar":
    case "double-quoted-scalar":
    case "block-scalar":
      node = composeScalar(ctx, token, tag, onError);
      if (anchor)
        node.anchor = anchor.source.substring(1);
      break;
    case "block-map":
    case "block-seq":
    case "flow-collection":
      node = composeCollection(CN, ctx, token, props, onError);
      if (anchor)
        node.anchor = anchor.source.substring(1);
      break;
    default: {
      const message = token.type === "error" ? token.message : `Unsupported token (type: ${token.type})`;
      onError(token, "UNEXPECTED_TOKEN", message);
      node = composeEmptyNode(ctx, token.offset, undefined, null, props, onError);
      isSrcToken = false;
    }
  }
  if (anchor && node.anchor === "")
    onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
  if (atKey && ctx.options.stringKeys && (!isScalar(node) || typeof node.value !== "string" || node.tag && node.tag !== "tag:yaml.org,2002:str")) {
    const msg = "With stringKeys, all keys must be strings";
    onError(tag ?? token, "NON_STRING_KEY", msg);
  }
  if (spaceBefore)
    node.spaceBefore = true;
  if (comment) {
    if (token.type === "scalar" && token.source === "")
      node.comment = comment;
    else
      node.commentBefore = comment;
  }
  if (ctx.options.keepSourceTokens && isSrcToken)
    node.srcToken = token;
  return node;
}
function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
  const token = {
    type: "scalar",
    offset: emptyScalarPosition(offset, before, pos),
    indent: -1,
    source: ""
  };
  const node = composeScalar(ctx, token, tag, onError);
  if (anchor) {
    node.anchor = anchor.source.substring(1);
    if (node.anchor === "")
      onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
  }
  if (spaceBefore)
    node.spaceBefore = true;
  if (comment) {
    node.comment = comment;
    node.range[2] = end;
  }
  return node;
}
function composeAlias({ options }, { offset, source, end }, onError) {
  const alias = new Alias(source.substring(1));
  if (alias.source === "")
    onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
  if (alias.source.endsWith(":"))
    onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
  const valueEnd = offset + source.length;
  const re = resolveEnd(end, valueEnd, options.strict, onError);
  alias.range = [offset, valueEnd, re.offset];
  if (re.comment)
    alias.comment = re.comment;
  return alias;
}

// node_modules/yaml/browser/dist/compose/compose-doc.js
function composeDoc(options, directives, { offset, start, value, end }, onError) {
  const opts = Object.assign({ _directives: directives }, options);
  const doc = new Document(undefined, opts);
  const ctx = {
    atKey: false,
    atRoot: true,
    directives: doc.directives,
    options: doc.options,
    schema: doc.schema
  };
  const props = resolveProps(start, {
    indicator: "doc-start",
    next: value ?? end?.[0],
    offset,
    onError,
    parentIndent: 0,
    startOnNewline: true
  });
  if (props.found) {
    doc.directives.docStart = true;
    if (value && (value.type === "block-map" || value.type === "block-seq") && !props.hasNewline)
      onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker");
  }
  doc.contents = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
  const contentEnd = doc.contents.range[2];
  const re = resolveEnd(end, contentEnd, false, onError);
  if (re.comment)
    doc.comment = re.comment;
  doc.range = [offset, contentEnd, re.offset];
  return doc;
}

// node_modules/yaml/browser/dist/compose/composer.js
function getErrorPos(src) {
  if (typeof src === "number")
    return [src, src + 1];
  if (Array.isArray(src))
    return src.length === 2 ? src : [src[0], src[1]];
  const { offset, source } = src;
  return [offset, offset + (typeof source === "string" ? source.length : 1)];
}
function parsePrelude(prelude) {
  let comment = "";
  let atComment = false;
  let afterEmptyLine = false;
  for (let i = 0;i < prelude.length; ++i) {
    const source = prelude[i];
    switch (source[0]) {
      case "#":
        comment += (comment === "" ? "" : afterEmptyLine ? `

` : `
`) + (source.substring(1) || " ");
        atComment = true;
        afterEmptyLine = false;
        break;
      case "%":
        if (prelude[i + 1]?.[0] !== "#")
          i += 1;
        atComment = false;
        break;
      default:
        if (!atComment)
          afterEmptyLine = true;
        atComment = false;
    }
  }
  return { comment, afterEmptyLine };
}

class Composer {
  constructor(options = {}) {
    this.doc = null;
    this.atDirectives = false;
    this.prelude = [];
    this.errors = [];
    this.warnings = [];
    this.onError = (source, code, message, warning) => {
      const pos = getErrorPos(source);
      if (warning)
        this.warnings.push(new YAMLWarning(pos, code, message));
      else
        this.errors.push(new YAMLParseError(pos, code, message));
    };
    this.directives = new Directives({ version: options.version || "1.2" });
    this.options = options;
  }
  decorate(doc, afterDoc) {
    const { comment, afterEmptyLine } = parsePrelude(this.prelude);
    if (comment) {
      const dc = doc.contents;
      if (afterDoc) {
        doc.comment = doc.comment ? `${doc.comment}
${comment}` : comment;
      } else if (afterEmptyLine || doc.directives.docStart || !dc) {
        doc.commentBefore = comment;
      } else if (isCollection(dc) && !dc.flow && dc.items.length > 0) {
        let it = dc.items[0];
        if (isPair(it))
          it = it.key;
        const cb = it.commentBefore;
        it.commentBefore = cb ? `${comment}
${cb}` : comment;
      } else {
        const cb = dc.commentBefore;
        dc.commentBefore = cb ? `${comment}
${cb}` : comment;
      }
    }
    if (afterDoc) {
      Array.prototype.push.apply(doc.errors, this.errors);
      Array.prototype.push.apply(doc.warnings, this.warnings);
    } else {
      doc.errors = this.errors;
      doc.warnings = this.warnings;
    }
    this.prelude = [];
    this.errors = [];
    this.warnings = [];
  }
  streamInfo() {
    return {
      comment: parsePrelude(this.prelude).comment,
      directives: this.directives,
      errors: this.errors,
      warnings: this.warnings
    };
  }
  *compose(tokens, forceDoc = false, endOffset = -1) {
    for (const token of tokens)
      yield* this.next(token);
    yield* this.end(forceDoc, endOffset);
  }
  *next(token) {
    switch (token.type) {
      case "directive":
        this.directives.add(token.source, (offset, message, warning) => {
          const pos = getErrorPos(token);
          pos[0] += offset;
          this.onError(pos, "BAD_DIRECTIVE", message, warning);
        });
        this.prelude.push(token.source);
        this.atDirectives = true;
        break;
      case "document": {
        const doc = composeDoc(this.options, this.directives, token, this.onError);
        if (this.atDirectives && !doc.directives.docStart)
          this.onError(token, "MISSING_CHAR", "Missing directives-end/doc-start indicator line");
        this.decorate(doc, false);
        if (this.doc)
          yield this.doc;
        this.doc = doc;
        this.atDirectives = false;
        break;
      }
      case "byte-order-mark":
      case "space":
        break;
      case "comment":
      case "newline":
        this.prelude.push(token.source);
        break;
      case "error": {
        const msg = token.source ? `${token.message}: ${JSON.stringify(token.source)}` : token.message;
        const error = new YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg);
        if (this.atDirectives || !this.doc)
          this.errors.push(error);
        else
          this.doc.errors.push(error);
        break;
      }
      case "doc-end": {
        if (!this.doc) {
          const msg = "Unexpected doc-end without preceding document";
          this.errors.push(new YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg));
          break;
        }
        this.doc.directives.docEnd = true;
        const end = resolveEnd(token.end, token.offset + token.source.length, this.doc.options.strict, this.onError);
        this.decorate(this.doc, true);
        if (end.comment) {
          const dc = this.doc.comment;
          this.doc.comment = dc ? `${dc}
${end.comment}` : end.comment;
        }
        this.doc.range[2] = end.offset;
        break;
      }
      default:
        this.errors.push(new YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", `Unsupported token ${token.type}`));
    }
  }
  *end(forceDoc = false, endOffset = -1) {
    if (this.doc) {
      this.decorate(this.doc, true);
      yield this.doc;
      this.doc = null;
    } else if (forceDoc) {
      const opts = Object.assign({ _directives: this.directives }, this.options);
      const doc = new Document(undefined, opts);
      if (this.atDirectives)
        this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line");
      doc.range = [0, endOffset, endOffset];
      this.decorate(doc, false);
      yield doc;
    }
  }
}
// node_modules/yaml/browser/dist/parse/cst-visit.js
var BREAK2 = Symbol("break visit");
var SKIP2 = Symbol("skip children");
var REMOVE2 = Symbol("remove item");
function visit2(cst, visitor) {
  if ("type" in cst && cst.type === "document")
    cst = { start: cst.start, value: cst.value };
  _visit(Object.freeze([]), cst, visitor);
}
visit2.BREAK = BREAK2;
visit2.SKIP = SKIP2;
visit2.REMOVE = REMOVE2;
visit2.itemAtPath = (cst, path) => {
  let item = cst;
  for (const [field, index] of path) {
    const tok = item?.[field];
    if (tok && "items" in tok) {
      item = tok.items[index];
    } else
      return;
  }
  return item;
};
visit2.parentCollection = (cst, path) => {
  const parent = visit2.itemAtPath(cst, path.slice(0, -1));
  const field = path[path.length - 1][0];
  const coll = parent?.[field];
  if (coll && "items" in coll)
    return coll;
  throw new Error("Parent collection not found");
};
function _visit(path, item, visitor) {
  let ctrl = visitor(item, path);
  if (typeof ctrl === "symbol")
    return ctrl;
  for (const field of ["key", "value"]) {
    const token = item[field];
    if (token && "items" in token) {
      for (let i = 0;i < token.items.length; ++i) {
        const ci = _visit(Object.freeze(path.concat([[field, i]])), token.items[i], visitor);
        if (typeof ci === "number")
          i = ci - 1;
        else if (ci === BREAK2)
          return BREAK2;
        else if (ci === REMOVE2) {
          token.items.splice(i, 1);
          i -= 1;
        }
      }
      if (typeof ctrl === "function" && field === "key")
        ctrl = ctrl(item, path);
    }
  }
  return typeof ctrl === "function" ? ctrl(item, path) : ctrl;
}

// node_modules/yaml/browser/dist/parse/cst.js
var BOM = "\uFEFF";
var DOCUMENT = "\x02";
var FLOW_END = "\x18";
var SCALAR2 = "\x1F";
function tokenType(source) {
  switch (source) {
    case BOM:
      return "byte-order-mark";
    case DOCUMENT:
      return "doc-mode";
    case FLOW_END:
      return "flow-error-end";
    case SCALAR2:
      return "scalar";
    case "---":
      return "doc-start";
    case "...":
      return "doc-end";
    case "":
    case `
`:
    case `\r
`:
      return "newline";
    case "-":
      return "seq-item-ind";
    case "?":
      return "explicit-key-ind";
    case ":":
      return "map-value-ind";
    case "{":
      return "flow-map-start";
    case "}":
      return "flow-map-end";
    case "[":
      return "flow-seq-start";
    case "]":
      return "flow-seq-end";
    case ",":
      return "comma";
  }
  switch (source[0]) {
    case " ":
    case "\t":
      return "space";
    case "#":
      return "comment";
    case "%":
      return "directive-line";
    case "*":
      return "alias";
    case "&":
      return "anchor";
    case "!":
      return "tag";
    case "'":
      return "single-quoted-scalar";
    case '"':
      return "double-quoted-scalar";
    case "|":
    case ">":
      return "block-scalar-header";
  }
  return null;
}

// node_modules/yaml/browser/dist/parse/lexer.js
function isEmpty(ch) {
  switch (ch) {
    case undefined:
    case " ":
    case `
`:
    case "\r":
    case "\t":
      return true;
    default:
      return false;
  }
}
var hexDigits = new Set("0123456789ABCDEFabcdef");
var tagChars = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
var flowIndicatorChars = new Set(",[]{}");
var invalidAnchorChars = new Set(` ,[]{}
\r	`);
var isNotAnchorChar = (ch) => !ch || invalidAnchorChars.has(ch);

class Lexer {
  constructor() {
    this.atEnd = false;
    this.blockScalarIndent = -1;
    this.blockScalarKeep = false;
    this.buffer = "";
    this.flowKey = false;
    this.flowLevel = 0;
    this.indentNext = 0;
    this.indentValue = 0;
    this.lineEndPos = null;
    this.next = null;
    this.pos = 0;
  }
  *lex(source, incomplete = false) {
    if (source) {
      if (typeof source !== "string")
        throw TypeError("source is not a string");
      this.buffer = this.buffer ? this.buffer + source : source;
      this.lineEndPos = null;
    }
    this.atEnd = !incomplete;
    let next = this.next ?? "stream";
    while (next && (incomplete || this.hasChars(1)))
      next = yield* this.parseNext(next);
  }
  atLineEnd() {
    let i = this.pos;
    let ch = this.buffer[i];
    while (ch === " " || ch === "\t")
      ch = this.buffer[++i];
    if (!ch || ch === "#" || ch === `
`)
      return true;
    if (ch === "\r")
      return this.buffer[i + 1] === `
`;
    return false;
  }
  charAt(n) {
    return this.buffer[this.pos + n];
  }
  continueScalar(offset) {
    let ch = this.buffer[offset];
    if (this.indentNext > 0) {
      let indent = 0;
      while (ch === " ")
        ch = this.buffer[++indent + offset];
      if (ch === "\r") {
        const next = this.buffer[indent + offset + 1];
        if (next === `
` || !next && !this.atEnd)
          return offset + indent + 1;
      }
      return ch === `
` || indent >= this.indentNext || !ch && !this.atEnd ? offset + indent : -1;
    }
    if (ch === "-" || ch === ".") {
      const dt = this.buffer.substr(offset, 3);
      if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3]))
        return -1;
    }
    return offset;
  }
  getLine() {
    let end = this.lineEndPos;
    if (typeof end !== "number" || end !== -1 && end < this.pos) {
      end = this.buffer.indexOf(`
`, this.pos);
      this.lineEndPos = end;
    }
    if (end === -1)
      return this.atEnd ? this.buffer.substring(this.pos) : null;
    if (this.buffer[end - 1] === "\r")
      end -= 1;
    return this.buffer.substring(this.pos, end);
  }
  hasChars(n) {
    return this.pos + n <= this.buffer.length;
  }
  setNext(state) {
    this.buffer = this.buffer.substring(this.pos);
    this.pos = 0;
    this.lineEndPos = null;
    this.next = state;
    return null;
  }
  peek(n) {
    return this.buffer.substr(this.pos, n);
  }
  *parseNext(next) {
    switch (next) {
      case "stream":
        return yield* this.parseStream();
      case "line-start":
        return yield* this.parseLineStart();
      case "block-start":
        return yield* this.parseBlockStart();
      case "doc":
        return yield* this.parseDocument();
      case "flow":
        return yield* this.parseFlowCollection();
      case "quoted-scalar":
        return yield* this.parseQuotedScalar();
      case "block-scalar":
        return yield* this.parseBlockScalar();
      case "plain-scalar":
        return yield* this.parsePlainScalar();
    }
  }
  *parseStream() {
    let line = this.getLine();
    if (line === null)
      return this.setNext("stream");
    if (line[0] === BOM) {
      yield* this.pushCount(1);
      line = line.substring(1);
    }
    if (line[0] === "%") {
      let dirEnd = line.length;
      let cs = line.indexOf("#");
      while (cs !== -1) {
        const ch = line[cs - 1];
        if (ch === " " || ch === "\t") {
          dirEnd = cs - 1;
          break;
        } else {
          cs = line.indexOf("#", cs + 1);
        }
      }
      while (true) {
        const ch = line[dirEnd - 1];
        if (ch === " " || ch === "\t")
          dirEnd -= 1;
        else
          break;
      }
      const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
      yield* this.pushCount(line.length - n);
      this.pushNewline();
      return "stream";
    }
    if (this.atLineEnd()) {
      const sp = yield* this.pushSpaces(true);
      yield* this.pushCount(line.length - sp);
      yield* this.pushNewline();
      return "stream";
    }
    yield DOCUMENT;
    return yield* this.parseLineStart();
  }
  *parseLineStart() {
    const ch = this.charAt(0);
    if (!ch && !this.atEnd)
      return this.setNext("line-start");
    if (ch === "-" || ch === ".") {
      if (!this.atEnd && !this.hasChars(4))
        return this.setNext("line-start");
      const s = this.peek(3);
      if ((s === "---" || s === "...") && isEmpty(this.charAt(3))) {
        yield* this.pushCount(3);
        this.indentValue = 0;
        this.indentNext = 0;
        return s === "---" ? "doc" : "stream";
      }
    }
    this.indentValue = yield* this.pushSpaces(false);
    if (this.indentNext > this.indentValue && !isEmpty(this.charAt(1)))
      this.indentNext = this.indentValue;
    return yield* this.parseBlockStart();
  }
  *parseBlockStart() {
    const [ch0, ch1] = this.peek(2);
    if (!ch1 && !this.atEnd)
      return this.setNext("block-start");
    if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty(ch1)) {
      const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
      this.indentNext = this.indentValue + 1;
      this.indentValue += n;
      return yield* this.parseBlockStart();
    }
    return "doc";
  }
  *parseDocument() {
    yield* this.pushSpaces(true);
    const line = this.getLine();
    if (line === null)
      return this.setNext("doc");
    let n = yield* this.pushIndicators();
    switch (line[n]) {
      case "#":
        yield* this.pushCount(line.length - n);
      case undefined:
        yield* this.pushNewline();
        return yield* this.parseLineStart();
      case "{":
      case "[":
        yield* this.pushCount(1);
        this.flowKey = false;
        this.flowLevel = 1;
        return "flow";
      case "}":
      case "]":
        yield* this.pushCount(1);
        return "doc";
      case "*":
        yield* this.pushUntil(isNotAnchorChar);
        return "doc";
      case '"':
      case "'":
        return yield* this.parseQuotedScalar();
      case "|":
      case ">":
        n += yield* this.parseBlockScalarHeader();
        n += yield* this.pushSpaces(true);
        yield* this.pushCount(line.length - n);
        yield* this.pushNewline();
        return yield* this.parseBlockScalar();
      default:
        return yield* this.parsePlainScalar();
    }
  }
  *parseFlowCollection() {
    let nl, sp;
    let indent = -1;
    do {
      nl = yield* this.pushNewline();
      if (nl > 0) {
        sp = yield* this.pushSpaces(false);
        this.indentValue = indent = sp;
      } else {
        sp = 0;
      }
      sp += yield* this.pushSpaces(true);
    } while (nl + sp > 0);
    const line = this.getLine();
    if (line === null)
      return this.setNext("flow");
    if (indent !== -1 && indent < this.indentNext && line[0] !== "#" || indent === 0 && (line.startsWith("---") || line.startsWith("...")) && isEmpty(line[3])) {
      const atFlowEndMarker = indent === this.indentNext - 1 && this.flowLevel === 1 && (line[0] === "]" || line[0] === "}");
      if (!atFlowEndMarker) {
        this.flowLevel = 0;
        yield FLOW_END;
        return yield* this.parseLineStart();
      }
    }
    let n = 0;
    while (line[n] === ",") {
      n += yield* this.pushCount(1);
      n += yield* this.pushSpaces(true);
      this.flowKey = false;
    }
    n += yield* this.pushIndicators();
    switch (line[n]) {
      case undefined:
        return "flow";
      case "#":
        yield* this.pushCount(line.length - n);
        return "flow";
      case "{":
      case "[":
        yield* this.pushCount(1);
        this.flowKey = false;
        this.flowLevel += 1;
        return "flow";
      case "}":
      case "]":
        yield* this.pushCount(1);
        this.flowKey = true;
        this.flowLevel -= 1;
        return this.flowLevel ? "flow" : "doc";
      case "*":
        yield* this.pushUntil(isNotAnchorChar);
        return "flow";
      case '"':
      case "'":
        this.flowKey = true;
        return yield* this.parseQuotedScalar();
      case ":": {
        const next = this.charAt(1);
        if (this.flowKey || isEmpty(next) || next === ",") {
          this.flowKey = false;
          yield* this.pushCount(1);
          yield* this.pushSpaces(true);
          return "flow";
        }
      }
      default:
        this.flowKey = false;
        return yield* this.parsePlainScalar();
    }
  }
  *parseQuotedScalar() {
    const quote = this.charAt(0);
    let end = this.buffer.indexOf(quote, this.pos + 1);
    if (quote === "'") {
      while (end !== -1 && this.buffer[end + 1] === "'")
        end = this.buffer.indexOf("'", end + 2);
    } else {
      while (end !== -1) {
        let n = 0;
        while (this.buffer[end - 1 - n] === "\\")
          n += 1;
        if (n % 2 === 0)
          break;
        end = this.buffer.indexOf('"', end + 1);
      }
    }
    const qb = this.buffer.substring(0, end);
    let nl = qb.indexOf(`
`, this.pos);
    if (nl !== -1) {
      while (nl !== -1) {
        const cs = this.continueScalar(nl + 1);
        if (cs === -1)
          break;
        nl = qb.indexOf(`
`, cs);
      }
      if (nl !== -1) {
        end = nl - (qb[nl - 1] === "\r" ? 2 : 1);
      }
    }
    if (end === -1) {
      if (!this.atEnd)
        return this.setNext("quoted-scalar");
      end = this.buffer.length;
    }
    yield* this.pushToIndex(end + 1, false);
    return this.flowLevel ? "flow" : "doc";
  }
  *parseBlockScalarHeader() {
    this.blockScalarIndent = -1;
    this.blockScalarKeep = false;
    let i = this.pos;
    while (true) {
      const ch = this.buffer[++i];
      if (ch === "+")
        this.blockScalarKeep = true;
      else if (ch > "0" && ch <= "9")
        this.blockScalarIndent = Number(ch) - 1;
      else if (ch !== "-")
        break;
    }
    return yield* this.pushUntil((ch) => isEmpty(ch) || ch === "#");
  }
  *parseBlockScalar() {
    let nl = this.pos - 1;
    let indent = 0;
    let ch;
    loop:
      for (let i = this.pos;ch = this.buffer[i]; ++i) {
        switch (ch) {
          case " ":
            indent += 1;
            break;
          case `
`:
            nl = i;
            indent = 0;
            break;
          case "\r": {
            const next = this.buffer[i + 1];
            if (!next && !this.atEnd)
              return this.setNext("block-scalar");
            if (next === `
`)
              break;
          }
          default:
            break loop;
        }
      }
    if (!ch && !this.atEnd)
      return this.setNext("block-scalar");
    if (indent >= this.indentNext) {
      if (this.blockScalarIndent === -1)
        this.indentNext = indent;
      else {
        this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
      }
      do {
        const cs = this.continueScalar(nl + 1);
        if (cs === -1)
          break;
        nl = this.buffer.indexOf(`
`, cs);
      } while (nl !== -1);
      if (nl === -1) {
        if (!this.atEnd)
          return this.setNext("block-scalar");
        nl = this.buffer.length;
      }
    }
    let i = nl + 1;
    ch = this.buffer[i];
    while (ch === " ")
      ch = this.buffer[++i];
    if (ch === "\t") {
      while (ch === "\t" || ch === " " || ch === "\r" || ch === `
`)
        ch = this.buffer[++i];
      nl = i - 1;
    } else if (!this.blockScalarKeep) {
      do {
        let i = nl - 1;
        let ch = this.buffer[i];
        if (ch === "\r")
          ch = this.buffer[--i];
        const lastChar = i;
        while (ch === " ")
          ch = this.buffer[--i];
        if (ch === `
` && i >= this.pos && i + 1 + indent > lastChar)
          nl = i;
        else
          break;
      } while (true);
    }
    yield SCALAR2;
    yield* this.pushToIndex(nl + 1, true);
    return yield* this.parseLineStart();
  }
  *parsePlainScalar() {
    const inFlow = this.flowLevel > 0;
    let end = this.pos - 1;
    let i = this.pos - 1;
    let ch;
    while (ch = this.buffer[++i]) {
      if (ch === ":") {
        const next = this.buffer[i + 1];
        if (isEmpty(next) || inFlow && flowIndicatorChars.has(next))
          break;
        end = i;
      } else if (isEmpty(ch)) {
        let next = this.buffer[i + 1];
        if (ch === "\r") {
          if (next === `
`) {
            i += 1;
            ch = `
`;
            next = this.buffer[i + 1];
          } else
            end = i;
        }
        if (next === "#" || inFlow && flowIndicatorChars.has(next))
          break;
        if (ch === `
`) {
          const cs = this.continueScalar(i + 1);
          if (cs === -1)
            break;
          i = Math.max(i, cs - 2);
        }
      } else {
        if (inFlow && flowIndicatorChars.has(ch))
          break;
        end = i;
      }
    }
    if (!ch && !this.atEnd)
      return this.setNext("plain-scalar");
    yield SCALAR2;
    yield* this.pushToIndex(end + 1, true);
    return inFlow ? "flow" : "doc";
  }
  *pushCount(n) {
    if (n > 0) {
      yield this.buffer.substr(this.pos, n);
      this.pos += n;
      return n;
    }
    return 0;
  }
  *pushToIndex(i, allowEmpty) {
    const s = this.buffer.slice(this.pos, i);
    if (s) {
      yield s;
      this.pos += s.length;
      return s.length;
    } else if (allowEmpty)
      yield "";
    return 0;
  }
  *pushIndicators() {
    switch (this.charAt(0)) {
      case "!":
        return (yield* this.pushTag()) + (yield* this.pushSpaces(true)) + (yield* this.pushIndicators());
      case "&":
        return (yield* this.pushUntil(isNotAnchorChar)) + (yield* this.pushSpaces(true)) + (yield* this.pushIndicators());
      case "-":
      case "?":
      case ":": {
        const inFlow = this.flowLevel > 0;
        const ch1 = this.charAt(1);
        if (isEmpty(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
          if (!inFlow)
            this.indentNext = this.indentValue + 1;
          else if (this.flowKey)
            this.flowKey = false;
          return (yield* this.pushCount(1)) + (yield* this.pushSpaces(true)) + (yield* this.pushIndicators());
        }
      }
    }
    return 0;
  }
  *pushTag() {
    if (this.charAt(1) === "<") {
      let i = this.pos + 2;
      let ch = this.buffer[i];
      while (!isEmpty(ch) && ch !== ">")
        ch = this.buffer[++i];
      return yield* this.pushToIndex(ch === ">" ? i + 1 : i, false);
    } else {
      let i = this.pos + 1;
      let ch = this.buffer[i];
      while (ch) {
        if (tagChars.has(ch))
          ch = this.buffer[++i];
        else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) {
          ch = this.buffer[i += 3];
        } else
          break;
      }
      return yield* this.pushToIndex(i, false);
    }
  }
  *pushNewline() {
    const ch = this.buffer[this.pos];
    if (ch === `
`)
      return yield* this.pushCount(1);
    else if (ch === "\r" && this.charAt(1) === `
`)
      return yield* this.pushCount(2);
    else
      return 0;
  }
  *pushSpaces(allowTabs) {
    let i = this.pos - 1;
    let ch;
    do {
      ch = this.buffer[++i];
    } while (ch === " " || allowTabs && ch === "\t");
    const n = i - this.pos;
    if (n > 0) {
      yield this.buffer.substr(this.pos, n);
      this.pos = i;
    }
    return n;
  }
  *pushUntil(test) {
    let i = this.pos;
    let ch = this.buffer[i];
    while (!test(ch))
      ch = this.buffer[++i];
    return yield* this.pushToIndex(i, false);
  }
}
// node_modules/yaml/browser/dist/parse/line-counter.js
class LineCounter {
  constructor() {
    this.lineStarts = [];
    this.addNewLine = (offset) => this.lineStarts.push(offset);
    this.linePos = (offset) => {
      let low = 0;
      let high = this.lineStarts.length;
      while (low < high) {
        const mid = low + high >> 1;
        if (this.lineStarts[mid] < offset)
          low = mid + 1;
        else
          high = mid;
      }
      if (this.lineStarts[low] === offset)
        return { line: low + 1, col: 1 };
      if (low === 0)
        return { line: 0, col: offset };
      const start = this.lineStarts[low - 1];
      return { line: low, col: offset - start + 1 };
    };
  }
}
// node_modules/yaml/browser/dist/parse/parser.js
function includesToken(list, type) {
  for (let i = 0;i < list.length; ++i)
    if (list[i].type === type)
      return true;
  return false;
}
function findNonEmptyIndex(list) {
  for (let i = 0;i < list.length; ++i) {
    switch (list[i].type) {
      case "space":
      case "comment":
      case "newline":
        break;
      default:
        return i;
    }
  }
  return -1;
}
function isFlowToken(token) {
  switch (token?.type) {
    case "alias":
    case "scalar":
    case "single-quoted-scalar":
    case "double-quoted-scalar":
    case "flow-collection":
      return true;
    default:
      return false;
  }
}
function getPrevProps(parent) {
  switch (parent.type) {
    case "document":
      return parent.start;
    case "block-map": {
      const it = parent.items[parent.items.length - 1];
      return it.sep ?? it.start;
    }
    case "block-seq":
      return parent.items[parent.items.length - 1].start;
    default:
      return [];
  }
}
function getFirstKeyStartProps(prev) {
  if (prev.length === 0)
    return [];
  let i = prev.length;
  loop:
    while (--i >= 0) {
      switch (prev[i].type) {
        case "doc-start":
        case "explicit-key-ind":
        case "map-value-ind":
        case "seq-item-ind":
        case "newline":
          break loop;
      }
    }
  while (prev[++i]?.type === "space") {}
  return prev.splice(i, prev.length);
}
function fixFlowSeqItems(fc) {
  if (fc.start.type === "flow-seq-start") {
    for (const it of fc.items) {
      if (it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind")) {
        if (it.key)
          it.value = it.key;
        delete it.key;
        if (isFlowToken(it.value)) {
          if (it.value.end)
            Array.prototype.push.apply(it.value.end, it.sep);
          else
            it.value.end = it.sep;
        } else
          Array.prototype.push.apply(it.start, it.sep);
        delete it.sep;
      }
    }
  }
}

class Parser {
  constructor(onNewLine) {
    this.atNewLine = true;
    this.atScalar = false;
    this.indent = 0;
    this.offset = 0;
    this.onKeyLine = false;
    this.stack = [];
    this.source = "";
    this.type = "";
    this.lexer = new Lexer;
    this.onNewLine = onNewLine;
  }
  *parse(source, incomplete = false) {
    if (this.onNewLine && this.offset === 0)
      this.onNewLine(0);
    for (const lexeme of this.lexer.lex(source, incomplete))
      yield* this.next(lexeme);
    if (!incomplete)
      yield* this.end();
  }
  *next(source) {
    this.source = source;
    if (this.atScalar) {
      this.atScalar = false;
      yield* this.step();
      this.offset += source.length;
      return;
    }
    const type = tokenType(source);
    if (!type) {
      const message = `Not a YAML token: ${source}`;
      yield* this.pop({ type: "error", offset: this.offset, message, source });
      this.offset += source.length;
    } else if (type === "scalar") {
      this.atNewLine = false;
      this.atScalar = true;
      this.type = "scalar";
    } else {
      this.type = type;
      yield* this.step();
      switch (type) {
        case "newline":
          this.atNewLine = true;
          this.indent = 0;
          if (this.onNewLine)
            this.onNewLine(this.offset + source.length);
          break;
        case "space":
          if (this.atNewLine && source[0] === " ")
            this.indent += source.length;
          break;
        case "explicit-key-ind":
        case "map-value-ind":
        case "seq-item-ind":
          if (this.atNewLine)
            this.indent += source.length;
          break;
        case "doc-mode":
        case "flow-error-end":
          return;
        default:
          this.atNewLine = false;
      }
      this.offset += source.length;
    }
  }
  *end() {
    while (this.stack.length > 0)
      yield* this.pop();
  }
  get sourceToken() {
    const st = {
      type: this.type,
      offset: this.offset,
      indent: this.indent,
      source: this.source
    };
    return st;
  }
  *step() {
    const top = this.peek(1);
    if (this.type === "doc-end" && top?.type !== "doc-end") {
      while (this.stack.length > 0)
        yield* this.pop();
      this.stack.push({
        type: "doc-end",
        offset: this.offset,
        source: this.source
      });
      return;
    }
    if (!top)
      return yield* this.stream();
    switch (top.type) {
      case "document":
        return yield* this.document(top);
      case "alias":
      case "scalar":
      case "single-quoted-scalar":
      case "double-quoted-scalar":
        return yield* this.scalar(top);
      case "block-scalar":
        return yield* this.blockScalar(top);
      case "block-map":
        return yield* this.blockMap(top);
      case "block-seq":
        return yield* this.blockSequence(top);
      case "flow-collection":
        return yield* this.flowCollection(top);
      case "doc-end":
        return yield* this.documentEnd(top);
    }
    yield* this.pop();
  }
  peek(n) {
    return this.stack[this.stack.length - n];
  }
  *pop(error) {
    const token = error ?? this.stack.pop();
    if (!token) {
      const message = "Tried to pop an empty stack";
      yield { type: "error", offset: this.offset, source: "", message };
    } else if (this.stack.length === 0) {
      yield token;
    } else {
      const top = this.peek(1);
      if (token.type === "block-scalar") {
        token.indent = "indent" in top ? top.indent : 0;
      } else if (token.type === "flow-collection" && top.type === "document") {
        token.indent = 0;
      }
      if (token.type === "flow-collection")
        fixFlowSeqItems(token);
      switch (top.type) {
        case "document":
          top.value = token;
          break;
        case "block-scalar":
          top.props.push(token);
          break;
        case "block-map": {
          const it = top.items[top.items.length - 1];
          if (it.value) {
            top.items.push({ start: [], key: token, sep: [] });
            this.onKeyLine = true;
            return;
          } else if (it.sep) {
            it.value = token;
          } else {
            Object.assign(it, { key: token, sep: [] });
            this.onKeyLine = !it.explicitKey;
            return;
          }
          break;
        }
        case "block-seq": {
          const it = top.items[top.items.length - 1];
          if (it.value)
            top.items.push({ start: [], value: token });
          else
            it.value = token;
          break;
        }
        case "flow-collection": {
          const it = top.items[top.items.length - 1];
          if (!it || it.value)
            top.items.push({ start: [], key: token, sep: [] });
          else if (it.sep)
            it.value = token;
          else
            Object.assign(it, { key: token, sep: [] });
          return;
        }
        default:
          yield* this.pop();
          yield* this.pop(token);
      }
      if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token.type === "block-map" || token.type === "block-seq")) {
        const last = token.items[token.items.length - 1];
        if (last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token.indent))) {
          if (top.type === "document")
            top.end = last.start;
          else
            top.items.push({ start: last.start });
          token.items.splice(-1, 1);
        }
      }
    }
  }
  *stream() {
    switch (this.type) {
      case "directive-line":
        yield { type: "directive", offset: this.offset, source: this.source };
        return;
      case "byte-order-mark":
      case "space":
      case "comment":
      case "newline":
        yield this.sourceToken;
        return;
      case "doc-mode":
      case "doc-start": {
        const doc = {
          type: "document",
          offset: this.offset,
          start: []
        };
        if (this.type === "doc-start")
          doc.start.push(this.sourceToken);
        this.stack.push(doc);
        return;
      }
    }
    yield {
      type: "error",
      offset: this.offset,
      message: `Unexpected ${this.type} token in YAML stream`,
      source: this.source
    };
  }
  *document(doc) {
    if (doc.value)
      return yield* this.lineEnd(doc);
    switch (this.type) {
      case "doc-start": {
        if (findNonEmptyIndex(doc.start) !== -1) {
          yield* this.pop();
          yield* this.step();
        } else
          doc.start.push(this.sourceToken);
        return;
      }
      case "anchor":
      case "tag":
      case "space":
      case "comment":
      case "newline":
        doc.start.push(this.sourceToken);
        return;
    }
    const bv = this.startBlockValue(doc);
    if (bv)
      this.stack.push(bv);
    else {
      yield {
        type: "error",
        offset: this.offset,
        message: `Unexpected ${this.type} token in YAML document`,
        source: this.source
      };
    }
  }
  *scalar(scalar) {
    if (this.type === "map-value-ind") {
      const prev = getPrevProps(this.peek(2));
      const start = getFirstKeyStartProps(prev);
      let sep;
      if (scalar.end) {
        sep = scalar.end;
        sep.push(this.sourceToken);
        delete scalar.end;
      } else
        sep = [this.sourceToken];
      const map = {
        type: "block-map",
        offset: scalar.offset,
        indent: scalar.indent,
        items: [{ start, key: scalar, sep }]
      };
      this.onKeyLine = true;
      this.stack[this.stack.length - 1] = map;
    } else
      yield* this.lineEnd(scalar);
  }
  *blockScalar(scalar) {
    switch (this.type) {
      case "space":
      case "comment":
      case "newline":
        scalar.props.push(this.sourceToken);
        return;
      case "scalar":
        scalar.source = this.source;
        this.atNewLine = true;
        this.indent = 0;
        if (this.onNewLine) {
          let nl = this.source.indexOf(`
`) + 1;
          while (nl !== 0) {
            this.onNewLine(this.offset + nl);
            nl = this.source.indexOf(`
`, nl) + 1;
          }
        }
        yield* this.pop();
        break;
      default:
        yield* this.pop();
        yield* this.step();
    }
  }
  *blockMap(map) {
    const it = map.items[map.items.length - 1];
    switch (this.type) {
      case "newline":
        this.onKeyLine = false;
        if (it.value) {
          const end = "end" in it.value ? it.value.end : undefined;
          const last = Array.isArray(end) ? end[end.length - 1] : undefined;
          if (last?.type === "comment")
            end?.push(this.sourceToken);
          else
            map.items.push({ start: [this.sourceToken] });
        } else if (it.sep) {
          it.sep.push(this.sourceToken);
        } else {
          it.start.push(this.sourceToken);
        }
        return;
      case "space":
      case "comment":
        if (it.value) {
          map.items.push({ start: [this.sourceToken] });
        } else if (it.sep) {
          it.sep.push(this.sourceToken);
        } else {
          if (this.atIndentedComment(it.start, map.indent)) {
            const prev = map.items[map.items.length - 2];
            const end = prev?.value?.end;
            if (Array.isArray(end)) {
              Array.prototype.push.apply(end, it.start);
              end.push(this.sourceToken);
              map.items.pop();
              return;
            }
          }
          it.start.push(this.sourceToken);
        }
        return;
    }
    if (this.indent >= map.indent) {
      const atMapIndent = !this.onKeyLine && this.indent === map.indent;
      const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind";
      let start = [];
      if (atNextItem && it.sep && !it.value) {
        const nl = [];
        for (let i = 0;i < it.sep.length; ++i) {
          const st = it.sep[i];
          switch (st.type) {
            case "newline":
              nl.push(i);
              break;
            case "space":
              break;
            case "comment":
              if (st.indent > map.indent)
                nl.length = 0;
              break;
            default:
              nl.length = 0;
          }
        }
        if (nl.length >= 2)
          start = it.sep.splice(nl[1]);
      }
      switch (this.type) {
        case "anchor":
        case "tag":
          if (atNextItem || it.value) {
            start.push(this.sourceToken);
            map.items.push({ start });
            this.onKeyLine = true;
          } else if (it.sep) {
            it.sep.push(this.sourceToken);
          } else {
            it.start.push(this.sourceToken);
          }
          return;
        case "explicit-key-ind":
          if (!it.sep && !it.explicitKey) {
            it.start.push(this.sourceToken);
            it.explicitKey = true;
          } else if (atNextItem || it.value) {
            start.push(this.sourceToken);
            map.items.push({ start, explicitKey: true });
          } else {
            this.stack.push({
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start: [this.sourceToken], explicitKey: true }]
            });
          }
          this.onKeyLine = true;
          return;
        case "map-value-ind":
          if (it.explicitKey) {
            if (!it.sep) {
              if (includesToken(it.start, "newline")) {
                Object.assign(it, { key: null, sep: [this.sourceToken] });
              } else {
                const start = getFirstKeyStartProps(it.start);
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start, key: null, sep: [this.sourceToken] }]
                });
              }
            } else if (it.value) {
              map.items.push({ start: [], key: null, sep: [this.sourceToken] });
            } else if (includesToken(it.sep, "map-value-ind")) {
              this.stack.push({
                type: "block-map",
                offset: this.offset,
                indent: this.indent,
                items: [{ start, key: null, sep: [this.sourceToken] }]
              });
            } else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
              const start = getFirstKeyStartProps(it.start);
              const key = it.key;
              const sep = it.sep;
              sep.push(this.sourceToken);
              delete it.key;
              delete it.sep;
              this.stack.push({
                type: "block-map",
                offset: this.offset,
                indent: this.indent,
                items: [{ start, key, sep }]
              });
            } else if (start.length > 0) {
              it.sep = it.sep.concat(start, this.sourceToken);
            } else {
              it.sep.push(this.sourceToken);
            }
          } else {
            if (!it.sep) {
              Object.assign(it, { key: null, sep: [this.sourceToken] });
            } else if (it.value || atNextItem) {
              map.items.push({ start, key: null, sep: [this.sourceToken] });
            } else if (includesToken(it.sep, "map-value-ind")) {
              this.stack.push({
                type: "block-map",
                offset: this.offset,
                indent: this.indent,
                items: [{ start: [], key: null, sep: [this.sourceToken] }]
              });
            } else {
              it.sep.push(this.sourceToken);
            }
          }
          this.onKeyLine = true;
          return;
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar": {
          const fs = this.flowScalar(this.type);
          if (atNextItem || it.value) {
            map.items.push({ start, key: fs, sep: [] });
            this.onKeyLine = true;
          } else if (it.sep) {
            this.stack.push(fs);
          } else {
            Object.assign(it, { key: fs, sep: [] });
            this.onKeyLine = true;
          }
          return;
        }
        default: {
          const bv = this.startBlockValue(map);
          if (bv) {
            if (bv.type === "block-seq") {
              if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
                yield* this.pop({
                  type: "error",
                  offset: this.offset,
                  message: "Unexpected block-seq-ind on same line with key",
                  source: this.source
                });
                return;
              }
            } else if (atMapIndent) {
              map.items.push({ start });
            }
            this.stack.push(bv);
            return;
          }
        }
      }
    }
    yield* this.pop();
    yield* this.step();
  }
  *blockSequence(seq) {
    const it = seq.items[seq.items.length - 1];
    switch (this.type) {
      case "newline":
        if (it.value) {
          const end = "end" in it.value ? it.value.end : undefined;
          const last = Array.isArray(end) ? end[end.length - 1] : undefined;
          if (last?.type === "comment")
            end?.push(this.sourceToken);
          else
            seq.items.push({ start: [this.sourceToken] });
        } else
          it.start.push(this.sourceToken);
        return;
      case "space":
      case "comment":
        if (it.value)
          seq.items.push({ start: [this.sourceToken] });
        else {
          if (this.atIndentedComment(it.start, seq.indent)) {
            const prev = seq.items[seq.items.length - 2];
            const end = prev?.value?.end;
            if (Array.isArray(end)) {
              Array.prototype.push.apply(end, it.start);
              end.push(this.sourceToken);
              seq.items.pop();
              return;
            }
          }
          it.start.push(this.sourceToken);
        }
        return;
      case "anchor":
      case "tag":
        if (it.value || this.indent <= seq.indent)
          break;
        it.start.push(this.sourceToken);
        return;
      case "seq-item-ind":
        if (this.indent !== seq.indent)
          break;
        if (it.value || includesToken(it.start, "seq-item-ind"))
          seq.items.push({ start: [this.sourceToken] });
        else
          it.start.push(this.sourceToken);
        return;
    }
    if (this.indent > seq.indent) {
      const bv = this.startBlockValue(seq);
      if (bv) {
        this.stack.push(bv);
        return;
      }
    }
    yield* this.pop();
    yield* this.step();
  }
  *flowCollection(fc) {
    const it = fc.items[fc.items.length - 1];
    if (this.type === "flow-error-end") {
      let top;
      do {
        yield* this.pop();
        top = this.peek(1);
      } while (top?.type === "flow-collection");
    } else if (fc.end.length === 0) {
      switch (this.type) {
        case "comma":
        case "explicit-key-ind":
          if (!it || it.sep)
            fc.items.push({ start: [this.sourceToken] });
          else
            it.start.push(this.sourceToken);
          return;
        case "map-value-ind":
          if (!it || it.value)
            fc.items.push({ start: [], key: null, sep: [this.sourceToken] });
          else if (it.sep)
            it.sep.push(this.sourceToken);
          else
            Object.assign(it, { key: null, sep: [this.sourceToken] });
          return;
        case "space":
        case "comment":
        case "newline":
        case "anchor":
        case "tag":
          if (!it || it.value)
            fc.items.push({ start: [this.sourceToken] });
          else if (it.sep)
            it.sep.push(this.sourceToken);
          else
            it.start.push(this.sourceToken);
          return;
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar": {
          const fs = this.flowScalar(this.type);
          if (!it || it.value)
            fc.items.push({ start: [], key: fs, sep: [] });
          else if (it.sep)
            this.stack.push(fs);
          else
            Object.assign(it, { key: fs, sep: [] });
          return;
        }
        case "flow-map-end":
        case "flow-seq-end":
          fc.end.push(this.sourceToken);
          return;
      }
      const bv = this.startBlockValue(fc);
      if (bv)
        this.stack.push(bv);
      else {
        yield* this.pop();
        yield* this.step();
      }
    } else {
      const parent = this.peek(2);
      if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep)) {
        yield* this.pop();
        yield* this.step();
      } else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
        const prev = getPrevProps(parent);
        const start = getFirstKeyStartProps(prev);
        fixFlowSeqItems(fc);
        const sep = fc.end.splice(1, fc.end.length);
        sep.push(this.sourceToken);
        const map = {
          type: "block-map",
          offset: fc.offset,
          indent: fc.indent,
          items: [{ start, key: fc, sep }]
        };
        this.onKeyLine = true;
        this.stack[this.stack.length - 1] = map;
      } else {
        yield* this.lineEnd(fc);
      }
    }
  }
  flowScalar(type) {
    if (this.onNewLine) {
      let nl = this.source.indexOf(`
`) + 1;
      while (nl !== 0) {
        this.onNewLine(this.offset + nl);
        nl = this.source.indexOf(`
`, nl) + 1;
      }
    }
    return {
      type,
      offset: this.offset,
      indent: this.indent,
      source: this.source
    };
  }
  startBlockValue(parent) {
    switch (this.type) {
      case "alias":
      case "scalar":
      case "single-quoted-scalar":
      case "double-quoted-scalar":
        return this.flowScalar(this.type);
      case "block-scalar-header":
        return {
          type: "block-scalar",
          offset: this.offset,
          indent: this.indent,
          props: [this.sourceToken],
          source: ""
        };
      case "flow-map-start":
      case "flow-seq-start":
        return {
          type: "flow-collection",
          offset: this.offset,
          indent: this.indent,
          start: this.sourceToken,
          items: [],
          end: []
        };
      case "seq-item-ind":
        return {
          type: "block-seq",
          offset: this.offset,
          indent: this.indent,
          items: [{ start: [this.sourceToken] }]
        };
      case "explicit-key-ind": {
        this.onKeyLine = true;
        const prev = getPrevProps(parent);
        const start = getFirstKeyStartProps(prev);
        start.push(this.sourceToken);
        return {
          type: "block-map",
          offset: this.offset,
          indent: this.indent,
          items: [{ start, explicitKey: true }]
        };
      }
      case "map-value-ind": {
        this.onKeyLine = true;
        const prev = getPrevProps(parent);
        const start = getFirstKeyStartProps(prev);
        return {
          type: "block-map",
          offset: this.offset,
          indent: this.indent,
          items: [{ start, key: null, sep: [this.sourceToken] }]
        };
      }
    }
    return null;
  }
  atIndentedComment(start, indent) {
    if (this.type !== "comment")
      return false;
    if (this.indent <= indent)
      return false;
    return start.every((st) => st.type === "newline" || st.type === "space");
  }
  *documentEnd(docEnd) {
    if (this.type !== "doc-mode") {
      if (docEnd.end)
        docEnd.end.push(this.sourceToken);
      else
        docEnd.end = [this.sourceToken];
      if (this.type === "newline")
        yield* this.pop();
    }
  }
  *lineEnd(token) {
    switch (this.type) {
      case "comma":
      case "doc-start":
      case "doc-end":
      case "flow-seq-end":
      case "flow-map-end":
      case "map-value-ind":
        yield* this.pop();
        yield* this.step();
        break;
      case "newline":
        this.onKeyLine = false;
      case "space":
      case "comment":
      default:
        if (token.end)
          token.end.push(this.sourceToken);
        else
          token.end = [this.sourceToken];
        if (this.type === "newline")
          yield* this.pop();
    }
  }
}
// node_modules/yaml/browser/dist/public-api.js
function parseOptions(options) {
  const prettyErrors = options.prettyErrors !== false;
  const lineCounter = options.lineCounter || prettyErrors && new LineCounter || null;
  return { lineCounter, prettyErrors };
}
function parseDocument(source, options = {}) {
  const { lineCounter, prettyErrors } = parseOptions(options);
  const parser = new Parser(lineCounter?.addNewLine);
  const composer = new Composer(options);
  let doc = null;
  for (const _doc of composer.compose(parser.parse(source), true, source.length)) {
    if (!doc)
      doc = _doc;
    else if (doc.options.logLevel !== "silent") {
      doc.errors.push(new YAMLParseError(_doc.range.slice(0, 2), "MULTIPLE_DOCS", "Source contains multiple documents; please use YAML.parseAllDocuments()"));
      break;
    }
  }
  if (prettyErrors && lineCounter) {
    doc.errors.forEach(prettifyError(source, lineCounter));
    doc.warnings.forEach(prettifyError(source, lineCounter));
  }
  return doc;
}
function parse(src, reviver, options) {
  let _reviver = undefined;
  if (typeof reviver === "function") {
    _reviver = reviver;
  } else if (options === undefined && reviver && typeof reviver === "object") {
    options = reviver;
  }
  const doc = parseDocument(src, options);
  if (!doc)
    return null;
  doc.warnings.forEach((warning) => warn(doc.options.logLevel, warning));
  if (doc.errors.length > 0) {
    if (doc.options.logLevel !== "silent")
      throw doc.errors[0];
    else
      doc.errors = [];
  }
  return doc.toJS(Object.assign({ reviver: _reviver }, options));
}
// src/util.ts
function isObj2(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// src/config/accounts.ts
function parseSize(v) {
  if (typeof v === "number")
    return v;
  const m = /^(\d+(?:\.\d+)?)\s*([kKmMgG]?)$/.exec(String(v ?? "").trim());
  if (!m)
    return null;
  const mult = { "": 1, k: 1000, m: 1e6, g: 1e9 }[m[2].toLowerCase()];
  return Number(m[1]) * mult;
}
function parseDuration(v) {
  if (typeof v === "number")
    return v;
  const m = /^(\d+(?:\.\d+)?)\s*([smhd])$/.exec(String(v ?? "").trim());
  if (!m)
    return null;
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
}
var AGENTS = ["claude-code", "codex", "cursor", "agy", "opencode"];
var ACCOUNT_KIND = {
  "claude-code": "claude",
  codex: "codex",
  cursor: "cursor",
  agy: "agy",
  opencode: "endpoint"
};
function allowedPair(agent, kind) {
  return Object.hasOwn(ACCOUNT_KIND, agent) && ACCOUNT_KIND[agent] === kind;
}
function accountCfg(name, c) {
  const kind = c.kind;
  const home = typeof c.home === "string" ? c.home : null;
  const orcaAccount = typeof c.orca_account === "string" ? c.orca_account : null;
  const source = orcaAccount ? "orca" : home ? "pacer" : kind === "endpoint" ? "endpoint" : "default";
  const usage = c.usage ?? (kind === "claude" || kind === "codex" ? "quota" : kind === "endpoint" ? "metered" : "reactive");
  const quotaSource = typeof c.quota_source === "string" ? c.quota_source : null;
  const usageSource = c.usage_source ?? (source === "orca" ? "orca" : quotaSource === "arkcli" ? "arkcli" : usage === "quota" ? "native" : usage);
  return {
    name,
    model: c.model === undefined ? null : String(c.model),
    kind,
    source,
    home,
    orcaAccount,
    usage,
    usageSource,
    quotaSource,
    weeklyTokens: isObj2(c.budget) ? parseSize(c.budget.weekly_tokens) : null,
    cooldownS: c.cooldown === undefined ? 6 * 3600 : parseDuration(c.cooldown) ?? 6 * 3600,
    allowPaid: c.allow_paid === true
  };
}
function legacyToAccounts(raw) {
  const c = isObj2(raw) ? raw : {};
  const accounts = {};
  const runners = {};
  const runnerAliases = {};
  for (const [name, value] of Object.entries(isObj2(c.providers) ? c.providers : {})) {
    const v = isObj2(value) ? value : {};
    const agent = v.via === "opencode" ? "opencode" : name;
    accounts[name] = accountCfg(name, { ...v, kind: ACCOUNT_KIND[agent] });
    const id = agent === "opencode" ? `opencode#${name}` : agent;
    runnerAliases[name] = id;
    runners[id] = { id, name: id, host: null, agent, account: name, model: accounts[name].model };
  }
  const agent = c.planner;
  if (agent !== "opencode" && !accounts[agent])
    accounts[agent] = accountCfg(agent, { kind: ACCOUNT_KIND[agent] });
  const planner = { agent, account: agent };
  if (accounts[agent] && !runners[agent])
    runners[agent] = { id: agent, name: agent, host: null, agent, account: agent, model: accounts[agent].model };
  return { accounts, runners, planner, runnerAliases };
}
function parseAccounts(raw, problems) {
  const accounts = {};
  const runners = {};
  if (!isObj2(raw.accounts) || !Object.keys(raw.accounts).length)
    problems.push("accounts must be a non-empty mapping");
  for (const [name, value] of Object.entries(isObj2(raw.accounts) ? raw.accounts : {})) {
    const at = `accounts.${name}`;
    if (!isObj2(value)) {
      problems.push(`${at} must be a mapping`);
      continue;
    }
    const cfg = accountCfg(name, value);
    if (!["claude", "codex", "cursor", "agy", "endpoint"].includes(cfg.kind))
      problems.push(`${at}: unknown account kind`);
    if (value.home !== undefined && (typeof value.home !== "string" || !value.home.trim() || !["claude", "codex"].includes(cfg.kind))) {
      problems.push(`${at}: home requires a non-empty folder on a claude or codex account`);
    }
    if (value.orca_account !== undefined && (typeof value.orca_account !== "string" || !value.orca_account.trim() || !["claude", "codex"].includes(cfg.kind))) {
      problems.push(`${at}: orca_account requires a non-empty id on a claude or codex account`);
    }
    if (value.home !== undefined && value.orca_account !== undefined)
      problems.push(`${at}: home and orca_account are mutually exclusive`);
    if (!["quota", "metered", "reactive", "unmetered"].includes(cfg.usage))
      problems.push(`${at}: unknown usage kind`);
    if (!["native", "orca", "arkcli", "metered", "reactive", "unmetered"].includes(cfg.usageSource))
      problems.push(`${at}: unknown usage_source`);
    if (["cursor", "agy"].includes(cfg.kind) && cfg.usage === "quota" && cfg.usageSource !== "orca")
      problems.push(`${at}: quota usage is not available; use reactive or usage_source: orca`);
    if (cfg.kind === "endpoint" && cfg.usage === "quota" && cfg.quotaSource !== "arkcli" && cfg.usageSource !== "orca")
      problems.push(`${at}: quota usage needs quota_source: arkcli or usage_source: orca`);
    if (cfg.usage === "metered" && (cfg.weeklyTokens === null || !Number.isFinite(cfg.weeklyTokens) || cfg.weeklyTokens <= 0))
      problems.push(`${at}: metered usage needs budget.weekly_tokens`);
    if (value.cooldown !== undefined && (parseDuration(value.cooldown) === null || !Number.isFinite(cfg.cooldownS) || cfg.cooldownS < 0))
      problems.push(`${at}: cooldown must look like 30m, 6h or 2d`);
    accounts[name] = cfg;
  }
  for (const kind of ["claude", "codex", "cursor", "agy"]) {
    if (Object.values(accounts).filter((a) => a.kind === kind && !a.home && !a.orcaAccount).length > 1)
      problems.push(`accounts: more than one default ${kind} account`);
  }
  const defaults = runnerDefaults(accounts);
  delete defaults.opencode;
  const runnerAliases = {};
  const declarations = new Map;
  const entries = isObj2(raw.runners) ? raw.runners : {};
  if (raw.runners !== undefined && !isObj2(raw.runners))
    problems.push("runners must be a mapping");
  for (const [name, value] of Object.entries(entries)) {
    if (isObj2(value) && value.agent && value.account)
      runnerAliases[name] = formatRunnerId({ agent: value.agent, account: String(value.account), host: null }, defaults);
  }
  const add = (reference, value = {}) => {
    const at = `runner ${reference}`;
    const c = isObj2(value) ? value : {};
    if (!isObj2(value))
      problems.push(`${at}: must be a mapping`);
    const declared = parseRunnerId(reference);
    const explicit = c.agent !== undefined || c.account !== undefined;
    if (declared?.host && explicit)
      problems.push("remote runners aren't supported yet");
    if (declared && explicit && (declared.agent !== c.agent || (declared.account ?? defaults[declared.agent]) !== c.account))
      problems.push(`${at}: declaration conflicts with runner id identity`);
    const parsed = explicit ? { agent: c.agent, account: c.account, host: null } : parseRunnerId(runnerAliases[reference] ?? reference) ?? (accounts[reference]?.kind === "endpoint" ? { agent: "opencode", account: reference, host: null } : null);
    if (!parsed || !AGENTS.includes(parsed.agent)) {
      problems.push(`${at}: invalid runner id or unknown agent`);
      return null;
    }
    if (parsed.host)
      problems.push("remote runners aren't supported yet");
    if (parsed.agent === "opencode" && reference === "opencode" && !accounts.opencode)
      return null;
    const account = parsed.account ?? defaults[parsed.agent];
    if (!account) {
      problems.push(`${at}: no default account for ${parsed.agent}`);
      return null;
    }
    const cfg = accounts[account];
    if (!cfg) {
      problems.push(`${at}: unknown account "${account}"`);
      return null;
    }
    if (!allowedPair(parsed.agent, cfg.kind))
      problems.push(`${at}: ${parsed.agent} cannot use ${cfg.kind} account "${account}"`);
    const id = formatRunnerId({ ...parsed, account }, defaults);
    if (!parseRunnerId(id))
      problems.push(`${at}: invalid runner id`);
    if (runners[id] && !Object.keys(c).length) {
      runnerAliases[reference] = id;
      return runners[id];
    }
    const model = c.model === undefined ? cfg.model : typeof c.model === "string" ? c.model : null;
    if (Object.keys(c).length) {
      if (declarations.has(id) && declarations.get(id) !== model)
        problems.push(`${at}: conflicting model declarations for ${id}`);
      declarations.set(id, model);
    }
    const runner = { id, name: id, host: parsed.host, agent: parsed.agent, account, model };
    if (!runners[id] || Object.keys(c).length)
      runners[id] = runner;
    runnerAliases[reference] = id;
    return runners[id];
  };
  const plannerRaw = isObj2(raw.planner) ? raw.planner : {};
  const plannerRef = plannerRaw.agent === "opencode" && plannerRaw.account === "opencode" && !accounts.opencode ? "opencode" : typeof raw.planner === "string" ? raw.planner : formatRunnerId({ agent: plannerRaw.agent, account: plannerRaw.account, host: null }, defaults);
  const plannerRunner = add(plannerRef, typeof raw.planner === "string" ? {} : plannerRaw);
  const planner = plannerRunner ? { agent: plannerRunner.agent, account: plannerRunner.account } : { agent: "opencode", account: "opencode" };
  if (!["claude-code", "codex", "cursor", "opencode"].includes(planner.agent))
    problems.push("planner must be one of claude-code, codex, cursor, opencode");
  for (const [name, value] of Object.entries(entries))
    add(name, value);
  if (Array.isArray(raw.routing))
    for (const rule of raw.routing) {
      if (!isObj2(rule))
        continue;
      const refs = rule.default ?? rule.executors;
      if (Array.isArray(refs))
        for (const ref of refs)
          add(String(ref));
    }
  for (const runner of Object.values(runners)) {
    if (runner.agent === "opencode" && (!runner.model || !runner.model.includes("/")))
      problems.push(`runner ${runner.id}: model must look like "<provider>/<model>"`);
  }
  return { accounts, runners, planner, runnerAliases };
}

// src/config/runner-id.ts
function parseRunnerId(id) {
  const m = /^([a-z0-9][a-z0-9-]*)(?:#([a-z0-9][a-z0-9-]*))?(?:@([a-z0-9][a-z0-9-]*))?$/.exec(id);
  if (!m || !AGENTS.includes(m[1]))
    return null;
  return { agent: m[1], account: m[2] ?? null, host: m[3] ?? null };
}
function runnerDefaults(accounts) {
  const defaults = {};
  for (const agent of AGENTS) {
    const matches = Object.values(accounts).filter((a) => allowedPair(agent, a.kind) && !a.home && !a.orcaAccount);
    if (matches.length === 1)
      defaults[agent] = matches[0].name;
  }
  return defaults;
}
function formatRunnerId(id, defaults) {
  return id.agent + (id.account && id.account !== defaults[id.agent] ? `#${id.account}` : "") + (id.host ? `@${id.host}` : "");
}
function resolveRunner(s, idOrAlias) {
  if (Object.hasOwn(s.runners, idOrAlias))
    return s.runners[idOrAlias];
  const alias = s.runnerAliases?.[idOrAlias];
  if (alias && Object.hasOwn(s.runners, alias))
    return s.runners[alias];
  const id = parseRunnerId(idOrAlias) ?? (s.accounts[idOrAlias]?.kind === "endpoint" ? { agent: "opencode", account: idOrAlias, host: null } : null);
  if (!id)
    return null;
  const defaults = runnerDefaults(s.accounts);
  delete defaults.opencode;
  const canonical = formatRunnerId(id, defaults);
  return Object.hasOwn(s.runners, canonical) ? s.runners[canonical] : null;
}

// src/config/strategy.ts
var KINDS = [
  "boilerplate",
  "tests",
  "docs",
  "rename",
  "migration",
  "feature",
  "debug",
  "refactor",
  "performance",
  "unfamiliar-code",
  "research"
];
var NATIVE = ["claude-code", "codex", "cursor", "agy"];
var PLANNERS = ["claude-code", "codex", "cursor", "opencode"];
var POLICIES = ["priority", "even", "burn-before-reset", "cheapest-first"];
var USAGES = ["quota", "metered", "reactive", "unmetered"];
var NATIVE_USAGE = { "claude-code": "quota", codex: "quota", cursor: "reactive", agy: "reactive" };
var DEFAULT_ORDER = ["codex", "cursor", "agy", "opencode"];

class StrategyError extends Error {
  path;
  problems;
  constructor(path, problems) {
    super(`invalid strategy ${path}:
${problems.map((p) => `  - ${p}`).join(`
`)}`);
    this.path = path;
    this.problems = problems;
    this.name = "StrategyError";
  }
}
function validateStrategy(raw, path, name = "default") {
  const p = [];
  if (!isObj2(raw))
    throw new StrategyError(path, ["top level must be a mapping"]);
  const legacy = Object.hasOwn(raw, "providers");
  if (legacy && (raw.accounts !== undefined || raw.runners !== undefined))
    p.push("providers cannot be combined with accounts or runners");
  const providers = {};
  if (legacy) {
    const planner = String(raw.planner ?? "");
    if (!PLANNERS.includes(planner)) {
      p.push(`planner must be one of ${PLANNERS.join(", ")} (got "${planner}")`);
    }
    if (!isObj2(raw.providers) || Object.keys(raw.providers).length === 0) {
      p.push("providers must be a non-empty mapping");
    } else {
      for (const [id, v] of Object.entries(raw.providers)) {
        const c = isObj2(v) ? v : {};
        const native = NATIVE.includes(id);
        const via = c.via === undefined ? null : c.via;
        if (native && via !== null)
          p.push(`providers.${id}: native providers cannot set "via"`);
        if (!native && via !== "opencode")
          p.push(`providers.${id}: non-native providers need via: opencode`);
        const model = c.model === undefined ? null : String(c.model);
        if (via === "opencode" && (!model || !model.includes("/"))) {
          p.push(`providers.${id}: model must look like "<provider>/<model>"`);
        }
        const usage = c.usage ?? (native ? NATIVE_USAGE[id] : "metered");
        if (!USAGES.includes(usage))
          p.push(`providers.${id}: usage must be one of ${USAGES.join(", ")}`);
        if ((id === "cursor" || id === "agy") && usage === "quota") {
          p.push(`providers.${id}: quota usage is not available for ${id}; use reactive`);
        }
        const quotaSource = c.quota_source === undefined ? null : c.quota_source;
        if (!native && usage === "quota" && quotaSource !== "arkcli") {
          p.push(`providers.${id}: quota usage via opencode needs quota_source: arkcli`);
        }
        const weeklyTokens = isObj2(c.budget) ? parseSize(c.budget.weekly_tokens) : null;
        if (usage === "metered" && weeklyTokens === null) {
          p.push(`providers.${id}: metered usage needs budget.weekly_tokens (e.g. 20M)`);
        }
        const cooldownS = c.cooldown === undefined ? 6 * 3600 : parseDuration(c.cooldown);
        if (cooldownS === null)
          p.push(`providers.${id}: cooldown must look like 30m, 6h or 2d`);
      }
    }
  }
  const { accounts, runners, planner, runnerAliases } = legacy ? legacyToAccounts(raw) : parseAccounts(raw, p);
  for (const [id, runner] of Object.entries(runners)) {
    const account = accounts[runner.account];
    if (!account)
      continue;
    providers[id] = {
      id,
      via: runner.agent === "opencode" ? "opencode" : null,
      model: runner.model,
      usage: account.usage,
      allowPaid: account.allowPaid,
      cooldownS: account.cooldownS,
      quotaSource: account.quotaSource === "arkcli" ? "arkcli" : null,
      weeklyTokens: account.weeklyTokens
    };
  }
  const resolve = (id) => resolveRunner({ accounts, runners, runnerAliases }, id)?.id ?? id;
  const pc = isObj2(raw.pacing) ? raw.pacing : {};
  const policy = String(pc.policy ?? "priority");
  if (!POLICIES.includes(policy)) {
    p.push(`pacing.policy must be one of ${POLICIES.join(", ")} (got "${policy}")`);
  }
  let order = [];
  if (pc.order === undefined) {
    const hasOpencode = Object.values(providers).some((cfg) => cfg.via === "opencode");
    order = legacy ? DEFAULT_ORDER.filter((id) => Object.hasOwn(runners, id) || id === "opencode" && hasOpencode) : Object.keys(runners);
  } else if (!Array.isArray(pc.order)) {
    p.push("pacing.order must be a list");
  } else {
    order = pc.order.map((v) => resolve(String(v)));
    for (const id of order) {
      const parsed = parseRunnerId(id);
      const account = parsed ? accounts[parsed.account ?? runnerDefaults(accounts)[parsed.agent] ?? ""] : undefined;
      if (parsed && account && !allowedPair(parsed.agent, account.kind))
        p.push(`pacing.order: ${parsed.agent} cannot use ${account.kind} account "${account.name}"`);
      if (parsed?.host)
        p.push("remote runners aren't supported yet");
      if (id !== "opencode" && !Object.hasOwn(providers, id) && !account) {
        p.push(`pacing.order: unknown provider "${id}"`);
      }
    }
  }
  const num = (k, d) => {
    const v = pc[k] ?? d;
    if (typeof v !== "number") {
      p.push(`pacing.${k} must be a number`);
      return d;
    }
    return v;
  };
  const pacing = {
    policy,
    order,
    plannerReserve: num("planner_reserve", 15),
    aheadThreshold: num("ahead_threshold", 10),
    behindThreshold: num("behind_threshold", -10),
    accounts: pc.accounts ?? "spread",
    fillThreshold: num("fill_threshold", 90)
  };
  if (!["spread", "fill"].includes(pacing.accounts))
    p.push("pacing.accounts must be spread or fill");
  if (!Number.isFinite(pacing.fillThreshold) || pacing.fillThreshold < 50 || pacing.fillThreshold > 100)
    p.push("pacing.fill_threshold must be between 50 and 100");
  if (pacing.plannerReserve < 0 || pacing.plannerReserve >= 100) {
    p.push("pacing.planner_reserve must be between 0 and 99");
  }
  const routing = [];
  const rawRouting = raw.routing ?? [{ default: Object.keys(providers) }];
  if (!Array.isArray(rawRouting)) {
    p.push("routing must be a list");
  } else {
    rawRouting.forEach((r, i) => {
      if (!isObj2(r)) {
        p.push(`routing[${i}] must be a mapping`);
        return;
      }
      const isDefault = Array.isArray(r.default);
      const executors = isDefault ? r.default : r.executors;
      if (!Array.isArray(executors) || executors.length === 0) {
        p.push(`routing[${i}] needs a non-empty executors (or default) list`);
        return;
      }
      for (const e of executors)
        if (!providers[resolve(String(e))])
          p.push(`routing[${i}]: unknown provider "${e}"`);
      let kinds = null;
      if (!isDefault) {
        if (!Array.isArray(r.kinds) || r.kinds.length === 0) {
          p.push(`routing[${i}] needs kinds (or use default:)`);
          return;
        }
        kinds = r.kinds.map(String);
        for (const k of kinds) {
          if (!KINDS.includes(k)) {
            p.push(`routing[${i}]: unknown kind "${k}" (allowed: ${KINDS.join(", ")})`);
          }
        }
      }
      routing.push({ kinds, executors: executors.map((e) => resolve(String(e))) });
    });
  }
  if (p.length)
    throw new StrategyError(path, p);
  return {
    name,
    planner,
    accounts,
    runners,
    legacy,
    runnerAliases,
    providers,
    pacing,
    routing,
    execution: isObj2(raw.execution) ? raw.execution : {},
    classifier: isObj2(raw.classifier) ? raw.classifier : {}
  };
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

// src/view-model/format.ts
var displayName2 = (id) => parseRunnerId(id) || Object.hasOwn(names2, id) ? displayName(id) : id;
function duration(seconds, long = false) {
  const minutes = Math.max(0, Math.floor(seconds / 60)), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  if (long)
    return days ? `${days} ${days === 1 ? "day" : "days"} ${hours % 24} ${hours % 24 === 1 ? "hour" : "hours"}` : `${hours} ${hours === 1 ? "hour" : "hours"}`;
  return days ? `${days}d ${hours % 24}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}
var backIn = (at, now) => at === null ? "reset unknown" : `back in ${duration(at - now)}`;

// orca-plugin/src/panel/shared.ts
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function jsonForScript(v) {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
var h = (v) => escapeHtml(String(v ?? ""));
var time = (at) => new Date(at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
var age = (at, now) => `${duration(now - at)} ago`;
function packPanelData(value) {
  if (typeof value === "string" && value.length >= 32) {
    const runs = [];
    for (const char of value) {
      const last = runs.at(-1);
      if (last?.[0] === char)
        last[1]++;
      else
        runs.push([char, 1]);
    }
    const packed = { $runs: runs };
    return JSON.stringify(packed).length < JSON.stringify(value).length ? packed : value;
  }
  if (Array.isArray(value))
    return value.map(packPanelData);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, packPanelData(v)]));
  return value;
}
var actionStatus = '<p data-status role="status" aria-live="polite" class="action-status"></p>';

// orca-plugin/src/panel/settings.ts
function readPanelSettings(readText, home, name = "default") {
  try {
    const text = readText(name === "default" ? `${home}/strategy.yaml` : `${home}/strategies/${name}.yaml`);
    if (!text)
      return { updateCheck: true };
    const raw = parse(text);
    return { strategyConfig: validateStrategy(raw, "active strategy", name), updateCheck: raw.update_check !== false };
  } catch {
    return { updateCheck: true, error: "Settings unavailable: fix the active strategy in a pacer terminal." };
  }
}
function settingsView(s, view, live, commands) {
  const cfg = view.strategyConfig, runners = Object.values(cfg?.runners ?? {}), planner = cfg ? runners.find((r) => r.agent === cfg.planner.agent && r.account === cfg.planner.account)?.id ?? cfg.planner.agent : s.budget?.planner && /^[a-z0-9][a-z0-9-]*(?:#[a-z0-9][a-z0-9-]*)?$/.test(s.budget.planner) ? s.budget.planner : "Not configured";
  const disabled = live ? "" : " disabled";
  const removalReason = (reason) => live && reason ? `<small class="muted">${h(reason)}</small>` : "";
  function button(id, label, cmd, reason = "", remove = false, active) {
    commands[`s-${id}`] = cmd;
    const control = `<button data-command="s-${h(id)}"${remove ? ' data-remove="true"' : ""}${active === undefined ? "" : ` aria-pressed="${active}"`}${!live ? disabled : reason ? ` disabled title="${h(reason)}"` : ""}>${h(label)}</button>`;
    return live && reason && !remove && !["First executor", "Last executor"].includes(reason) ? `<span class="disabled-action">${control}<small class="muted">${h(reason)}</small></span>` : control;
  }
  const set = (id, label, key, value, reason = "", active) => button(id, label, { cmd: "config-set", key, value }, reason, false, active);
  const section = (name, body) => `<section class="stack section"><h2>${name}</h2><div class="card provider stack">${body}</div></section>`;
  const terminal = (id, label, command) => button(id, label, { cmd: "open-terminal", command });
  if (!cfg) {
    const rows = [["Planner", planner], ["Accounts", "Unavailable"], ["Runners", "Unavailable"], ["Executors", "Unavailable"], ["Pacing", "Unavailable"], ["Strategies", s.budget?.strategy ?? "default"], ["Updates", view.updates?.cli ?? view.updates?.plugin ?? "Unknown"], ["Plugin", `Notifications: ${view.notifications ?? "important"} · Automatic console: ${view.autoConsole === false ? "off" : "on"}`]];
    return `<div class="content"><header><strong class="grow">Settings</strong><button data-view="overview">Back</button></header><small>${h(view.settingsError ?? "Active strategy settings unavailable.")}</small>${!live ? '<div class="note">Open a pacer console to change settings<button data-setup="pacer console">Open console</button></div>' : ""}<div class="card stack provider">${rows.map(([label, value]) => `<h2>${label}</h2><small>${h(value)}</small>`).join("")}</div><div class="actions">${terminal("init", "Configure pacer", "init")}</div>${actionStatus}</div>`;
  }
  const accounts = Object.values(cfg.accounts).map((a) => {
    const users = runners.filter((r) => r.account === a.name), readings = s.budget?.providers.filter((p) => p.account === a.name || !p.account && users.some((r) => r.id === p.id)) ?? [], usage = readings.find((p) => p.usedPct !== null)?.usedPct;
    const state = readings.length ? readings.some((p) => p.unavailableReason || p.brokenReason) ? "Unavailable" : "Available" : "Sign-in state unknown";
    const reason = cfg.planner.account === a.name ? "Planner — can't remove" : users.length ? `In use by ${users.map((r) => r.id).join(", ")}` : "";
    return `<div class="stack"><div class="row"><strong class="grow">${h(a.name)}</strong><span class="pill">${h(a.source)}</span>${button(`account-${a.name}`, "Remove", { cmd: "account-remove", name: a.name }, reason, true)}</div>${removalReason(reason)}<small>${h(a.kind)} · ${usage == null ? "Usage unknown" : `${Math.round(usage)}% used`} · ${state}</small><small>Runners: ${h(users.map((r) => r.id).join(", ") || "None")}</small></div>`;
  }).join("");
  const order = cfg?.pacing.order ?? [];
  const executors = order.map((id, i) => {
    const blocked = !!s.budget?.providers.find((p) => p.id === id)?.blockedReason;
    const moved = (j) => {
      const next = [...order];
      [next[i], next[j]] = [next[j], next[i]];
      return next.join(",");
    };
    return `<div class="stack"><strong>${h(id)}</strong><div class="actions">${button(`toggle-${id}`, blocked ? "Enable" : "Disable", { cmd: blocked ? "unblock" : "block", executor: id })}${set(`up-${id}`, "↑", "pacing.order", i > 0 ? moved(i - 1) : order.join(","), i === 0 ? "First executor" : "")}${set(`down-${id}`, "↓", "pacing.order", i < order.length - 1 ? moved(i + 1) : order.join(","), i === order.length - 1 ? "Last executor" : "")}</div></div>`;
  }).join("");
  const policy = cfg?.pacing.policy ?? "priority", reserve = cfg?.pacing.plannerReserve ?? 20, mode = cfg?.pacing.accounts ?? "spread", threshold = cfg?.pacing.fillThreshold ?? 90;
  const policyDescriptions = { priority: "Use executors in your order; move ahead-of-pace ones later and expiring quota first.", even: "Spread work toward executors with the most pace headroom.", "burn-before-reset": "Use quota that would reset unused first.", "cheapest-first": "Prefer unmetered, then quota, then metered." };
  const choices = (key, values, current) => `<div class="actions segmented" role="group" aria-label="${h(key)}">${values.map((v) => set(`${key}-${v}`, v, key, v, "", v === current)).join("")}</div>`;
  const steps = (key, label, value, min, max) => `<div class="row"><span class="grow">${label}: <strong>${value}%</strong></span>${set(`${key}-minus`, "−", key, String(Math.max(min, value - 5)), value <= min ? `Minimum ${min}%` : "")}${set(`${key}-plus`, "+", key, String(Math.min(max, value + 5)), value >= max ? `Maximum ${max}%` : "")}</div>`;
  const strategies = ((s.strategies?.length) ? s.strategies : ["default"]).filter((e) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(typeof e === "string" ? e : e.name)).map((e) => typeof e === "string" ? { name: e, active: e === (cfg?.name ?? s.budget?.strategy ?? "default") } : e);
  return `<div class="content"><header><strong class="grow">Settings</strong><button data-view="overview">Back</button></header>${!live ? '<div class="note stack">Open a pacer console to change settings<button data-setup="pacer console">Open console</button></div>' : ""}${view.settingsError ? `<p class="note">${h(view.settingsError)}</p>` : ""}
 ${section("Planner", choices("planner", runners.filter((r) => ["claude-code", "codex", "cursor", "opencode"].includes(r.agent) && !r.host).map((r) => r.id), planner))}
 ${section("Accounts", `${accounts || "<small>No accounts.</small>"}<div class="actions">${terminal("account-add", "Add account", "account-add")}${terminal("account-link", "Link Orca account", "account-add-orca")}</div>`)}
 ${section("Runners", `${runners.map((r) => `<div class="stack"><strong>${h(r.id)}</strong><small>${h(r.agent)} · ${h(r.account)}${r.model ? ` · ${h(r.model)}` : ""}</small><div class="actions">${button(`runner-${r.id}`, "Remove", { cmd: "runner-remove", name: r.id }, r.id === planner ? "Planner — can't remove" : runners.length <= 1 ? "Last runner" : "", true)}</div>${removalReason(r.id === planner ? "Planner — can't remove" : runners.length <= 1 ? "Last runner" : "")}</div>`).join("") || "<small>No runners.</small>"}<div class="actions">${terminal("runner-add", "Add runner", "runner-add")}</div>`)}
 ${section("Executors", `${executors || "<small>No executors.</small>"}<small>${h(cfg?.routing.map((r) => `${r.kinds?.join(", ") ?? "default"} → ${r.executors.join(", ")}`).join("; ") ?? "")}</small><div class="actions"><button data-view="strategy"${disabled}>Edit routing</button></div>`)}
 ${section("Pacing", cfg ? `<small>Policy: ${policy}</small>${choices("pacing.policy", ["priority", "even", "burn-before-reset", "cheapest-first"], policy)}<small>${policyDescriptions[policy]}</small>${steps("pacing.planner_reserve", "Planner reserve", reserve, 0, 50)}<small>Accounts: ${mode}</small>${choices("pacing.accounts", ["spread", "fill"], mode)}<small>${mode === "spread" ? "Spread across accounts by headroom." : "Fill one account until it leaves the pace band or reaches the threshold."}</small>${mode === "fill" ? steps("pacing.fill_threshold", "Fill threshold", threshold, 50, 100) : ""}` : "<small>Settings unavailable.</small>")}
 ${section("Strategies", `${strategies.map((e) => `<div class="row"><strong class="grow">${h(e.name)}</strong>${button(`strategy-${e.name}`, e.active ? "Active" : "Use", { cmd: "use", strategy: e.name }, e.active ? "Current strategy" : "")}</div>`).join("")}<div class="actions">${cfg ? `<button data-view="strategy"${disabled}>New strategy</button>` : ""}${terminal("init", "Configure pacer", "init")}</div>`)}
 ${section("Updates", `<small>${h(view.updates?.available ? `Update available: ${view.updates.latest}` : `pacer ${view.updates?.cli ?? view.updates?.plugin ?? s.console?.version ?? "version unknown"}`)}</small><div class="actions">${button("check-updates", "Check for updates", { cmd: "check-updates" })}${button("update", "Update", { cmd: "update" })}</div>`)}
 ${section("Plugin", `<small>Notifications: ${h(view.notifications ?? "important")}</small><div class="actions segmented" role="group" aria-label="Notifications">${["off", "important", "all"].map((level) => button(`notify-${level}`, level, { cmd: "notify-level", level }, "", false, level === (view.notifications ?? "important"))).join("")}</div><div class="row"><span class="grow">Update checks: ${cfg ? view.updateCheck === false ? "off" : "on" : "unknown"}</span>${cfg ? set("update-check", view.updateCheck === false ? "Enable" : "Disable", "update_check", String(view.updateCheck === false)) : ""}</div><small>Automatic console: ${view.autoConsole === false ? "off" : "on"} · Orca settings</small>`)}
 ${actionStatus}</div>`.replace(/<div class="actions"><\/div>/g, "");
}

// src/view-model/panel.ts
var providerLabel = (p) => p.agent ? runnerLabel(p) : displayName2(p.id);
function initialView(s, reachable, now) {
  return reachable && s.budget && [...s.consoles ?? [], ...s.console ? [s.console] : []].some((c) => c.handle && now - c.heartbeatAt <= 30) ? "overview" : "setup";
}
var words = { ON_PACE: "Available", OK: "Available", UNMETERED: "Available", AHEAD: "Ahead of pace", BEHIND: "Behind pace", EXPIRING: "Expiring soon", EXPIRING_SOON: "Expiring soon", NEAR_LIMIT: "Near limit", EXHAUSTED: "Out of quota" };
var verdictWords = (v) => Object.hasOwn(words, v) ? words[v] : "Unknown";
var tone = (v) => v === "EXHAUSTED" ? "bad" : ["AHEAD", "NEAR_LIMIT", "EXPIRING", "EXPIRING_SOON"].includes(v) ? "warn" : ["OK", "ON_PACE", "BEHIND", "UNMETERED"].includes(v) ? "good" : "neutral";
function rankedProviders(s) {
  const b = s.budget;
  return (b?.ranked ?? []).filter((r, i, a) => r.id !== b?.planner && a.findIndex((x) => x.id === r.id) === i).map((r) => b?.providers.find((p) => p.id === r.id) ?? { ...r, usedPct: null, pacePct: null, resetsAt: null, window: null, stale: false }).filter((p) => p.verdict !== "EXHAUSTED" && !p.brokenReason && !p.blockedReason && !p.unavailableReason);
}
function mutedProviders(s) {
  const ids = new Set(rankedProviders(s).map((p) => p.id));
  return (s.budget?.providers ?? []).filter((p) => p.id !== s.budget?.planner && !ids.has(p.id));
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
function answerDetail(s, now) {
  const p = s.budget?.providers.find((p) => p.id === s.budget?.planner), top = rankedProviders(s)[0];
  const parts = [];
  if (p?.usedPct != null)
    parts.push(`${providerLabel(p)} has ${Math.round(100 - p.usedPct)}% left${p.resetsAt == null ? "" : ` with ${duration(p.resetsAt - now, true)} to go`}.`);
  else if (p?.resetsAt != null)
    parts.push(`${providerLabel(p)} has ${duration(p.resetsAt - now, true)} to go.`);
  if (top)
    parts.push(`New work goes to ${providerLabel(top)}.`);
  return parts.join(" ");
}
function providerDetail(p, now) {
  if (p.brokenReason)
    return `Not working · ${p.brokenReason}`;
  if (p.blockedReason)
    return "Blocked by you";
  if (p.usedPct !== null)
    return `${Math.round(p.usedPct)}%${p.window ? ` of ${p.window}` : ""} used${p.resetsAt === null ? "" : ` · resets in ${duration(p.resetsAt - now)}`}${p.stale ? " · stale" : ""}`;
  if (p.id === "local")
    return "LM Studio · unmetered";
  return p.verdict === "UNKNOWN" ? "No budget reported" : "No limit reported";
}
function attentionGroups(s, now) {
  const groups = new Map;
  const resolved = new Set(s.tasks.filter((t) => t.state === "done" && t.retryOf).map((t) => t.retryOf));
  for (const t of [...s.tasks].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (t.resolved || t.review || t.dismissed || t.retriedBy && s.tasks.some((retry) => retry.id === t.retriedBy) || resolved.has(t.id) || now - t.updatedAt > 3 * 86400)
      continue;
    if (!["failed", "limit", "partial"].includes(t.state) && !(["running", "queued"].includes(t.state) && !t.executor && !t.attemptStartedAt && !t.runnerAlive && now - t.updatedAt > 600))
      continue;
    const key = t.brokenExecutor ? `broken:${t.brokenExecutor}` : t.goal;
    groups.set(key, [...groups.get(key) ?? [], t]);
  }
  const count = (tasks) => {
    const seen = new Set;
    for (const task of tasks) {
      let t = task;
      while (t && !seen.has(t.id)) {
        seen.add(t.id);
        t = s.tasks.find((p) => p.id === t.retryOf);
      }
    }
    return seen.size;
  };
  return [...groups].map(([_key, tasks]) => ({ count: count(tasks), goal: tasks[0].brokenExecutor ? `${displayName2(tasks[0].brokenExecutor)} is not working` : tasks[0].goal, tasks, latest: tasks[0], stuck: ["running", "queued"].includes(tasks[0].state), retry: rankedProviders(s).find((p) => !tasks.some((t) => t.executor === p.id)) ?? null, ...tasks[0].brokenExecutor ? { brokenExecutor: tasks[0].brokenExecutor, brokenReason: tasks[0].brokenReason } : {} }));
}
function attentionText(g, now) {
  if (g.brokenExecutor)
    return `${displayName2(g.brokenExecutor)} is not working: ${g.brokenReason ?? "CLI startup failed"} · ${g.tasks.length} tasks affected`;
  if (g.stuck)
    return `Waiting ${duration(now - g.latest.updatedAt)} with no executor picked`;
  if (g.latest.state === "partial")
    return `Needs review${g.latest.executor ? ` on ${displayName2(g.latest.executor)}` : ""}`;
  const count = g.count, label = g.latest.state === "limit" ? "Hit a limit" : "Failed";
  return `${label}${count === 2 ? " twice" : count > 2 ? ` ×${count}` : ""}${g.latest.executor ? ` on ${displayName2(g.latest.executor)}` : ""}`;
}
var unavailableDetail = (p, now) => p.blockedReason ? "Blocked by you" : p.brokenReason ? `Not working · ${p.brokenReason}` : p.unavailableReason ? `usage-only · ${p.unavailableReason}${p.usedPct === null ? "" : ` · ${Math.round(p.usedPct)}% used`}` : p.verdict === "EXHAUSTED" ? `out of quota · ${backIn(p.resetsAt, now)}` : "not in the queue";
// orca-plugin/src/panel/icons.ts
var paths = { "claude-code": "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z", cursor: "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23", agy: "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81", byteplus: "M19.8772 1.4685L24 2.5326v18.9426l-4.1228 1.0563V1.4685zm-13.3481 9.428l4.115 1.0641v8.9786l-4.115 1.0642v-11.107zM0 2.572l4.115 1.0642v16.7354L0 21.428V2.572zm17.4553 5.6205v11.107l-4.1228-1.0642V9.2568l4.1228-1.0642z", local: "M14.025 0c3.492 0 5.237 0 6.571.68a6.24 6.24 0 0 1 2.725 2.724C24 4.738 24 6.484 24 9.975v4.05c0 3.492 0 5.237-.68 6.571a6.24 6.24 0 0 1-2.724 2.725c-1.334.679-3.08.679-6.571.679h-4.05c-3.492 0-5.237 0-6.571-.68A6.24 6.24 0 0 1 .68 20.597C0 19.262 0 17.516 0 14.025v-4.05c0-3.492 0-5.237.68-6.571A6.23 6.23 0 0 1 3.404.68C4.738 0 6.484 0 9.975 0zM7.688 16.313a1.313 1.313 0 0 0 0 2.625h11.625a1.313 1.313 0 0 0 0-2.625zm-3-3.75a1.313 1.313 0 0 0 0 2.624h11.625a1.313 1.313 0 0 0 0-2.624zm3-3.75a1.313 1.313 0 0 0 0 2.624h11.625a1.313 1.313 0 0 0 0-2.624zm-3-3.75a1.313 1.313 0 0 0 0 2.625h11.625a1.313 1.313 0 0 0 0-2.625z" };
function icon(id, size = 16) {
  const name = escapeHtml(displayName2(id));
  return Object.hasOwn(paths, id) ? `<svg role="img" aria-label="${name}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"><path d="${paths[id]}"></path></svg>` : `<span class="monogram" role="img" aria-label="${name}" style="width:${size}px;height:${size}px">${escapeHtml(id === "codex" ? "Cx" : id.slice(0, 2))}</span>`;
}
var mark = `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48"><rect x="4" y="20" width="40" height="8" rx="4" fill="var(--border)"></rect><rect x="4" y="20" width="22" height="8" rx="4" fill="currentColor"></rect><rect class="brand-tick" x="29" y="12" width="4" height="24" rx="2"></rect></svg>`;
var info = `<svg role="img" aria-label="Information" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="flex-shrink:0"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v6M12 7v1"></path></svg>`;

// orca-plugin/src/panel/overview.ts
function focusAttrs(t, commands) {
  if (!t.terminalPresent || !/^[A-Za-z0-9_-]{1,128}$/.test(t.id))
    return "";
  const key = `focus-${t.id}`;
  commands[key] = { cmd: "focus", taskId: t.id };
  return ` role="button" tabindex="0" data-focus="${h(key)}" aria-label="Open task session"`;
}
function placementLine(t) {
  return t.placement ? `<small class="muted">${h(`${t.placement.mode} worktree${t.placement.mode === "new" && t.worktree ? ` ${t.worktree}` : ""} (${t.placement.why})`)}</small>` : "";
}
function meter(p, slim = false) {
  if (p.usedPct === null)
    return "";
  const used = Math.max(0, Math.min(100, p.usedPct)), pace = p.pacePct == null ? null : Math.max(0, Math.min(100, p.pacePct));
  return `<div class="meter ${slim ? "slim" : ""} ${tone(p.verdict)}" role="progressbar" aria-label="${h(providerLabel(p))} usage${pace === null ? "" : `, pace ${pace}%`}" aria-valuenow="${used}" aria-valuemin="0" aria-valuemax="100"><div class="fill" style="width:${used}%"></div>${pace === null ? "" : `<div class="pace" style="left:${pace}%"></div>`}</div>`;
}
function connectionIndicator(s, now, reachable) {
  const old = now - (s.budget?.generatedAt ?? s.at) > 120;
  return `<span class="name live ${reachable ? old ? "warn" : "good" : "bad"}"><span class="dot"></span><span data-freshness>${reachable ? `Live · ${h(time(s.budget?.generatedAt ?? s.at))}` : "Not connected"}</span></span>`;
}
function header(s, now, reachable) {
  return `<header><span class="brand name">${mark}pacer</span>${s.budget ? `<span class="pill">${h((s.mode?.mode ?? s.budget.mode).replace(/^./, (c) => c.toUpperCase()))} mode</span>` : ""}<span class="grow"></span>${connectionIndicator(s, now, reachable)}<button type="button" data-view="settings" aria-label="Settings">⚙</button></header>`;
}
function strategyPicker(_s) {
  return `<section id="strategy-picker" hidden></section>`;
}
function overview(s, now, reachable, commands, text, rows = "", feedback = "") {
  const p = s.budget?.providers.find((p) => p.id === s.budget?.planner), attention = attentionGroups(s, now);
  return `<div class="content">${header(s, now, reachable)}${rows}
 <div class="card stack answer"><div class="stack"><div class="headline">${h(headline(p, now))}</div><div class="muted">${h(answerDetail(s, now))}</div></div>${p ? `<div class="stack"><div class="row"><span class="name">${icon(p.id, 14)}${h(providerLabel(p))}</span><small>planner</small><span class="grow"></span><span class="percent">${p.usedPct === null ? "—" : `${Math.round(p.usedPct)}%`}</span><small>used</small></div>${meter(p)}<div class="row"><small>Pace marker ${p.pacePct == null ? "—" : `${p.pacePct}%`}</small><span class="grow"></span><small>${p.resetsAt === null ? "Reset unknown" : `Resets ${h(new Date(p.resetsAt * 1000).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }))}`}</small></div></div>` : ""}</div>
 <section class="stack section"><div class="row"><h2>Who runs next</h2><span class="grow"></span><small>in this order</small></div><div class="list" id="ranked-list"></div><div class="stack unavailable" id="unavailable-list"></div></section>
 <section class="stack section"><div class="row"><h2>Needs attention</h2>${attention.length ? `<span class="pill bad">${attention.length}</span>` : ""}</div>${attention.slice(0, 10).map((g, i) => {
    const key = `attention-${i}`, review = g.latest.state === "partial";
    text[key + "-goal"] = g.goal.length > 96 ? g.goal.slice(0, 93) + "…" : g.goal;
    text[key + "-detail"] = attentionText(g, now) + (g.stuck ? "" : ` · ${age(g.latest.updatedAt, now)}`);
    if (g.retry)
      text[key + "-executor"] = displayName2(g.retry.id);
    if (g.stuck && /^[A-Za-z0-9_-]{1,128}$/.test(g.latest.id))
      commands[key] = { cmd: "stop", taskId: g.latest.id };
    else if (g.retry && /^[A-Za-z0-9_-]{1,128}$/.test(g.latest.id) && /^(?=.{1,64}$)[a-z0-9-]+(?:#[a-z0-9-]+)?$/.test(g.retry.id))
      commands[key] = g.brokenExecutor ? { cmd: "retry-all", taskIds: g.tasks.map((t) => t.id), executor: g.retry.id } : { cmd: "retry", taskId: g.latest.id, executor: g.retry.id };
    if (!g.stuck)
      commands[key + "-dismiss"] = { cmd: "dismiss", ...g.tasks.length > 1 ? { taskIds: g.tasks.map((t) => t.id) } : { taskId: g.latest.id } };
    return `<div class="card stack attention ${g.stuck ? "stuck" : ""}"${focusAttrs(g.latest, commands)}><div class="row"><span class="${g.stuck ? "warn" : "bad"}" aria-hidden="true">${g.stuck ? "◐" : "✕"}</span><div class="stack grow"><span class="task-goal"><span data-text="${key}-goal"></span></span><small><span data-text="${key}-detail"></span></small>${placementLine(g.latest)}${review && g.latest.worktree ? `<small>${h(g.latest.worktree)}</small>` : ""}</div></div><div class="actions">${review ? `<button type="button" class="primary" data-command="${key}-dismiss">Dismiss</button>` : ""}${commands[key] ? `<button type="button" class="${g.stuck || review ? "" : "primary"}" data-command="${key}">${g.stuck ? "Stop it" : `${g.brokenExecutor ? "Retry all" : "Retry"} on <span data-text="${key}-executor"></span>`}</button>` : "<small>No other executor available.</small>"}${!g.stuck && !review ? `<button type="button" data-command="${key}-dismiss">Dismiss</button>` : ""}</div></div>`;
  }).join("")}${attention.length > 10 ? `<small>${attention.length - 10} more groups need attention. View all with pacer tasks.</small>` : ""}${attention.length ? "" : "<small>Nothing needs attention.</small>"}</section>
 <section class="stack section"><h2>Running</h2>${s.tasks.filter((t) => ["running", "queued"].includes(t.state)).map((t) => `<div class="card stack running-task"${focusAttrs(t, commands)}><span>${h(t.goal)}</span><small>${t.executor ? `Running on ${h(displayName2(t.executor))} · started <span data-age-at="${t.attemptStartedAt ?? t.updatedAt}">${Math.max(0, Math.floor(now - (t.attemptStartedAt ?? t.updatedAt)))}s ago</span>` : "Queued"}${t.retryOf ? ` · Retry of ${h(t.retryOf)}` : ""}</small>${placementLine(t)}</div>`).join("") || "<small>No tasks running.</small>"}</section>
 <section class="stack section"><h2>Recently done</h2><div class="stack recent">${[...s.tasks].filter((t) => t.state === "done").sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3).map((t) => `<div class="row"><span class="good" aria-hidden="true">✓</span><div class="stack grow"><span class="ellipsis" title="${h(t.goal.slice(0, 100))}">${h(t.goal.slice(0, 100))}</span><small>${h(t.executor ? displayName2(t.executor) : "—")} · ${h(age(t.updatedAt, now))}</small></div></div>`).join("")}${s.tasks.some((t) => t.state === "done") ? "" : "<small>No completed tasks yet.</small>"}</div></section>
 ${strategyPicker(s)}</div><div class="actionbar"><div class="actions"><button type="button" class="primary grow" data-view="delegate" data-live>Delegate a task</button><button type="button" data-view="strategy" data-live>Strategy</button><button type="button" class="refresh" data-command="refresh" aria-label="Refresh">↻</button></div>${feedback || actionStatus}<div class="footnote">Updated <span data-updated>—</span> · <span data-console-connection>Checking console...</span></div></div>`;
}

// orca-plugin/src/panel/setup.ts
function legacyChecklist(s, now, reachable, bootstrap) {
  return setupChecklist({ version: bootstrap?.install.status === "done" ? s.console?.version ?? "installed" : null, planner: s.budget?.planner ?? null, service: { installed: bootstrap?.start.status === "done" || !!s.serviceInstalled, running: reachable }, link: reachable, live: true, agents: bootstrap?.agents ?? [] }, now);
}
function detail(i) {
  if (i.detail)
    return i.detail.replace(/^Optional · /, "").replace(/^not connected$/, "Not connected");
  if (i.status === "failed")
    return "Needs attention";
  if (i.status === "done")
    return i.id === "service" ? "Running" : i.id === "strategy" ? "Configured" : "Connected";
  return i.id === "service" ? "Not running yet" : i.id === "binary" ? "Not installed yet" : i.id === "strategy" ? "Not configured yet" : "Not connected";
}
function checklist(s, consoleLive) {
  const rows = (required) => s.items.filter((i) => i.required === required).map((i) => `<div class="step ${i.status}"><span class="step-num" aria-hidden="true">${i.status === "done" ? "✓" : i.status === "failed" ? "!" : "·"}</span><div class="stack grow"><strong>${h(i.title)}</strong><small>${h(detail(i))}</small></div></div>`).join("");
  const optional = rows(false);
  return `<div class="stack"><div class="list">${rows(true)}</div>${optional ? `<section class="stack optional"><h2>Optional</h2><div class="list">${optional}</div></section>` : ""}<small data-setup-checked="${s.checkedAt}">Checked 0 s ago</small>${consoleLive ? '<button type="button" data-command="checkSetup" data-setup-check>Check now</button>' : ""}<small data-setup-auto${consoleLive ? " hidden" : ""}>Re-checks every 5 seconds</small></div>`;
}
function setup(s, now, reachable, bootstrap, state, consoleLive = false, consoleHint = "") {
  return `<div class="content"><header class="brand">${mark}<strong class="grow">pacer</strong><button type="button" data-view="settings" aria-label="Settings">⚙</button></header><h1 class="headline">Setup</h1><div class="note stack"><strong>Finish setup in a terminal:</strong><code class="command" style="user-select:all">pacer init</code></div>${checklist(state ?? legacyChecklist(s, now, reachable, bootstrap), consoleLive)}${consoleHint}</div><div class="actionbar">${actionStatus}</div>`;
}

// orca-plugin/src/panel/delegate.ts
function delegateView(s, now, reachable) {
  return `<div id="delegate-form" role="group"><div class="content"><header><button type="button" data-view="overview" aria-label="Back to overview">←</button><strong>Delegate a task</strong><span class="grow"></span>${connectionIndicator(s, now, reachable)}</header><div class="muted">Write it the way you'd brief a colleague who can't see this chat. Claude plans; the task runs on an executor.</div><div class="stack"><label for="goal">What should be done?</label><textarea id="goal" name="goal" maxlength="2000" rows="5" placeholder="e.g. Make the owner-facing diag calls accept browser_turn_id, with a regression test"></textarea></div><div class="stack"><strong>Where</strong><div class="stack where"><strong data-worktree>—</strong><small>Branch <span id="worktree-branch">—</span> · focused worktree</small></div></div><div class="stack"><label for="done">Done when</label><input id="done" name="acceptance" type="text" maxlength="500" placeholder="A command that passes, e.g. bun test"><small>pacer runs it after the executor finishes and only reports done if it passes.</small></div><fieldset class="stack"><legend>Runs on</legend><label class="radio"><input type="radio" name="executor" value="" checked><span class="stack grow"><strong>Best available</strong><small><span id="ranked-order"></span></small></span><span class="pill">Recommended</span></label><div id="executor-options" class="stack"></div></fieldset><div class="row note"><strong aria-hidden="true">i</strong><small>Runs in its own worktree. You'll get a notification when it finishes, and it shows under Needs attention if it fails.</small></div></div><div class="actionbar"><div class="actions"><button type="button" data-view="overview">Cancel</button><button type="button" id="delegate-send" class="primary grow" data-live>Delegate</button></div>${actionStatus}</div></div>`;
}

// orca-plugin/src/panel/style.ts
var style = `
.content{overflow-wrap:anywhere}header{flex-wrap:wrap}.updates,.setup-summary{padding:10px}.optional{margin-top:8px;color:var(--muted-foreground)}.optional .list{background:none}.optional .step-num{background:var(--muted);border-color:var(--border);color:var(--muted-foreground)}.actions{flex-wrap:wrap}.actionbar .actions{flex-wrap:nowrap}#delegate-form{display:flex;flex-direction:column;flex:1;min-width:0}

.step.failed .step-num{color:var(--bad)}

[data-focus]{cursor:pointer;transition:background .12s}[data-focus]:hover{background:var(--hover,rgba(128,128,128,.08))}[data-focus]:focus-visible{outline:2px solid currentColor;outline-offset:2px}

.action-spinner{display:inline-block;animation:console-spin 1s linear infinite}@media(prefers-reduced-motion:reduce){.action-spinner{animation:none}}
.running-task{padding:10px}
.action-status{margin:4px 0;color:var(--muted-foreground);white-space:pre-wrap;overflow-wrap:anywhere}.action-status:empty{display:none}

.console-spinner{display:inline-block;animation:console-spin 1s linear infinite}@keyframes console-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.console-spinner{animation:none}}

*{box-sizing:border-box}body{margin:0;background:var(--background);color:var(--foreground);font-size:12px;font-family:var(--app-font-family,'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif);line-height:1.4;letter-spacing:.01em;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;--good:color-mix(in srgb,seagreen 90%,var(--background));--warn:color-mix(in srgb,darkorange 90%,var(--background));--bad:color-mix(in srgb,crimson 90%,var(--background))}[hidden]{display:none!important}.view{min-height:100vh;display:flex;flex-direction:column}.content{padding:12px;display:flex;flex-direction:column;gap:12px;flex:1;min-width:0}.row,.name,header,.actions{display:flex;align-items:center;gap:8px}.grow{flex:1;min-width:0}.stack{display:flex;flex-direction:column;gap:6px;min-width:0}.brand{font-weight:600;font-size:14px;letter-spacing:.01em}.brand-tick{fill:#65A30D}@media(prefers-color-scheme:dark){.brand-tick{fill:#A3E635}body{--good:color-mix(in srgb,mediumseagreen 90%,var(--background));--warn:color-mix(in srgb,orange 90%,var(--background));--bad:color-mix(in srgb,lightcoral 90%,var(--background))}}.muted,small{color:var(--muted-foreground)}small{font-size:11px}.pill{font-size:10px;font-weight:500;padding:2px 6px;border-radius:6px;background:var(--muted);white-space:nowrap}.good{color:var(--good)}.warn{color:var(--warn)}.bad{color:var(--bad)}.pill.good{background:color-mix(in srgb,green 12%,var(--background))}.pill.warn{background:color-mix(in srgb,orange 16%,var(--background))}.pill.bad{background:color-mix(in srgb,crimson 12%,var(--background))}.dot{width:8px;height:8px;border-radius:50%;background:currentColor}.live{font-size:11px;white-space:nowrap}.card,.list{border:1px solid var(--border);border-radius:calc(var(--radius,10px) - 2px);background:var(--card)}.answer{padding:12px;gap:8px}.headline{font-size:13px;font-weight:600}h2{font-size:10px;letter-spacing:.06em;text-transform:uppercase;font-weight:500;margin:0;color:var(--muted-foreground)}.section{gap:8px}.provider{padding:8px 10px;gap:6px}.provider+.provider,.step+.step{border-top:1px solid var(--border)}.rank{width:18px;height:18px;flex-shrink:0;background:var(--muted);border-radius:6px;display:grid;place-items:center;font-size:11px;font-weight:600}.provider:first-child .rank{background:var(--foreground);color:var(--background)}.name{font-weight:500;gap:6px;overflow-wrap:anywhere}.name svg,.monogram{flex-shrink:0}.monogram{border-radius:4px;background:var(--foreground);color:var(--background);display:inline-flex;align-items:center;justify-content:center;font-size:8px;font-weight:600}.meter{position:relative;height:6px;background:var(--border);border-radius:999px;margin:4px 0}.meter.slim{height:3px;margin-left:26px}.meter .fill{height:100%;border-radius:999px;background:currentColor}.pace{position:absolute;width:2px;top:-4px;bottom:-4px;background:var(--foreground);border-radius:2px}.percent{font-size:18px;font-weight:600}.unavailable{font-size:11px;padding:0 4px;gap:4px}.attention{padding:10px;gap:8px;border-color:color-mix(in srgb,crimson 25%,var(--background));background:color-mix(in srgb,crimson 2%,var(--card))}.attention.stuck{border-color:color-mix(in srgb,orange 35%,var(--background));background:color-mix(in srgb,orange 3%,var(--card))}.task-goal{font-weight:500;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.recent{gap:8px}button,input,textarea,select{font:inherit;color:var(--foreground)}button{white-space:nowrap;flex-shrink:0;min-height:28px;padding:0 10px;border:1px solid var(--border);border-radius:calc(var(--radius,10px) - 2px);background:var(--background);cursor:pointer}button.primary{min-height:32px;background:var(--primary);color:var(--background);font-weight:500;border-color:var(--primary)}button:disabled{opacity:.4;border-color:transparent;cursor:default}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--primary);outline-offset:2px}.actionbar{position:sticky;bottom:0;padding:8px 12px 10px;border-top:1px solid var(--border);background:var(--background);display:flex;flex-direction:column;gap:8px}.actionbar button,.actionbar button.primary{height:32px;min-height:32px}.actionbar .refresh{width:32px;min-width:32px;padding:0}.footnote{font-size:11px;text-align:center;color:var(--muted-foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.step{padding:10px;display:flex;gap:8px}.step-num{width:22px;height:22px;border:2px solid var(--border);border-radius:50%;display:grid;place-items:center;flex-shrink:0;font-size:11px;font-weight:600}.step.done .step-num{background:var(--good);border-color:var(--good);color:var(--background)}.command,.where{padding:6px 6px 6px 10px;border-radius:calc(var(--radius,10px) - 2px);background:var(--muted)}code{font:11px ui-monospace,monospace;overflow-wrap:anywhere}.last-known{padding:10px;border-style:dashed;color:var(--muted-foreground)}.last-known .fill{background:var(--muted-foreground)}.note{padding:10px;background:var(--muted);border-radius:calc(var(--radius,10px) - 2px);color:var(--muted-foreground)}.note.info{background:color-mix(in srgb,dodgerblue 9%,var(--background))}textarea,input[type=text]{background:var(--background);border:1px solid var(--border);border-radius:calc(var(--radius,10px) - 2px);padding:6px 10px;width:100%}textarea{resize:vertical}input[type=text]{min-height:28px}strong,label,legend{font-weight:500}header>strong{font-weight:600}.where{padding:8px 10px}fieldset{border:0;padding:0;margin:0;min-width:0}legend{margin-bottom:6px}.radio{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:calc(var(--radius,10px) - 2px);font-weight:400;cursor:pointer;min-height:32px}.radio:has(input:checked){outline:1px solid var(--foreground);border-color:var(--foreground)}.radio:has(input:disabled){color:var(--muted-foreground);cursor:default}.radio input{margin:0;width:14px;height:14px}.radio strong{font-weight:500}
select{height:28px;background:var(--background);border:1px solid var(--border);border-radius:8px;padding:0 8px;min-width:0}.strategy-list{overflow:hidden}.strategy-list button{width:100%;border:0;border-radius:0;padding:8px 10px;text-align:left}.strategy-list button+button{border-top:1px solid var(--border)}.strategy-list small{white-space:normal}.strategy-builder{padding:12px;gap:10px;flex:0;background:var(--muted)}.strategy-saved{padding:10px;background:color-mix(in srgb,green 3%,var(--card));border-color:color-mix(in srgb,green 25%,var(--background))}
`;
var settingsStyle = `.segmented{flex-wrap:wrap;gap:4px}.segmented button{white-space:normal;overflow-wrap:anywhere;max-width:100%}.segmented button[aria-pressed=true]{background:var(--foreground);color:var(--background);border-color:var(--foreground);font-weight:500}.segmented button[aria-pressed=true]:disabled{border-color:transparent}.disabled-action{display:inline-flex;flex-direction:column;gap:4px;min-width:0}.disabled-action small{white-space:normal}`;

// orca-plugin/src/panel/strategy.ts
function strategyView(s, now, reachable, notifications = "important") {
  const agents = ["claude-code", "codex"].filter((id) => id === s.budget?.planner || s.budget?.providers.some((p) => p.id === id));
  return `<div class="content"><header><button type="button" data-view="overview" aria-label="Back to overview">←</button><strong>Strategy</strong><span class="grow"></span>${connectionIndicator(s, now, reachable)}</header>
 <section class="stack"><label>Notifications<select id="notification-level">${["important", "all", "off"].map((level) => `<option value="${level}"${level === notifications ? " selected" : ""}>${level === "important" ? "Important" : level === "all" ? "All" : "Off"}</option>`).join("")}</select></label></section>
 <section class="stack"><h2>Switch to</h2><div class="list strategy-list" id="strategy-list"></div></section>
 <div id="strategy-form" role="group" class="card stack strategy-builder"><strong>Build a new strategy with an agent</strong><small>Describe what you want. The agent drafts it, shows how routing would change, and asks before saving.</small>
 <label for="strategy-brief">What should it do?</label><textarea id="strategy-brief" rows="4" maxlength="2000" placeholder="e.g. Protect Claude this week. Burn Codex before it resets on Sunday."></textarea>
 <div class="row"><label class="stack grow">Start from<select id="strategy-from"></select></label><label class="stack grow">Agent<select id="strategy-agent">${agents.map((id) => `<option value="${id}"${id === s.budget?.planner ? " selected" : ""}>${id === "claude-code" ? "Claude Code" : "Codex"}${id === s.budget?.planner ? " (planner)" : ""}</option>`).join("")}</select></label></div>
 <div class="note row">${info}<small>Opens a new terminal in this worktree with the agent already briefed. You chat with it there; nothing changes until you approve the save. Switching stays a separate click here.</small></div></div>
 <section id="strategy-after" class="stack" hidden></section></div><div class="actionbar"><div class="actions"><button type="button" data-view="overview">Done</button><button type="button" id="strategy-send" class="primary grow" data-live${agents.length ? "" : " disabled"}>Start session</button></div>${actionStatus}</div>`;
}

// orca-plugin/src/panel/pending.ts
var pendingClient = `
const actionStorage="pacer-pending-actions";
let actionStates={};
try {const saved=JSON.parse(sessionStorage.getItem(actionStorage)||"{}");if(saved && !Array.isArray(saved))actionStates=saved;}catch{}
const actionButtons=new Map();
function saveActions(){try{sessionStorage.setItem(actionStorage,JSON.stringify(actionStates));}catch{}}
function actionKey(c){return c.cmd+":"+(c.key?c.key+":"+c.value:c.name||c.command||c.taskId||c.taskIds?.join(",")||c.executor||c.strategy||c.level||c.goal||c.from||c.text||"");}
function actionLabel(c){const name=data.rows.find(p=>p.id===c.executor)?.name||c.executor||"executor";return ({focus:"Opening session...",retry:"Retrying on "+name+"...","retry-all":"Retrying all on "+name+"...",stop:"Stopping...",dismiss:"Dismissing...",delegate:"Delegating...","strategy-build":"Starting session...",use:"Switching...",block:"Blocking...",unblock:"Unblocking...",refresh:"Refreshing...","notify-level":"Saving preference...",type:"Typing command..."})[c.cmd]||"Working...";}
function outcome(a){
 const c=a.action,t=data.tasks||[],ids=c.taskIds||[c.taskId],p=[...data.rows,...data.muted].find(p=>p.id===c.executor);
 if(c.cmd==="retry"||c.cmd==="retry-all")return ids.every(id=>t.some(x=>x.retryOf===id)||t.find(x=>x.id===id)?.retriedBy);
 if(c.cmd==="focus")return (data.focusAlerts||[]).some(e=>e.key==="focus-"+c.taskId && e.level==="info" && e.at>=a.startedAt);
 if(c.cmd==="stop")return ids.every(id=>t.some(x=>x.id===id&&!["queued","running"].includes(x.state)));
 if(c.cmd==="dismiss")return ids.every(id=>!t.some(x=>x.id===id)||t.find(x=>x.id===id)?.dismissed);
 if(c.cmd==="delegate")return t.some(x=>!a.known.includes(x.id)&&(x.goal===c.goal||x.goal===c.goal.slice(0,197)+"..."));
 if(c.cmd==="block"||c.cmd==="unblock")return p && !!p.blocked===(c.cmd==="block");
 if(c.cmd==="use")return data.strategy===c.strategy;
 if(c.cmd==="strategy-build")return data.buildAlert && data.buildAlert.at>=a.startedAt;
 if(c.cmd==="refresh")return data.sequence>a.sequence;
 if(c.cmd==="notify-level")return data.notifications===c.level;
 if(c.cmd==="config-set")return data.prefs?.values[c.key]===c.value;
 if(c.cmd==="account-remove")return data.prefs && !data.prefs.accounts.includes(c.name);
 if(c.cmd==="runner-remove")return data.prefs && !data.prefs.runners.includes(c.name);
 if(c.cmd==="type"||c.cmd==="open-terminal")return a.accepted;
 return false;
}
function restoreAction(key){const entry=actionButtons.get(key);if(entry){entry.button.disabled=entry.disabled;if(actionStates[key]?.action.cmd!=="focus")entry.button.innerHTML=entry.html;entry.card?.removeAttribute?.("aria-busy");}actionButtons.delete(key);delete actionStates[key];saveActions();}
function paintAction(key,button){
 const a=actionStates[key];if(!a)return;
 if(!actionButtons.has(key))actionButtons.set(key,{button,disabled:button.disabled,html:button.innerHTML,card:button.closest?.(".card,.row,.actionbar")});
 button.disabled=true;if(a.action.cmd!=="notify-level"&&a.action.cmd!=="focus")button.innerHTML='<span class="action-spinner" aria-hidden="true">◐</span> '+h(actionLabel(a.action));
 actionButtons.get(key).card?.setAttribute?.("aria-busy","true");
}
function beginAction(button,action){
 const key=actionKey(action);if(actionStates[key]||button.disabled)return null;
 actionStates[key]={action,target:action.taskId||action.executor||action.strategy||"",startedAt:Date.now()/1000,known:(data.tasks||[]).map(t=>t.id),sequence:data.sequence};
 paintAction(key,button);saveActions();if(typeof setTimeout==="function")setTimeout(()=>recoverActions(),60000);return key;
}
function pendingSend(button,command,after,workspace){
 const key=beginAction(button,command);if(!key)return false;
 return sendCommand(command,value=>{if(actionStates[key]){actionStates[key].accepted=true;saveActions();}if(after)after(value);},()=>{restoreAction(key);if(!status.textContent)status.textContent="The console could not accept this action. Try again.";const card=button.closest?.(".card,.row,.actionbar");if(card?.insertAdjacentHTML)card.insertAdjacentHTML("beforeend",'<p role="alert" class="action-error">The console could not accept this action. Try again.</p>');},workspace);
}
function recoverActions(){
 for(const [key,a] of Object.entries(actionStates)){
  if(!a||typeof a.startedAt!=="number"||!a.action){delete actionStates[key];continue;}
  const rejection=(data.actionErrors||[]).find(e=>e.key===(a.action.cmd==="focus"?"focus-":"retry-")+a.action.taskId&&e.at>=a.startedAt);
  if(rejection){restoreAction(key);status.textContent=rejection.body;continue;}
  if(outcome(a)){restoreAction(key);if(a.action.cmd==="notify-level")status.textContent="Notification preference saved.";continue;}
  const button=actionButtons.get(key)?.button;
  if(Date.now()/1000-a.startedAt>=60){
   if(button){button.disabled=false;if(a.action.cmd!=="focus")button.innerHTML=actionButtons.get(key).html;}
   restoreAction(key);
   status.textContent="Still waiting for the pacer console. Check the pacer tab in this worktree.";
  }else if(button)paintAction(key,button);
 }
 saveActions();
}
function bindAction(button,action){const key=actionKey(action);if(actionStates[key]){if(outcome(actionStates[key])){restoreAction(key);if(action.cmd==="notify-level")status.textContent="Notification preference saved.";}else paintAction(key,button);}}
`;

// orca-plugin/src/panel/client.ts
var accountGroupsClient = `function groupedRows(rows,render) {
 const groups=new Map();
 rows.forEach((p,i)=>{const key=p.account || "";if(!groups.has(key))groups.set(key,[]);groups.get(key).push([p,i]);});
 return Array.from(groups,([account,entries])=>(account?'<div class="muted account-group">Account '+h(account)+'</div>':'')+entries.map(([p,i])=>render(p,i)).join("")).join("");
}
`;
var compactNames = { notificationControl: "_s0", strategyEntries: "_s1", submitButton: "_s2", updateContext: "_s3", sendCommand: "_s4", updateFreshness: "_s6", seenStrategies: "_s7", actionStates: "_s8", pendingSend: "_s9", statusNode: "_s10", recoverActions: "_s11", afterSession: "_s12", finishSending: "_s13", rankedList: "_s14", mutedList: "_s15", savedStrategy: "_s16", sentAt: "_s17", actionStorage: "_c17", actionButtons: "_c18", saveActions: "_c19", actionKey: "_c20", actionLabel: "_c21", restoreAction: "_c22", paintAction: "_c23", beginAction: "_c24", bindAction: "_c25", onFailure: "_f", pending: "_p" };
var client = (accounts = false) => `
const embedded=JSON.parse(document.getElementById("pacer-actions").textContent);
function unpack(value) {
 if(Array.isArray(value)) return value.map(unpack);
 if(value && typeof value==="object") return Object.hasOwn(value,"$runs") ? value.$runs.map(([c,n])=>c.repeat(n)).join("") : Object.fromEntries(Object.entries(value).map(([k,v])=>[k,unpack(v)]));
 return value;
}
const data=unpack(embedded.encoded ? JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(embedded.encoded), c=>c.charCodeAt(0)))) : embedded);
const runnerId=/^(?=.{1,64}$)[a-z0-9-]+(?:#[a-z0-9-]+)?$/;
const names=${JSON.stringify(names2)};
for(const p of [...data.rows,...data.muted])p.name||=Object.hasOwn(names,p.id)?names[p.id]:p.id;
data.executors=data.rows.map(p=>p.id);
const statusNode=document.getElementById("status");
const status={ get textContent() { return statusNode.textContent; }, set textContent(value) {
 statusNode.textContent=value;
 for (const el of document.querySelectorAll("[data-status]")) el.textContent=value;
} };
if(data.buildAlert) status.textContent=data.buildAlert.title+(data.buildAlert.body?": "+data.buildAlert.body:"");
const sentAt=[], pending=new Map();
let sequence=0, context=null, sending=false;
const submitButton=document.getElementById("delegate-send");
function finishSending() { sending=false; submitButton.disabled=false; }
function show(view) {
  if(view==="strategy" && savedStrategy) {try {sessionStorage.setItem("pacer-seen-strategies",JSON.stringify([...seenStrategies,savedStrategy.key+":"+savedStrategy.at].slice(-100)));}catch {}}
  for (const el of document.querySelectorAll("[data-page]")) el.hidden=el.dataset.page!==view;
  status.textContent="";
  try {sessionStorage.setItem("pacer-panel-view",view);}catch{}
}
function live(workspace) {
  const available=data.consoles.filter(c=>c.handle && c.live);
  const selected=workspace===undefined ? available[0] : available.find(c=>Array.isArray(workspace?.terminals) && workspace.terminals.some(t=>t.id===c.handle));
  if (selected) { if(workspace!==undefined) data.handle=selected.handle; document.getElementById("console-hint").hidden=true; return true; }
  status.textContent=workspace!==undefined && Array.isArray(workspace?.terminals) && workspace.terminals.some(t=>typeof t.title==="string" && /^pacer(?: console)?$/.test(t.title)) ? "Reopen the panel to connect to the new console." : data.autoConsole ? "The pacer console for this worktree is starting. Try again in a few seconds." : "Start the console first.";
  document.getElementById("console-hint").hidden=!document.querySelector('[data-page="setup"]:not([hidden])');
  return false;
}
function updateFreshness() {
  for(const el of document.querySelectorAll("[data-age-at]"))el.textContent=Math.max(0,Math.floor(Date.now()/1000-Number(el.dataset.ageAt)))+"s ago";
  for(const el of document.querySelectorAll("[data-updated]")) el.textContent=data.updatedAt ? new Date(data.updatedAt*1000).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",hour12:false}) : "—";
  const old=Date.now()/1000-data.snapshotAt>120;
  for(const el of document.querySelectorAll("[data-freshness]")) {
    // Unchanged data is not re-rendered (Orca reloads the panel on every write), so age alone is not a fault: show it neutrally.
    el.parentElement.className="name live " + (!data.reachable ? "bad" : old ? "muted" : "good");
    el.textContent=!data.reachable ? "Not connected" : (old ? "Updated " : "Live · ") + new Date(data.snapshotAt*1000).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",hour12:false});
  }
}
updateFreshness(); setInterval(()=>{updateFreshness();recoverActions();},30000);
function request(action, params, purpose, after, onFailure) {
  const now=Date.now();
  while (sentAt.length && now - sentAt[0] >= 10000) sentAt.shift();
  if (sentAt.length >= 30) { status.textContent="Please wait before sending another command."; return false; }
  const requestId="pacer-" + (++sequence), message={type:"orca-panel-action",requestId,action,params};
  if (new TextEncoder().encode(JSON.stringify(message)).length > 65536) { status.textContent="Panel message exceeds 64 KiB."; return false; }
  pending.set(requestId,{purpose,after,onFailure}); sentAt.push(now);
  window.parent.postMessage(message,"*"); return true;
}
function readContext(after, onFailure) { return request("workspace.readContext",{},"context",after,onFailure); }
function sendCommand(command, after, onFailure, workspace) {
  const fail=()=>{ if(onFailure) onFailure(); return false; };
  if (Object.values(command).some(value=>typeof value==="string" && /[\\x7f-\\x9f]/.test(value))) { status.textContent="Input contains unsupported control characters."; return fail(); }
  if (!live()) return fail();
  const send=value=>{
    updateContext(value);
    if (!live(value)) return fail();
    if(command.cmd==="open-terminal" && typeof value?.worktreeId==="string") command={...command,worktreeId:value.worktreeId};
    const text=": pacer '" + JSON.stringify({v:1,type:"cmd",data:command}).replace(/'/g,"\\\\u0027") + "'";
    if (text.length > 4096) { status.textContent="pacer command line exceeds 4096 characters. Shorten your brief and try again."; return fail(); }
    if (!request("terminal.sendText",{terminalId:data.handle,text,enter:true},"console",after,onFailure)) return fail();
    return true;
  };
  if (workspace!==undefined) return send(workspace);
  if (!readContext(send,onFailure)) return fail();
  return true;
}
${pendingClient}
function updateContext(value) {
  context=value && typeof value.branch==="string" && typeof value.displayName==="string" ? value : null;
  for (const el of document.querySelectorAll("[data-worktree]")) el.textContent=context ? context.displayName : "—";
  document.getElementById("worktree-branch").textContent=context ? context.branch : "—";
  const connected=context && data.consoles.some(c=>c.live && Array.isArray(context.terminals) && context.terminals.some(t=>t.id===c.handle));
  for(const el of document.querySelectorAll("[data-setup-check]"))el.hidden=!connected;
  for(const el of document.querySelectorAll("[data-setup-auto]"))el.hidden=!!connected;
  for (const el of document.querySelectorAll("[data-console-connection]")) el.textContent=context ? (connected ? "console connected in " : "console not connected in ") + context.displayName : "console not connected";
}
// Escape data before creating local provider rows; the same nodes populate the radio list.
function h(value) { return String(value ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }
for (const el of document.querySelectorAll("[data-text]")) el.innerHTML=h(data.text[el.dataset.text]);
const strategyEntries=data.strategies.map(e=>typeof e==="string"?{name:e,summary:"",active:e===data.strategy}:e);
document.getElementById("strategy-list").innerHTML=strategyEntries.map((e,i)=>'<button type="button" class="row" data-strategy="'+i+'"'+(e.active?' disabled title="This strategy is already active."':'')+'><span>'+(e.active?'✓':'')+'</span><span class="stack grow"><strong>'+h(e.name)+'</strong><small>'+h(e.summary)+'</small></span>'+(e.active?'<span class="pill">Active</span>':'')+'</button>').join("");
document.getElementById("strategy-from").innerHTML=strategyEntries.map(e=>'<option value="'+h(e.name)+'"'+(e.active?' selected':'')+'>'+h(e.name)+'</option>').join("");
for(const b of document.querySelectorAll("[data-strategy]")) {const entry=strategyEntries[Number(b.dataset.strategy)];if(!entry)continue;const command={cmd:"use",strategy:entry.name};bindAction(b,command);b.addEventListener("click",()=>pendingSend(b,command));}
let seenStrategies=[];
try { seenStrategies=JSON.parse(sessionStorage.getItem("pacer-seen-strategies") || "[]"); if(!Array.isArray(seenStrategies))seenStrategies=[]; } catch {}
const savedStrategy=(data.savedAlerts || []).find(a=>!seenStrategies.includes(a.key+":"+a.at));
const afterSession=document.getElementById("strategy-after");
if(savedStrategy) {
 afterSession.hidden=false;
 afterSession.innerHTML='<h2>After the session</h2><div class="card row strategy-saved"><span class="good">✓</span><div class="stack grow"><strong>'+h(savedStrategy.title)+'</strong><small>'+h(savedStrategy.body)+'</small></div><button type="button" data-saved-switch>Switch</button></div>';
 document.querySelector("[data-saved-switch]")?.addEventListener("click",event=>pendingSend(event.currentTarget,{cmd:"use",strategy:savedStrategy.key.slice("strategySaved-".length)}));
}
document.getElementById("ranked-order").innerHTML=h(data.rows.map(p=>p.name).join(" → ") || "No executor available");
function icon(p,size) {
  return Object.hasOwn(data.paths,p.id) ? '<svg role="img" aria-label="'+h(p.name)+'" width="'+size+'" height="'+size+'" viewBox="0 0 24 24" fill="currentColor"><path d="'+data.paths[p.id]+'"></path></svg>' : '<span class="monogram" role="img" aria-label="'+h(p.name)+'" style="width:'+size+'px;height:'+size+'px">'+h(p.id==="codex" ? "Cx" : p.id.slice(0,2))+'</span>';
}
function meter(p) {
 if(p.usedPct===null) return "";
 const used=Math.max(0,Math.min(100,p.usedPct)), pace=p.pacePct===null?null:Math.max(0,Math.min(100,p.pacePct));
 return '<div class="meter slim '+p.tone+'" role="progressbar" aria-label="'+h(p.name)+' usage" aria-valuenow="'+used+'" aria-valuemin="0" aria-valuemax="100"><div class="fill" style="width:'+used+'%"></div>'+(pace===null?'':'<div class="pace" style="left:'+pace+'%"></div>')+'</div>';
}
const rankedList=document.getElementById("ranked-list"), mutedList=document.getElementById("unavailable-list"), options=document.getElementById("executor-options");
${accounts ? accountGroupsClient : ""}
rankedList.innerHTML=${accounts ? "groupedRows(data.rows," : "data.rows.map("}(p,i)=>'<div class="stack provider"><div class="row"><span class="rank">'+(i+1)+'</span><div class="stack grow"><span class="name">'+icon(p,14)+h(p.name)+'</span><small>'+h(p.detail)+'</small></div><span class="pill '+p.tone+'">'+h(p.words)+'</span><button type="button" data-executor-action="'+i+'">Block</button></div>'+meter(p)+'</div>')${accounts ? "" : '.join("")'} || '<div class="provider muted">No executor available yet.</div>';
mutedList.innerHTML=${accounts ? "groupedRows(data.muted," : "data.muted.map("}(p,i)=>'<div class="row"><span class="name">'+icon(p,13)+h(p.name)+'</span><span>'+h(p.detail)+'</span><button type="button" data-executor-action="'+(data.rows.length+i)+'">'+(p.blocked?'Unblock':'Block')+'</button></div>')${accounts ? "" : '.join("")'};
options.innerHTML=data.rows.map((p,i)=>'<label class="radio"><input type="radio" name="executor" value="'+i+'"><span class="stack grow"><span class="name">'+icon(p,14)+h(p.name)+'</span><small>'+h(p.detail)+'</small></span><span class="pill '+p.tone+'">'+h(p.words)+'</span></label>').join("") + data.muted.filter(p=>p.verdict==="EXHAUSTED").map(p=>'<label class="radio"><input type="radio" name="executor" value="unavailable" disabled><span class="stack grow"><span class="name">'+icon(p,14)+h(p.name)+'</span><small>'+h(p.detail)+'</small></span></label>').join("");
for(const b of document.querySelectorAll("[data-executor-action]")) {
 const provider=[...data.rows,...data.muted][Number(b.dataset.executorAction)];if(provider)bindAction(b,{cmd:provider.blocked?"unblock":"block",executor:provider.id});
 b.addEventListener("click",()=>{
 const p=[...data.rows,...data.muted][Number(b.dataset.executorAction)];
 if(p && runnerId.test(p.id))pendingSend(b,{cmd:p.blocked?"unblock":"block",executor:p.id});
});}
for (const b of document.querySelectorAll("[data-view]")) b.addEventListener("click", ()=>{
  if (["delegate","strategy"].includes(b.dataset.view)) {
    if (!live()) return;
    readContext(value=>{ updateContext(value); if(!live(value)) return; show(b.dataset.view); document.getElementById(b.dataset.view==="delegate" ? "goal" : "strategy-brief").focus(); });
  } else show(b.dataset.view);
});
for(const card of document.querySelectorAll("[data-focus]")) {
 const command=data.commands[card.dataset.focus];if(!command)continue;
 bindAction(card,command);
 card.addEventListener("click",event=>{if(event.target.closest("button,input,select,a"))return;pendingSend(card,command);});
 card.addEventListener("keydown",event=>{if(event.target!==card || !["Enter"," "].includes(event.key))return;event.preventDefault();pendingSend(card,command);});
}
for (const b of document.querySelectorAll("[data-command]")) {
 if(data.commands[b.dataset.command])bindAction(b,data.commands[b.dataset.command]);
 b.addEventListener("click", ()=>{
  const command=data.commands[b.dataset.command];
  if (command && b.dataset.remove) {
   const now=Date.now(), armed=Number(b.dataset.confirmAt);
   if(!Number.isFinite(armed) || now-armed>=5000 || now<armed) {b.dataset.confirmAt=String(now);b.textContent="Confirm remove";status.textContent="Click again within 5 seconds to remove.";return;}
   delete b.dataset.confirmAt;
  }
  if (command) pendingSend(b,command,command.cmd==="check-setup"?()=>{restoreAction(actionKey(command));status.textContent="Setup check requested. The checklist updates when a check changes.";}:undefined); else status.textContent="Reopen the panel to load this action.";
});
}
for (const b of document.querySelectorAll("[data-setup]")) {bindAction(b,{cmd:"type",text:b.dataset.setup});b.addEventListener("click", ()=>{
  const key=beginAction(b,{cmd:"type",text:b.dataset.setup});if(!key)return;
  readContext(value=>{
    updateContext(value);
    const terminal=context && Array.isArray(context.terminals) && context.terminals[0];
    if (!terminal || typeof terminal.id!=="string") { status.textContent="Open a terminal in this worktree first"; restoreAction(key);return; }
    request("terminal.sendText",{terminalId:terminal.id,text:b.dataset.setup,enter:false},"setup",()=>restoreAction(key),()=>restoreAction(key));
  },()=>restoreAction(key));
});}
function setupAge() {
 for(const el of document.querySelectorAll("[data-setup-checked]"))el.textContent="Checked "+Math.max(0,Math.floor(Date.now()/1000-Number(el.dataset.setupChecked)))+" s ago";
}
setupAge();setInterval(setupAge,1000);
for (const b of document.querySelectorAll("[data-check]")) b.addEventListener("click", ()=>{
  if (!data.reachable) {
    status.textContent="Waiting for pacer serve. Start it, then reopen this panel.";
    document.getElementById("console-hint").hidden=true;
    return;
  }
  pendingSend(b,{cmd:"refresh"});
});
document.getElementById("delegate-send").addEventListener("click", ()=>{
  if (sending) { status.textContent="A command is already being sent. Please wait."; return; }
  if (!live()) return;
  const goal=document.getElementById("goal").value, acceptance=document.getElementById("done").value;
  const selected=document.querySelector('input[name="executor"]:checked');
  if (!goal.trim()) { status.textContent="What should be done is required."; return; }
  if (goal.length > 2000 || acceptance.length > 500) { status.textContent="Goal must be at most 2000 characters; Done when at most 500."; return; }
  if (!selected || selected.disabled || selected.value && (!data.executors[Number(selected.value)] || !runnerId.test(data.executors[Number(selected.value)]))) { status.textContent="Choose an available executor."; return; }
  const command={cmd:"delegate",goal,acceptance,...(selected.value?{executor:data.executors[Number(selected.value)]}:{})};
  const action=beginAction(submitButton,command);if(!action)return;
  sending=true;
  const failDelegate=()=>{restoreAction(action);finishSending();};
  if (!readContext(value=>{
    updateContext(value);
    if (!context || !context.branch) { status.textContent="Focus a worktree first."; failDelegate(); return; }
    if (!sendCommand({cmd:"delegate",branch:context.branch,displayName:context.displayName,...(typeof context.worktreeId==="string" && context.worktreeId ? {worktreeId:context.worktreeId} : {}),goal,acceptance,...(selected.value?{executor:data.executors[Number(selected.value)]}:{})}, ()=>{
      document.getElementById("goal").value="";
      document.getElementById("done").value="";
      document.querySelector('input[name="executor"][value=""]').checked=true;
      sending=false; show("overview");
      status.textContent="Sent. The task id appears in the pacer console.";
    }, failDelegate, value)) failDelegate();
  }, failDelegate)) failDelegate();
});
document.getElementById("strategy-send").addEventListener("click", ()=>{ if(sending){status.textContent="A command is already being sent. Please wait.";return;} if(!live())return;
 const brief=document.getElementById("strategy-brief").value, from=document.getElementById("strategy-from").value, agent=document.getElementById("strategy-agent").value;
 if(!brief.trim() || brief.length>2000 || !["claude-code","codex"].includes(agent)) {status.textContent="Enter a brief of at most 2000 characters and choose a configured agent.";return;}
 const button=document.getElementById("strategy-send");const action=beginAction(button,{cmd:"strategy-build",agent,from,brief});if(!action)return;sending=true;
 const finish=()=>{sending=false;restoreAction(action);};
 if(!readContext(value=>{updateContext(value);if(!context || !context.branch){status.textContent="Focus a worktree first.";finish();return;}
 sendCommand({cmd:"strategy-build",agent,from,brief,branch:context.branch,...(context.worktreeId?{worktreeId:context.worktreeId}:{})},()=>{sending=false;status.textContent="Sent to the pacer console. Watch the new terminal.";},finish,value);
 },finish))finish();
});
document.getElementById("done").addEventListener("keydown", event=>{
 if(event.key==="Enter") {event.preventDefault();document.getElementById("delegate-send").click();}
});
window.addEventListener("message", event=>{
  const r=event.data;
  if (event.source!==window.parent || !r || r.type!=="orca-panel-action-result" || !pending.has(r.requestId)) return;
  const item=pending.get(r.requestId); pending.delete(r.requestId);
  if (!r.ok) { status.textContent=typeof r.error==="string" ? r.error : "Orca refused this request."; if (item.onFailure) item.onFailure(); return; }
  if (item.purpose==="context") { updateContext(r.value); if (item.after) item.after(r.value); return; }
  const accepted=r.value && r.value.accepted;
  status.textContent=accepted ? item.purpose==="setup" ? "Typed into your terminal. Press Enter to run it." : "Sent to pacer console" : "Orca refused to type into the terminal.";
  if (accepted && item.after) item.after(r.value);
  if (!accepted && item.onFailure) item.onFailure();
});
for(const a of Object.values(actionStates)) {
 if(a.action?.cmd==="delegate")bindAction(submitButton,a.action);
 if(a.action?.cmd==="strategy-build")bindAction(document.getElementById("strategy-send"),a.action);
}
const notificationControl=document.getElementById("notification-level");
if(notificationControl){
 for(const a of Object.values(actionStates))if(a.action?.cmd==="notify-level")bindAction(notificationControl,a.action);
 notificationControl.addEventListener("change",()=>{
  const level=notificationControl.value;if(!["off","important","all"].includes(level))return;
  pendingSend(notificationControl,{cmd:"notify-level",level},()=>{status.textContent="Sent to pacer console. Saving notification preference...";});
 });
}
recoverActions();
try {if(sessionStorage.getItem("pacer-panel-view")==="settings")show("settings");}catch{}
try {const saved=Number(sessionStorage.getItem("pacer-panel-scroll"));if(Number.isFinite(saved)&&saved>=0)window.scrollTo?.(0,saved);}catch{}
window.addEventListener("scroll",()=>{try{sessionStorage.setItem("pacer-panel-scroll",String(window.scrollY));}catch{}},{passive:true});
readContext(value=>{ live(value); });
`.replace(/(?<!-)\b(notificationControl|strategyEntries|submitButton|updateContext|sendCommand|updateFreshness|seenStrategies|actionStates|pendingSend|statusNode|recoverActions|afterSession|finishSending|rankedList|mutedList|savedStrategy|sentAt|actionStorage|actionButtons|saveActions|actionKey|actionLabel|restoreAction|paintAction|beginAction|bindAction|onFailure|pending)\b(?!-)/g, (name) => compactNames[name]);

// orca-plugin/src/panel.ts
function renderPanel(s, view) {
  const reconnecting = !view.reachable && !!s.budget && view.lastSeenAt !== undefined && view.nowS - view.lastSeenAt >= 0 && view.nowS - view.lastSeenAt < 20;
  const consoles = [...s.consoles ?? [], ...s.console ? [s.console] : []].filter((c) => c.handle && view.nowS - c.heartbeatAt <= LIMITS.heartbeatS).filter((c, i, a) => a.findIndex((x) => x.handle === c.handle) === i), console2 = consoles[0], setupState = view.setup ?? (view.bootstrap ? legacyChecklist(s, view.nowS, view.reachable, view.bootstrap) : undefined), selected = setupState ? setupState.complete ? "overview" : "setup" : reconnecting ? "overview" : initialView(s, view.reachable, view.nowS);
  const commands = { checkSetup: { cmd: "check-setup" }, refresh: { cmd: "refresh" }, c: { cmd: "check-updates" }, u: { cmd: "update" } };
  const text = {};
  const connected = view.bootstrap?.agents.filter((a) => a.installed).map((a) => a.name) ?? [];
  const knownVersion = view.updates?.cli || view.updates?.plugin || s.console?.version;
  const updates = knownVersion || view.updates?.latest || view.updates?.available ? `<section class="card stack updates" data-updates><strong>${view.updates?.available ? `Update available${view.updates.latest ? `: ${h(view.updates.latest)}` : ""}` : knownVersion ? `pacer ${h(knownVersion)}${view.updates?.latest ? " · up to date" : ""}` : `Latest pacer ${h(view.updates?.latest)}`}</strong><div class="actions"><button data-command="c">Check for updates</button>${view.updates?.available ? '<button data-command="u">Update</button>' : ""}</div></section>` : "";
  const rows = (setupState?.complete ? `<details class="card stack setup-summary"><summary>Setup ✓</summary>${checklist(setupState, !!console2)}</details>` : "") + updates + (connected.length ? `<small class="muted">Connected: ${h(connected.join(", "))}</small>` : "");
  const reasonText = view.autoConsole ?? true ? "The pacer console for this worktree is starting. Try again in a few seconds." : "Start the console first.";
  const feedback = console2 ? "" : `<p data-status role="status" aria-live="polite" class="action-status">${h(reasonText)}</p>`;
  const main = overview(s, view.nowS, view.reachable, commands, text, rows, feedback);
  const disable = (html) => console2 ? html : html.replace(/(data-command="[^\"]+"|data-live)(?=[ >])/g, "$1 disabled");
  const settings = settingsView(s, view, !!console2, commands);
  const cfg = view.strategyConfig;
  const settingsState = cfg ? { values: { planner: Object.values(cfg.runners).find((r) => r.agent === cfg.planner.agent && r.account === cfg.planner.account)?.id ?? cfg.planner.agent, "pacing.order": cfg.pacing.order.join(","), "pacing.policy": cfg.pacing.policy, "pacing.planner_reserve": String(cfg.pacing.plannerReserve), "pacing.accounts": cfg.pacing.accounts, "pacing.fill_threshold": String(cfg.pacing.fillThreshold), update_check: String(view.updateCheck !== false) }, accounts: Object.keys(cfg.accounts), runners: Object.keys(cfg.runners) } : undefined;
  const payload = { prefs: settingsState, focusAlerts: s.alerts.filter((a) => a.key.startsWith("focus-")), notifications: view.notifications ?? "important", actionErrors: s.alerts.filter((a) => (a.key.startsWith("retry-") || a.key.startsWith("focus-")) && a.level !== "info").map((a) => ({ key: a.key, at: a.at, body: a.body })), sequence: s.seq, tasks: s.tasks.map((t) => ({ id: t.id, state: t.state, goal: t.goal, retryOf: t.retryOf, retriedBy: t.retriedBy, dismissed: t.dismissed })), autoConsole: view.autoConsole ?? true, buildAlert: s.alerts.find((a) => a.key === "strategy-build") ?? null, consoles: consoles.map((c) => ({ handle: c.handle, live: true })), strategies: s.strategies?.length ? s.strategies : [s.budget?.strategy ?? "default"], strategy: s.budget?.strategy ?? "default", savedAlerts: s.alerts.filter((a) => a.key.startsWith("strategySaved-")), snapshotAt: s.budget?.generatedAt ?? s.at, updatedAt: s.at, reachable: view.reachable, commands, text, paths: Object.fromEntries(Object.entries(paths).filter(([id]) => [...rankedProviders(s), ...mutedProviders(s)].some((p) => p.id === id))), rows: rankedProviders(s).map((p) => ({ id: p.id, ...p.id.includes("#") ? { name: providerLabel(p) } : {}, ...p.agent ? { agent: p.agent, account: p.account } : {}, usedPct: p.usedPct, pacePct: p.pacePct, detail: providerDetail(p, view.nowS), tone: tone(p.verdict), words: verdictWords(p.verdict), blocked: false })), muted: mutedProviders(s).map((p) => ({ id: p.id, ...p.id.includes("#") ? { name: providerLabel(p) } : {}, ...p.agent ? { agent: p.agent, account: p.account } : {}, verdict: p.verdict, detail: unavailableDetail(p, view.nowS), blocked: !!p.blockedReason })) };
  const strategy = strategyView(s, view.nowS, view.reachable, view.notifications ?? "important");
  const outcome = view.autoConsoleOutcome, waiting = !outcome || outcome.status === "starting" && view.nowS - outcome.at < 15;
  const reason = outcome ? outcome.status === "older-console" ? "An older pacer console is running here; it restarts automatically after updates. A fresh console is starting." : outcome.status === "starting" ? "Console startup is taking longer than expected." : `Auto-open: ${outcome.status}.` : "Press Enter in the terminal to start it.";
  const consoleHint = waiting && view.transport === "http" && (view.autoConsole ?? true) && view.reachable ? `<small class="muted"><span class="console-spinner" aria-hidden="true">◐</span> Starting pacer console in this worktree...</small>` : `<button type="button" data-setup="pacer console">Start console</button><small>${h(reason)}</small>`;
  const packed = packPanelData(payload), plain = jsonForScript(packed), encoded = jsonForScript({ encoded: Buffer.from(JSON.stringify(packed), "utf8").toString("base64") });
  const data = encoded.length < plain.length ? encoded : plain;
  return `<!doctype html><html lang="en" data-transport="${h(view.transport ?? "none")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"><title>pacer budget</title><style>${(style + (cfg ? settingsStyle : "")).replace(/;}/g, "}").replace(/\n+/g, "")}</style></head><body>
 <main class="view" data-page="overview"${selected === "overview" ? "" : " hidden"}>${reconnecting ? '<div role="status" class="note">Reconnecting...</div><div style="opacity:.45;pointer-events:none" inert>' + disable(main) + "</div>" : disable(main)}</main>
 <main class="view" data-page="setup"${selected === "setup" ? "" : " hidden"}>${setup(s, view.nowS, view.reachable, view.bootstrap, setupState, !!console2, `<div id="console-hint" class="note stack" hidden><strong>No pacer console in this worktree</strong>${consoleHint}</div>`)}</main>
 <main class="view" data-page="delegate" hidden>${disable(delegateView(s, view.nowS, view.reachable))}</main>
 <main class="view" data-page="strategy" hidden>${disable(strategy)}</main>
 <main class="view" data-page="settings" hidden>${settings}</main>
 <p id="status" role="status" aria-live="polite" hidden></p>
 <script type="application/json" id="pacer-actions">${data}</script><script>
${client(!!s.budget?.providers.some((p) => p.agent)).replace(/^ *\/\/[^\n]*\n/gm, "").replace(/^ +/gm, "").replace(/\n\s*\n/g, `
`).replace(/^ *\/\/[^\n]*$/gm, "").replace(/\n/g, "")}</script></body></html>`.replace(/<button type="button"/g, "<button");
}

// orca-plugin/src/plugin.ts
function createPlugin(deps) {
  let stopped = false;
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
    const reconnecting = () => !reachable && lastSeenAt !== undefined && deps.nowS() - lastSeenAt < 20;
    let processing = Promise.resolve();
    let httpFailures = 0;
    let setup;
    let renderedKey = null;
    let lastRenderAt = -Infinity;
    let userOutcome = false;
    const outcomes = new Map;
    let focusedWorktree = null, attempted = false;
    const panelOutcome = () => (focusedWorktree ? outcomes.get(focusedWorktree) : undefined) ?? { status: "starting", at: activatedAtS };
    const hintKey = () => {
      if (!settings.autoConsole || active?.id !== "http" || !reachable)
        return null;
      const outcome = focusedWorktree ? outcomes.get(focusedWorktree) : undefined;
      const hasLive = [...store.snapshot.consoles ?? [], ...store.snapshot.console ? [store.snapshot.console] : []].some((c) => c.handle && deps.nowS() - c.heartbeatAt <= LIMITS.heartbeatS);
      if ((outcome?.status === "registered" || !outcome) && hasLive)
        return null;
      const current = panelOutcome();
      return { ...current, expired: current.status === "starting" && deps.nowS() - current.at >= 15 };
    };
    const panelUpdates = () => {
      if (!deps.version)
        return updates;
      const cached = deps.cachedUpdate?.();
      const latest = cached?.latest ?? updates?.latest ?? null;
      const cli = store.snapshot.console?.version ?? updates?.cli ?? null;
      const check = { checkedAt: deps.nowS(), latest, current: deps.version };
      return { plugin: deps.version, cli, latest, available: updateAvailable(check) || !!cli && updateAvailable({ ...check, current: cli }) };
    };
    const consoleKey = () => [...new Set([...(store.snapshot.consoles ?? []).map((c) => c.handle), store.snapshot.console?.handle].filter(Boolean))].sort().map((handle) => ({
      handle,
      live: [...store.snapshot.consoles ?? [], ...store.snapshot.console ? [store.snapshot.console] : []].some((c) => c.handle === handle && deps.nowS() - c.heartbeatAt <= LIMITS.heartbeatS)
    }));
    const configuredSettings = () => {
      const activeName = deps.fs.readText(join7(settings.pacerHome, "active"))?.trim();
      const name = activeName && /^[a-z0-9][a-z0-9-]{0,39}$/.test(activeName) ? activeName : "default";
      const result = readPanelSettings((path) => deps.fs.readText(path), settings.pacerHome, name);
      return { strategyConfig: result.strategyConfig, updateCheck: result.updateCheck, settingsError: result.error };
    };
    const contentPanelKey = () => setup && !setup.complete ? JSON.stringify({ setup: setupKey(setup), consoles: consoleKey() }) : JSON.stringify({
      updates: panelUpdates(),
      setup: setup ? setupKey(setup) : undefined,
      notifications: settings.notifications,
      budget: store.snapshot.budget ? { ...store.snapshot.budget, generatedAt: undefined } : null,
      mode: store.snapshot.mode ? { ...store.snapshot.mode, at: undefined } : null,
      serviceInstalled: store.snapshot.serviceInstalled,
      reconnecting: reconnecting(),
      tasks: store.snapshot.tasks.map(({ updatedAt, ...task }) => task),
      alerts: store.snapshot.alerts,
      consoles: consoleKey(),
      autoConsoleOutcome: hintKey(),
      strategies: store.snapshot.strategies,
      transport: store.transport,
      reachable
    });
    const panelKey = () => JSON.stringify({ content: contentPanelKey(), ...configuredSettings(), autoConsole: settings.autoConsole, notifications: settings.notifications });
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
          const key = panelKey(), nowS = deps.nowS();
          if (key !== renderedKey) {
            if (pluginMode(deps.pluginRoot, deps.fs) === "live") {
              deps.fs.writeTextAtomic(join7(deps.pluginRoot, "panel", "live.html"), renderPanel(store.snapshot, { ...configuredSettings(), nowS, transport: store.transport, reachable, lastSeenAt, autoConsole: settings.autoConsole, notifications: settings.notifications, autoConsoleOutcome: panelOutcome(), setup, bootstrap: deps.bootstrap?.state, updates: panelUpdates() }));
              renderedKey = key;
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
        const latest = deps.fs.readText(join7(settings.pacerHome, "check-setup-request.json"));
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
        const updated = readSettings(result.settings, deps.home), changed = settings.notifications !== updated.notifications || settings.autoConsole !== updated.autoConsole;
        settings.lastAlertAt = Math.max(settings.lastAlertAt, updated.lastAlertAt);
        settings.deliveredAlerts = [...settings.deliveredAlerts ?? [], ...updated.deliveredAlerts ?? []].slice(-200);
        settings.notifications = updated.notifications;
        settings.autoConsole = updated.autoConsole;
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
      if (panelKey() !== renderedKey)
        scheduleRender();
    });
    const replaceSnapshot = (snapshot) => {
      if (stopped)
        return;
      const previous = store.snapshot;
      const consoleChanged = !!snapshot.console?.handle !== !!previous.console?.handle;
      const initiated = consoleChanged || snapshot.budget?.strategy !== previous.budget?.strategy || snapshot.tasks.some((t) => !previous.tasks.some((p) => p.id === t.id) || t.dismissed !== previous.tasks.find((p) => p.id === t.id)?.dismissed || t.retriedBy !== previous.tasks.find((p) => p.id === t.id)?.retriedBy) || snapshot.alerts.some((a) => a.key === "strategy-build" && !previous.alerts.some((p) => p.key === a.key && p.at === a.at)) || snapshot.budget?.providers.some((p) => p.blockedReason !== previous.budget?.providers.find((x) => x.id === p.id)?.blockedReason);
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
    const notify = async (title, body) => {
      try {
        if (settings.notifications !== "all")
          return;
        const plain = title.startsWith("pacer ") && !title.includes("console") ? "Budget refreshed" : title.replace(/\bpacer\b\s*/gi, "");
        await deliverNotification(ctx.host, { title: clip(plain, 60), body: body?.startsWith("terminal ") ? "Nothing to do." : title.startsWith("pacer ") && !title.includes("console") ? "Open the pacer panel for the current budget." : clip(body ?? "Nothing to do.", 1000) }, deps.nowS());
      } catch (e) {
        logError(e);
      }
    };
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
      if (stopped || probing || connecting || active?.id === "http")
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
    const failureLogged = new Map;
    let opening = false;
    timers.every(5000, () => {
      if (stopped || opening || !settings.autoConsole || active?.id !== "http" || !reachable)
        return;
      opening = true;
      let worktree = "unknown";
      (async () => {
        const context = await ctx.host.call("workspace.readContext");
        if (stopped)
          return;
        if (!context || !context.branch) {
          focusedWorktree = null;
          attempted = false;
          scheduleRender();
          return;
        }
        worktree = context.worktreeId || context.branch;
        if (focusedWorktree !== worktree) {
          focusedWorktree = worktree;
          attempted = false;
          outcomes.delete(worktree);
          scheduleRender(true);
        }
        const now = deps.nowS(), ids = new Set(context.terminals.map((t) => t.id));
        if ([...store.snapshot.consoles ?? [], ...store.snapshot.console ? [store.snapshot.console] : []].some((c) => c.handle && ids.has(c.handle) && now - c.heartbeatAt <= LIMITS.heartbeatS)) {
          if (outcomes.get(worktree)?.status !== "registered") {
            outcomes.set(worktree, { status: "registered", at: now });
            scheduleRender(true);
          }
          return;
        }
        if (attempted) {
          const outcome = outcomes.get(worktree);
          if (outcome?.status === "registered" || outcome?.status === "starting" && now - outcome.at >= 30) {
            outcomes.set(worktree, { status: "gave-up", at: now });
            scheduleRender(true);
          }
          return;
        }
        attempted = true;
        outcomes.set(worktree, { status: "starting", at: now });
        scheduleRender(true);
        const base = `http://127.0.0.1:${settings.port}`;
        const health = await deps.http.get(`${base}/health`, "", 1500);
        if (stopped || active?.id !== "http")
          return;
        if (health.status !== 200 || health.headers?.["x-pacer"] !== "1")
          throw new Error("unidentified HTTP listener");
        const token = deps.fs.readText(`${settings.pacerHome}/token`)?.trim();
        if (!token || !deps.http.post)
          throw new Error("HTTP console opening unavailable");
        const response = await deps.http.post(`${base}/console/open`, token, { ...context.terminals[0] ? { terminal: context.terminals[0].id } : {}, branch: context.branch }, 1500);
        if (response.headers?.["x-pacer"] !== "1")
          throw new Error(`HTTP ${response.status}`);
        const result = JSON.parse(response.body);
        if (!result.ok) {
          outcomes.set(worktree, { status: typeof result.reason === "string" ? result.reason : "orca-unavailable", at: deps.nowS() });
          scheduleRender(true);
        } else if (result.warning === "older-console") {
          outcomes.set(worktree, { status: "older-console", at: deps.nowS() });
          scheduleRender(true);
        } else if (response.status !== 200 && !(response.status === 202 && result.queued === true))
          throw new Error(`HTTP ${response.status}`);
      })().catch((e) => {
        const now = deps.nowS();
        outcomes.set(worktree, { status: "orca-unavailable", at: now });
        scheduleRender(true);
        if (now - (failureLogged.get(worktree) ?? -Infinity) >= 300) {
          failureLogged.set(worktree, now);
          ctx.log(`pacer: auto console in ${worktree}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }).finally(() => {
        opening = false;
      });
    });
    const sendFresh = async (data) => {
      await refreshSnapshot();
      if (stopped)
        return "no-console";
      return sendToConsole(ctx.host, store.snapshot, data, deps.nowS());
    };
    const send = async (data) => {
      const result = await sendFresh(data);
      if (result === "no-console") {
        await notify(NO_CONSOLE.title, NO_CONSOLE.body);
        return { ok: false, message: NO_CONSOLE.title };
      }
      if (result === "rejected") {
        const message = "Orca refused to type into the pacer console";
        await notify(message, "Focus the console's worktree and retry, or run `pacer console --open` here.");
        return { ok: false, message };
      }
      const message = "Sent to pacer console";
      await notify(message);
      return { ok: true, message };
    };
    ctx.commands.register("delegate", async () => {
      await ensureConnected();
      let context = null;
      try {
        context = await ctx.host.call("workspace.readContext");
      } catch (e) {
        logError(e);
      }
      return send({ cmd: "delegate", ...context ? { branch: context.branch, displayName: context.displayName, ...context.worktreeId ? { worktreeId: context.worktreeId } : {} } : {} });
    });
    ctx.commands.register("switch-strategy", async () => {
      await ensureConnected();
      return send({ cmd: "use" });
    });
    ctx.commands.register("refresh-status", async () => {
      await ensureConnected();
      const result = await sendFresh({ cmd: "refresh" });
      if (result === "rejected")
        await notify("Orca refused to type into the pacer console", "Focus the console's worktree and retry, or run `pacer console --open` here.");
      scheduleRender();
      const message = summaryLine(store.snapshot.budget);
      await notify(message, (store.snapshot.budget?.providers ?? []).map((p) => `${p.id} ${p.verdict} ${p.usedPct === null ? "?" : `${Math.round(p.usedPct)}%`}`).join(`
`));
      return { ok: true, message };
    });
    ctx.commands.register("open-console", async () => {
      await ensureConnected();
      await refreshSnapshot();
      const c = await focusedConsole(ctx.host, store.snapshot, deps.nowS());
      const message = c ? "pacer console is running" : NO_CONSOLE.title;
      await notify(message, c ? `terminal ${c.handle}` : NO_CONSOLE.body);
      return { ok: !!c, message };
    });
    const paneLast = new Map;
    let lastDone = -Infinity;
    ctx.events.on("agent.status.changed", async (payload) => {
      await ensureConnected();
      if (!payload || typeof payload !== "object")
        return;
      const p = payload;
      if (p.state !== "done" || (p.mainAgent?.state ?? "done") !== "done" || typeof p.paneKey !== "string")
        return;
      await refreshSnapshot();
      const now = deps.nowS();
      if (stopped || now - lastDone < 5 || now - (paneLast.get(p.paneKey) ?? -Infinity) < 5 || !liveConsole(store.snapshot, now))
        return;
      lastDone = now;
      paneLast.set(p.paneKey, now);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await refreshSnapshot();
      await sendToConsole(ctx.host, store.snapshot, { cmd: "agent-done", paneKey: p.paneKey, ...typeof p.worktreeId === "string" ? { worktreeId: p.worktreeId } : {} }, now);
    });
    ctx.events.on("worktree.created", async (payload) => {
      await ensureConnected();
      if (!payload || typeof payload !== "object")
        return;
      const p = payload;
      if (typeof p.branch !== "string" || !/(^|\/)pacer-/.test(p.branch) || typeof p.worktreeId !== "string" || typeof p.path !== "string")
        return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await sendFresh({ cmd: "worktree-created", worktreeId: p.worktreeId, path: p.path, branch: p.branch });
    });
    ctx.events.on("worktree.removed", async (payload) => {
      if (stopped || !payload || typeof payload !== "object" || !("worktreeId" in payload))
        return;
      const id = payload.worktreeId;
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}(?:::[^\x00-\x1f\x7f]{1,900})?$/.test(id))
        return;
      outcomes.delete(id);
      failureLogged.delete(id);
      if (focusedWorktree === id) {
        focusedWorktree = null;
        attempted = false;
      }
      scheduleRender();
      try {
        const base = `http://127.0.0.1:${settings.port}`;
        const health = await deps.http.get(`${base}/health`, "", 1500);
        if (stopped || health.status !== 200 || health.headers?.["x-pacer"] !== "1")
          return;
        const token = deps.fs.readText(`${settings.pacerHome}/token`)?.trim();
        if (!token || !deps.http.post)
          return;
        await deps.http.post(`${base}/console/forget`, token, { worktreeId: id }, 1500);
      } catch (e) {
        logError(e);
      }
    });
    try {
      ctx.host.call("events.subscribe", { events: ["agent.status.changed", "worktree.created", "worktree.removed"] }).catch(logError);
    } catch (e) {
      logError(e);
    }
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
    const version = JSON.parse(readFileSync6(join8(pluginRoot, "orca-plugin.json"), "utf8")).version;
    if (isVersion(version))
      return version;
  } catch {}
  return package_default.version;
})();
var log = (message) => {};
var workerEnv = { ...process.env };
var pacerHome = workerEnv.PACER_HOME || join8(workerEnv.HOME ?? workerEnv.USERPROFILE ?? "", ".pacer");
var plugin = createPlugin({
  version: PLUGIN_VERSION,
  cachedUpdate: () => readUpdateCheck({ pacerHome, env: workerEnv }, PLUGIN_VERSION),
  reportVersion(mode, version) {
    mkdirSync4(pacerHome, { recursive: true });
    const path = join8(pacerHome, "plugin-version.json"), temp = `${path}.${process.pid}.tmp`;
    writeFileSync4(temp, JSON.stringify({ mode, version }));
    renameSync4(temp, path);
  },
  async checkUpdates() {
    const check = await checkForUpdate({ pacerHome, env: workerEnv, now: Date.now() / 1000 }, { force: true, current: PLUGIN_VERSION });
    const binary = workerEnv.PACER_BIN || (existsSync3(join8(workerEnv.HOME ?? "", ".local/bin/pacer")) ? join8(workerEnv.HOME ?? "", ".local/bin/pacer") : "pacer");
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
