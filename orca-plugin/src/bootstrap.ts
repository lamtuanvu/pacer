import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, chmodSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { agentPlans, type AgentPlan } from "../../src/install/detection";
import { compareVersions, isVersion } from "../../src/update/version";
import type { PluginMode } from "./mode";
import type { OrcaWorkerContext } from "./orca-api";
export const GITHUB_RELEASES = "https://github.com/lamtuanvu/pacer/releases";
export const UNPUBLISHED = "pacer isn't published yet. Set the release folder in plugin settings or install pacer manually";
export const MANUAL_INSTALL = "curl -fsSL https://raw.githubusercontent.com/lamtuanvu/pacer/main/install.sh | sh";
export interface Step { status: "pending" | "done" | "failed"; detail?: string }
export interface BootstrapState {
  install: Step; start: Step; agents: AgentPlan[]; binary?: string; opening?: boolean; terminal?: string;
  nextAt?: number; failures?: number[]; restarts?: number[]; terminalAttempts?: Record<string, number>; notifications?: string[]; handoffVersion?: string;
}
export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env }; delete result.ORCA_AGENT_SESSION_ID; delete result.ORCA_TERMINAL_HANDLE; return result;
}
export function releaseBase(setting: unknown, env: NodeJS.ProcessEnv): string {
  const base = (typeof setting === "string" && setting.trim() ? setting.trim() : env.PACER_RELEASE_BASE || GITHUB_RELEASES).replace(/\/+$/, "");
  const u = new URL(base);
  if (u.username || u.password || u.search || u.hash || !(u.protocol === "https:" || (u.protocol === "file:" && (!u.hostname || u.hostname === "localhost")) || (u.protocol === "http:" && ["127.0.0.1", "localhost"].includes(u.hostname)))) throw new Error("Use an HTTPS, file:// or localhost release folder.");
  return base;
}
export function releaseURL(base: string, version: string, name: string): string {
  return base === GITHUB_RELEASES ? name === "latest.json" ? `${base}/latest/download/latest.json` : `${base}/download/v${version}/${name}` : name === "latest.json" ? `${base}/latest.json` : `${base}/${version}/${name}`;
}
export async function download(url: string, fetcher: typeof fetch = fetch, signal = AbortSignal.timeout(120_000)): Promise<Buffer> {
  releaseBase(url, {});
  if (url.startsWith("file:")) return readFile(fileURLToPath(url), { signal });
  for (let hops = 0;; hops++) {
    const response = await fetcher(url, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || hops >= 5) throw new Error("Release redirect limit exceeded.");
      const next = new URL(location, url);
      if (next.protocol !== "https:" || next.username || next.password) throw new Error("Release redirects must use HTTPS.");
      await response.body?.cancel(); url = next.href; continue;
    }
    if (!response.ok) throw new Error(`Release download HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
}
export interface BootstrapDeps {
  mode?: PluginMode;
  home: string; env: NodeJS.ProcessEnv; version: string; platform?: string; arch?: string;
  now?: () => number; fetch?: typeof fetch;
  exec?: (bin: string, args: string[], env: NodeJS.ProcessEnv, timeout: number) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
}
export function runFile(bin: string, args: string[], env: NodeJS.ProcessEnv, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => execFile(bin, args, { env, timeout, maxBuffer: 1024 * 1024 }, (err, stdout) => err ? reject(err) : resolve(stdout)));
}
export function which(bin: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH || "").split(delimiter).filter(Boolean)) {
    const path = join(dir, bin); try { accessSync(path, constants.X_OK); return path; } catch { /* next directory */ }
  }
  return null;
}
export function createBootstrap(d: BootstrapDeps) {
  const now = d.now ?? (() => Date.now() / 1000), exec = d.exec ?? runFile, env = cleanEnv(d.env);
  const home = d.home, pacerHome = join(home, ".pacer"), platform = d.platform ?? process.platform;
  let state: BootstrapState = { install: { status: "pending" }, start: { status: "pending" }, agents: [] };
  // Each orca CLI call starts an Electron runtime: probe terminals at most every 30 s.
  let running: Promise<void> | null = null, terminalRunning = false, stopped = false, probedAt = -Infinity;
  const changed = async (ctx: OrcaWorkerContext, onChange: () => void) => {
    if (d.mode === "bootstrap") {
      const failed = state.install.status === "failed" ? (state.install.detail === UNPUBLISHED ? UNPUBLISHED : "pacer couldn't install. Try again shortly.") : state.start.status === "failed" ? "pacer couldn't start. Try again shortly." : undefined;
      const message = failed || (state.start.status === "done" && state.handoffVersion === d.version ? `pacer is ready. Last step: in Orca Settings > Plugins, uninstall this pacer and add ${join(pacerHome, "orca-plugin")} under Development.` : state.install.status === "pending" ? "Installing pacer…" : null);
      if (message && !state.notifications?.includes(message)) {
        state.notifications = [...(state.notifications ?? []), message];
        // Reserve durably before showing: a worker restart must not repeat a milestone.
        try { await ctx.host.call("storage.set", { key: "bootstrap", value: state }); }
        catch { /* in-memory deduplication when host storage is unavailable */ }
        try { await ctx.host.call("notifications.show", { title: message }); } catch { /* optional notification capability */ }
      }
    }
    onChange(); try { await ctx.host.call("storage.set", { key: "bootstrap", value: state }); } catch { /* optional host storage */ }
  };
  async function activate(ctx: OrcaWorkerContext) {
    stopped = false;
    try {
      const saved = (await ctx.host.call("storage.get", { key: "bootstrap" })).value as BootstrapState | null;
      if (saved && saved.install && saved.start) state = { ...state, install: saved.install ?? state.install, start: saved.start ?? state.start, binary: saved.binary, agents: saved.agents ?? [], nextAt: saved.nextAt, failures: saved.failures, restarts: saved.restarts, terminalAttempts: saved.terminalAttempts, notifications: saved.notifications, handoffVersion: saved.handoffVersion };
    } catch { /* fresh install */ }
  }
  async function cycle(ctx: OrcaWorkerContext, onChange: () => void) {
    if (stopped || now() < (state.nextAt ?? 0)) return;
    state.nextAt = now() + 600;
    let step: "install" | "start" = "install";
    try {
      const settings = await ctx.host.call("settings.get").catch(() => ({ settings: {} as Record<string, unknown> }));
      const base = releaseBase(settings.settings.releaseBase, env);
      let binary = env.PACER_BIN || (existsSync(join(home, ".local/bin/pacer")) ? join(home, ".local/bin/pacer") : which("pacer", env));
      state.install = { status: "pending" }; state.start = { status: "pending" }; await changed(ctx, onChange);
      if (!binary) {
        if (!["darwin", "linux"].includes(platform) || !["arm64", "x64"].includes(d.arch ?? process.arch)) throw new Error("This platform needs a manual pacer install.");
        const name = `pacer-${platform}-${d.arch ?? process.arch}`, signal = AbortSignal.timeout(120_000);
        const sums = (await download(releaseURL(base, d.version, "SHA256SUMS"), d.fetch, signal)).toString();
        const match = sums.split(/\r?\n/).map(line => /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line)).find(m => m?.[2] === name);
        if (!match) throw new Error("The release checksum is missing.");
        const bytes = await download(releaseURL(base, d.version, name), d.fetch, signal);
        if (createHash("sha256").update(bytes).digest("hex") !== match[1].toLowerCase()) throw new Error("The pacer download failed its checksum check.");
        const dir = join(home, ".local/bin"); mkdirSync(dir, { recursive: true });
        const temporary = join(dir, `.pacer-${randomUUID()}.tmp`);
        try { writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 }); chmodSync(temporary, 0o755); renameSync(temporary, join(dir, "pacer")); }
        finally { try { unlinkSync(temporary); } catch { /* renamed */ } }
        binary = join(dir, "pacer");
      } else {
        const output = (await exec(binary, ["--version"], env, 30_000)).trim().replace(/^pacer\s+/, "");
        if (isVersion(output) && !output.includes("dev") && compareVersions(output, d.version) < 0) {
          await exec(binary, ["update", "--to", d.version], base === GITHUB_RELEASES ? { ...env, PACER_RELEASE_BASE: undefined } : { ...env, PACER_RELEASE_BASE: base }, 120_000);
        }
      }
      state.binary = binary; state.install = { status: "done" }; step = "start";
      state.start = { status: "pending" }; await changed(ctx, onChange);
      if (!existsSync(join(pacerHome, "strategy.yaml"))) await exec(binary, ["init"], env, 30_000);
      const status = JSON.parse(await exec(binary, ["service", "status", "--json"], env, 30_000));
      if (!status.installed) await exec(binary, ["service", "install"], env, 30_000);
      const port = typeof settings.settings.port === "number" ? settings.settings.port : 4317;
      const health = async () => {
        try { const r = await (d.fetch ?? fetch)(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) }); return r.ok && r.headers.get("x-pacer") === "1"; } catch { return false; }
      };
      if (!await health()) {
        await (d.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(15_000);
        if (stopped) return;
        if (!await health()) {
          state.restarts = (state.restarts ?? []).filter(at => now() - at < 3600);
          if (status.installed && state.restarts.length < 5 && now() - (state.restarts.at(-1) ?? -Infinity) >= 60) {
            state.restarts.push(now()); await changed(ctx, onChange);
            await exec(binary, ["service", "restart"], env, 30_000);
          }
          if (!await health()) throw new Error("pacer is starting. Try again shortly.");
        }
      }
      state.start = { status: "done" };
      if (d.mode === "bootstrap" && state.handoffVersion !== d.version) {
        step = "install";
        await exec(binary, ["plugin", "install"], env, 30_000);
        state.handoffVersion = d.version;
      }
    } catch (e) {
      const message = (e as Error).message;
      const unpublished = message.includes("HTTP 404");
      state[step] = { status: "failed", detail: unpublished ? UNPUBLISHED : step === "install" ? message.split(/\r?\n/)[0].slice(0,160) : "pacer couldn't start. Try again shortly." };
      state.failures = (state.failures ?? []).filter(at => now() - at < 3600);
      state.failures.push(now());
      state.nextAt = d.mode === "bootstrap" && state.failures.length >= 5 ? state.failures[0] + 3600 : now() + (unpublished || state.failures.length >= 5 ? 600 : 60);
      ctx.log(`pacer bootstrap: ${message}`);
    } finally {
      state.agents = agentPlans(home, pacerHome, bin => which(bin, env), env);
      await changed(ctx, onChange);
    }
  }
  return {
    activate,
    get state() { return state; },
    run(ctx: OrcaWorkerContext, onChange: () => void) {
      if (!running) running = cycle(ctx, onChange).finally(() => { running = null; }); return running;
    },
    async refreshAgents(ctx: OrcaWorkerContext, onChange: () => void) {
      if (stopped) return;
      if (d.mode === "bootstrap") return;
      const agents = agentPlans(home, pacerHome, bin => which(bin, env), env);
      if (JSON.stringify(agents) !== JSON.stringify(state.agents)) { state.agents = agents; await changed(ctx, onChange); }
      // Pre-create only while the consent button is visible. The panel cannot ask the worker.
      if (terminalRunning || state.start.status !== "done" || !state.agents.some(a => !a.installed) || now() - probedAt < 30) return;
      terminalRunning = true; probedAt = now();
      try {
        const context = await ctx.host.call("workspace.readContext");
        if (!context) return;
        let available = context.terminals.find(t => t.writable === true && !t.agent && !/^pacer(?: console)?$/.test(t.title ?? ""));
        for (const candidate of context.terminals) {
          if (available) break;
          if (candidate.writable === false || candidate.agent || /^pacer(?: console)?$/.test(candidate.title ?? "")) continue;
          try {
            const reply = JSON.parse(await exec(env.ORCA_CLI_COMMAND || "orca", ["terminal", "show", "--terminal", candidate.id, "--json"], env, 30_000));
            const terminal = reply.result?.terminal;
            if (reply.ok && terminal?.connected && terminal.writable && !terminal.agent && !terminal.agentSessionId && !/^pacer(?: console)?$/.test(terminal.title ?? "")) available = candidate;
          } catch { /* not a writable shell */ }
        }
        if (available) { if (state.terminal !== available.id || state.opening) { state.terminal = available.id; state.opening = false; await changed(ctx, onChange); } return; }
        state.terminal = undefined;
        const id = context.worktreeId || context.branch;
        state.terminalAttempts ??= {};
        if (now() - (state.terminalAttempts[id] ?? -Infinity) < 600) return;
        state.terminalAttempts[id] = now(); state.opening = true; await changed(ctx, onChange);
        await exec(env.ORCA_CLI_COMMAND || "orca", ["terminal", "create", "--worktree", "active", "--title", "pacer setup", "--json"], env, 30_000);
      } catch (e) { state.opening = false; ctx.log(`pacer setup terminal: ${(e as Error).message}`); await changed(ctx, onChange); }
      finally { terminalRunning = false; }
    },
    stop() { stopped = true; },
  };
}
export type Bootstrap = ReturnType<typeof createBootstrap>;
