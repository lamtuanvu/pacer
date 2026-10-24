import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { appendActivity } from "../activity/log";
import { CoreError } from "../core/errors";
import { publish } from "../link/publish";
import type { Ctx } from "../types";
import { type PluginGrant, pluginsConfig, setPluginDisabled, setPluginGrant } from "./config";
import { answerCapability, appendPluginLog } from "./host";
import { hostRangeAccepts, readManifestFile } from "./manifest";
import { PluginProcess, type SpawnSpec } from "./process";
import { EXTENSION_METHODS, HELLO_METHOD, PLUGIN_ID, PLUGIN_PROTOCOL_MAJOR, PLUGIN_PROTOCOL_VERSION, type PluginManifest, type PluginState, helloResult } from "./protocol";
import type { BundledPlugin } from "./types";
import { currentVersion } from "../update/version";

export interface RegistryDeps { bundled: BundledPlugin[]; spawnBundled: (ctx: Ctx, id: string) => SpawnSpec; spawn?: typeof nodeSpawn; sleep?: (ms: number) => Promise<void> }
export interface PluginInfo { id: string; version: string; publisher: string; tier: "free" | "commercial"; bundled: boolean; enabled: boolean; state: PluginState; contributes: string[]; capabilities: { name: string; scopes?: string[] }[]; grant: PluginGrant | null; error: string | null; pid: number | null }
export interface DoctorReport { id: string; ok: boolean; state: PluginState; served: string[]; protocol: { host: string; plugin: string | null }; pid: number | null; restarts: number; error: string | null; needs: string | null }

interface Entry {
  id: string; manifest: PluginManifest | null; bundled: boolean; dir: string | null;
  state: PluginState; error: string | null; served: string[]; pluginProtocol: string | null;
  process?: PluginProcess; starting?: Promise<PluginProcess>; queue: Promise<unknown>;
  crashes: number[]; nextStartAt: number; stopping: boolean;
}
const ENABLED: ReadonlySet<PluginState> = new Set(["idle", "starting", "ready"]);
const CRASH_WINDOW_S = 60, CRASH_LIMIT = 3, MAX_BACKOFF_MS = 30_000, HELLO_DEADLINE_MS = 10_000;

export class PluginRegistry {
  private published: Promise<unknown> = Promise.resolve();
  private readonly entries = new Map<string, Entry>();
  private readonly refusedShadows = new Set<string>();
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly deps: RegistryDeps) { this.sleep = deps.sleep ?? (ms => Bun.sleep(ms)); }

  private entry(id: string, manifest: PluginManifest | null, bundled: boolean, dir: string | null): Entry {
    let e = this.entries.get(id);
    if (!e) { e = { id, manifest, bundled, dir, state: "idle", error: null, served: [], pluginProtocol: null, queue: Promise.resolve(), crashes: [], nextStartAt: 0, stopping: false }; this.entries.set(id, e); }
    e.manifest = manifest; e.bundled = bundled; e.dir = dir;
    return e;
  }

  private setState(ctx: Ctx, e: Entry, state: PluginState, error: string | null = null): void {
    if (e.state === state && e.error === error) return;
    e.state = state; e.error = error;
    this.published = this.published.then(() => publish(ctx, [{ type: "entity", data: { kind: "plugin", id: e.id, value: { id: e.id, state, error } } }])).catch(() => {});
    if (state === "failing") appendActivity(ctx, { kind: "plugin_state", level: "warn", text: `Plugin ${e.id} is failing · ${error ?? "unknown error"}` });
  }

  /** Re-read manifests and config; runtime states survive unless config now disables or refuses the plugin. */
  refresh(ctx: Ctx): void {
    const cfg = pluginsConfig(ctx);
    const seen = new Set<string>();
    const apply = (e: Entry, refusal: string | null, grant: PluginGrant | null) => {
      seen.add(e.id);
      if (refusal) { void this.stop(e); this.setState(ctx, e, "refused", refusal); return; }
      const m = e.manifest!;
      const covered = e.bundled || (grant !== null && m.capabilities.every(c => grant.capabilities.includes(c.name)));
      if (cfg.disabled.includes(e.id)) { void this.stop(e); this.setState(ctx, e, "disabled"); return; }
      if (!covered) { void this.stop(e); this.setState(ctx, e, "needs_grant", `needs a grant for ${m.capabilities.map(c => c.name).join(", ") || "no capabilities"}`); return; }
      if (!ENABLED.has(e.state) && e.state !== "failing") this.setState(ctx, e, "idle");
    };
    for (const b of this.deps.bundled) {
      const e = this.entry(b.manifest.id, b.manifest, true, null);
      apply(e, hostRangeAccepts(b.manifest.host, PLUGIN_PROTOCOL_VERSION) ? null : `needs host ${b.manifest.host}; this pacer serves ${PLUGIN_PROTOCOL_VERSION}`, null);
    }
    const root = join(ctx.pacerHome, "plugins");
    const folders = existsSync(root) ? readdirSync(root).filter(f => statSync(join(root, f)).isDirectory()) : [];
    for (const id of this.refusedShadows) if (!folders.includes(id)) this.refusedShadows.delete(id);
    for (const folder of folders) {
      const dir = join(root, folder);
      if (this.deps.bundled.some(b => b.manifest.id === folder)) {
        // One canonical public id belongs to the bundle. Refuse the installed
        // folder without mutating or terminating that bundle's live entry.
        if (!this.refusedShadows.has(folder)) {
          appendPluginLog(ctx, folder, "refused", `installed folder shadows the bundled plugin ${folder}`);
          this.refusedShadows.add(folder);
        }
        continue;
      }
      const read = readManifestFile(join(dir, "pacer-plugin.json"));
      if (!read.ok) { apply(this.entry(folder, null, false, dir), read.error, null); continue; }
      const m = read.manifest;
      let refusal: string | null = null;
      if (m.id !== folder) refusal = `manifest id ${m.id} does not match folder ${folder}`;
      else if (!PLUGIN_ID.test(folder)) refusal = `invalid folder name ${folder}`;
      else if (!m.entry || isAbsolute(m.entry) || normalize(m.entry).startsWith("..")) refusal = "entry must be a relative path inside the plugin folder";
      else if (!hostRangeAccepts(m.host, PLUGIN_PROTOCOL_VERSION)) refusal = `needs host ${m.host}; this pacer serves ${PLUGIN_PROTOCOL_VERSION}`;
      apply(this.entry(folder, refusal ? null : m, false, dir), refusal, cfg.installed[folder] ?? null);
    }
    for (const [id, e] of this.entries) if (!seen.has(id)) { void this.stop(e); this.entries.delete(id); }
  }

  list(ctx: Ctx): PluginInfo[] {
    this.refresh(ctx);
    const cfg = pluginsConfig(ctx);
    return [...this.entries.values()].sort((a, b) => a.id.localeCompare(b.id)).map(e => ({
      id: e.id, version: e.manifest?.version ?? "", publisher: e.manifest?.publisher ?? "", tier: e.manifest?.tier ?? "free", bundled: e.bundled,
      enabled: ENABLED.has(e.state) || e.state === "failing", state: e.state, contributes: Object.keys(e.manifest?.contributes ?? {}),
      capabilities: e.manifest?.capabilities ?? [], grant: cfg.installed[e.id] ?? null, error: e.error, pid: e.process?.pid ?? null,
    }));
  }

  private find(ctx: Ctx, id: string): Entry {
    if (!this.entries.size) this.refresh(ctx);
    const e = this.entries.get(id);
    if (!e) { this.refresh(ctx); const again = this.entries.get(id); if (!again) throw new CoreError("unknown_plugin", `unknown plugin ${id}`); return again; }
    return e;
  }

  private spec(ctx: Ctx, e: Entry): SpawnSpec {
    const env = { PATH: ctx.env.PATH, HOME: ctx.home, PACER_HOME: ctx.pacerHome, PACER_PLUGIN_ID: e.id, PACER_PLUGIN_PROTOCOL: PLUGIN_PROTOCOL_VERSION };
    if (e.bundled) return { ...this.deps.spawnBundled(ctx, e.id), env };
    return { argv: [join(e.dir!, e.manifest!.entry!)], cwd: e.dir!, env };
  }

  private async start(ctx: Ctx, e: Entry): Promise<PluginProcess> {
    if (e.starting) return e.starting;
    if (e.process?.alive) return e.process;
    e.starting = (async () => {
      const wait = e.nextStartAt - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.setState(ctx, e, "starting");
      const manifest = e.manifest!;
      const proc = new PluginProcess(this.spec(ctx, e), {
        spawn: this.deps.spawn,
        onRequest: (m, p) => answerCapability(ctx, { id: e.id, manifest }, m, p),
        onStderr: line => appendPluginLog(ctx, e.id, "stderr", line),
        onExit: info => this.onExit(ctx, e, proc, info),
      });
      e.process = proc;
      const grants = e.bundled ? manifest.capabilities.map(c => c.name) : (pluginsConfig(ctx).installed[e.id]?.capabilities ?? []);
      try {
        const raw = await proc.request(HELLO_METHOD, { protocol: PLUGIN_PROTOCOL_VERSION, pacer: currentVersion(), manifest, config: pluginsConfig(ctx).config[e.id] ?? {}, grants }, HELLO_DEADLINE_MS);
        const hello = helloResult.safeParse(raw);
        if (!hello.success) throw new CoreError("plugin_refused", `handshake reply is malformed: ${hello.error.issues[0]?.message ?? "unknown"}`);
        const major = Number(hello.data.protocol.split(".")[0]);
        if (major !== PLUGIN_PROTOCOL_MAJOR) throw new CoreError("plugin_refused", `plugin speaks protocol ${hello.data.protocol}; this pacer serves ${PLUGIN_PROTOCOL_VERSION}`);
        if (hello.data.id !== manifest.id || hello.data.version !== manifest.version) throw new CoreError("plugin_refused", `handshake identity ${hello.data.id}@${hello.data.version} does not match the manifest ${manifest.id}@${manifest.version}`);
        e.pluginProtocol = hello.data.protocol;
        e.served = ["diagnostic", ...hello.data.contributes.filter(p => p !== "diagnostic" && Object.hasOwn(manifest.contributes, p))];
        this.setState(ctx, e, "ready");
        return proc;
      } catch (err) {
        e.stopping = true; await proc.terminate(); e.stopping = false;
        this.recordCrash(ctx, e, err instanceof Error ? err.message : String(err));
        throw err instanceof CoreError ? err : new CoreError("plugin_refused", String(err));
      }
    })();
    try { return await e.starting; } finally { e.starting = undefined; }
  }

  private onExit(ctx: Ctx, e: Entry, proc: PluginProcess, info: { code: number | null; signal: string | null }): void {
    if (e.process === proc) e.process = undefined;
    if (e.stopping || e.state === "starting") return; // handled by start() or stop()
    this.recordCrash(ctx, e, `exited${info.code !== null ? ` with code ${info.code}` : info.signal ? ` on ${info.signal}` : ""}`);
  }

  private recordCrash(ctx: Ctx, e: Entry, reason: string): void {
    const now = Date.now();
    e.crashes = [...e.crashes.filter(t => now - t < CRASH_WINDOW_S * 1000), now];
    if (e.crashes.length >= CRASH_LIMIT) { this.setState(ctx, e, "failing", `${reason}; ${CRASH_LIMIT} failures within a minute`); return; }
    e.nextStartAt = now + Math.min(1000 * 2 ** (e.crashes.length - 1), MAX_BACKOFF_MS);
    this.setState(ctx, e, "idle", reason);
  }

  private async stop(e: Entry): Promise<void> {
    const proc = e.process; e.starting = undefined;
    if (!proc) return;
    e.stopping = true;
    try { await proc.terminate(); } finally { e.stopping = false; e.process = undefined; }
  }

  async call<T>(ctx: Ctx, id: string, method: string, params: unknown): Promise<T> {
    const e = this.find(ctx, id);
    if (!ENABLED.has(e.state)) throw new CoreError("plugin_unavailable", `plugin ${id} is ${e.state}${e.error ? `: ${e.error}` : ""}`);
    const def = EXTENSION_METHODS[method];
    if (!def) throw new CoreError("unknown_op", `unknown plugin method ${method}`);
    const run = async () => {
      const proc = await this.start(ctx, e);
      const point = method.split(".")[0]!;
      if (!e.served.includes(point)) throw new CoreError("plugin_unavailable", `plugin ${id} does not serve ${point}`);
      return proc.request<T>(method, params, def.deadlineMs);
    };
    if (e.manifest?.reentrant) return run();
    const result = e.queue.then(run, run);
    e.queue = result.catch(() => undefined);
    return result;
  }

  async enable(ctx: Ctx, id: string, grant: boolean): Promise<{ id: string; state: PluginState; needs?: string[] }> {
    this.refresh(ctx);
    const e = this.find(ctx, id);
    if (e.state === "refused") throw new CoreError("plugin_refused", `plugin ${id} cannot be enabled: ${e.error}`);
    const m = e.manifest!;
    const needs = m.capabilities.map(c => c.name);
    const current = pluginsConfig(ctx).installed[id];
    const covered = e.bundled || (current !== undefined && needs.every(n => current.capabilities.includes(n)));
    if (!covered && !grant) return { id, state: "needs_grant", needs };
    if (!e.bundled && (!covered || current?.version !== m.version)) await setPluginGrant(ctx, id, { version: m.version, capabilities: needs });
    await setPluginDisabled(ctx, id, false);
    e.crashes = []; e.nextStartAt = 0;
    if (e.state === "failing") e.state = "idle";
    this.refresh(ctx);
    return { id, state: e.state };
  }

  async disable(ctx: Ctx, id: string): Promise<{ id: string; state: PluginState }> {
    const e = this.find(ctx, id);
    if (e.state === "refused") throw new CoreError("plugin_refused", `plugin ${id} is refused: ${e.error}`);
    await setPluginDisabled(ctx, id, true);
    await this.stop(e);
    this.refresh(ctx);
    return { id, state: e.state };
  }

  async remove(ctx: Ctx, id: string): Promise<{ id: string; removed: true }> {
    const e = this.find(ctx, id);
    if (e.bundled) throw new CoreError("not_allowed", `plugin ${id} is bundled with pacer and cannot be removed`, "Use plugin.disable instead.");
    await this.stop(e);
    rmSync(e.dir!, { recursive: true, force: true });
    await setPluginGrant(ctx, id, null);
    await setPluginDisabled(ctx, id, false);
    this.refresh(ctx);
    return { id, removed: true };
  }

  async doctor(ctx: Ctx, id?: string): Promise<DoctorReport[]> {
    this.refresh(ctx);
    const targets = id ? [this.find(ctx, id)] : [...this.entries.values()].sort((a, b) => a.id.localeCompare(b.id));
    return Promise.all(targets.map(async (e): Promise<DoctorReport> => {
      const base = { id: e.id, served: e.served, protocol: { host: PLUGIN_PROTOCOL_VERSION, plugin: e.pluginProtocol }, needs: e.manifest?.host ?? null };
      if (!ENABLED.has(e.state)) return { ...base, ok: false, state: e.state, pid: null, restarts: e.crashes.length, error: e.error };
      try {
        await this.call(ctx, e.id, "diagnostic.ping", {});
        return { ...base, ok: true, state: e.state, served: e.served, protocol: { host: PLUGIN_PROTOCOL_VERSION, plugin: e.pluginProtocol }, pid: e.process?.pid ?? null, restarts: e.crashes.length, error: null };
      } catch (err) {
        const code = err instanceof CoreError ? err.code : "internal";
        return { ...base, ok: false, state: e.state, pid: e.process?.pid ?? null, restarts: e.crashes.length, error: `${code}: ${err instanceof Error ? err.message : String(err)}` };
      }
    }));
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.entries.values()].map(e => this.stop(e)));
    await this.published;
  }
}
