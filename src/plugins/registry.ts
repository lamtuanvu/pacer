import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { appendActivity } from "../activity/log";
import { CoreError } from "../core/errors";
import { publish } from "../link/publish";
import type { Ctx } from "../types";
import { forgetSettings, readPluginSettings } from "./settings";
import { type PluginGrant, pluginsConfig, setPluginDisabled, setPluginGrant } from "./config";
import { answerCapability, appendPluginLog } from "./host";
import { hostRangeAccepts, readManifestFile } from "./manifest";
import { PluginProcess, type SpawnSpec } from "./process";
import { EXTENSION_METHODS, HELLO_METHOD, NOTIFICATIONS, uiOf, parseViewDocument, parseStatusItemDocument, type ViewDocument, PLUGIN_ID, PLUGIN_PROTOCOL_MAJOR, PLUGIN_PROTOCOL_VERSION, type PluginManifest, type PluginState, helloResult } from "./protocol";
import type { BundledPlugin } from "./types";
import { currentVersion } from "../update/version";

export type SurfaceKind = "activity" | "panelTabs" | "settings" | "status";
export interface SurfaceInfo { plugin: string; surface: SurfaceKind; id: string; title: string; icon: string | null; context: "global" | "task"; visible: boolean; state: PluginState }
const KINDS: SurfaceKind[] = ["activity", "panelTabs", "settings", "status"];
/** Surface kinds a manifest contributes. A grant covers a kind, so a version that adds one asks again. */
export function surfaceKinds(m: PluginManifest | null): SurfaceKind[] {
  const ui = m ? uiOf(m) : null;
  return ui ? KINDS.filter(k => ui[k].length > 0) : [];
}
const grantCovers = (m: PluginManifest, g: PluginGrant | null | undefined) => g != null && m.capabilities.every(c => g.capabilities.includes(c.name)) && surfaceKinds(m).every(k => (g.surfaces ?? []).includes(k));

export interface RegistryDeps { bundled: BundledPlugin[]; spawnBundled: (ctx: Ctx, id: string) => SpawnSpec; spawn?: typeof nodeSpawn; sleep?: (ms: number) => Promise<void> }
export interface PluginInfo { ui: Record<SurfaceKind, number>; surfaces: SurfaceKind[]; id: string; version: string; publisher: string; tier: "free" | "commercial"; bundled: boolean; enabled: boolean; state: PluginState; contributes: string[]; capabilities: { name: string; scopes?: string[] }[]; grant: PluginGrant | null; error: string | null; pid: number | null }
export interface DoctorReport { id: string; ok: boolean; state: PluginState; served: string[]; protocol: { host: string; plugin: string | null }; pid: number | null; restarts: number; error: string | null; needs: string | null }

interface Entry {
  id: string; manifest: PluginManifest | null; bundled: boolean; dir: string | null;
  state: PluginState; error: string | null; served: string[]; pluginProtocol: string | null;
  process?: PluginProcess; starting?: Promise<PluginProcess>; queue: Promise<unknown>;
  crashes: number[]; nextStartAt: number; stopping: boolean;
  invalidatedAt: number; invalidatePending: string | null | undefined; invalidateTimer?: ReturnType<typeof setTimeout>; lastInvalidLog: Map<string, number>; renders: Map<string, number[]>; actions: number[]; inflight: Set<string>; cache: Map<string, { document: ViewDocument; at: number; ttlS: number }>;
}
const ENABLED: ReadonlySet<PluginState> = new Set(["idle", "starting", "ready"]);
const MAX_CACHE_ENTRIES = 64;
const CRASH_WINDOW_S = 60, CRASH_LIMIT = 3, MAX_BACKOFF_MS = 30_000, HELLO_DEADLINE_MS = 10_000;

export class PluginRegistry {
  private published: Promise<unknown> = Promise.resolve();
  private readonly entries = new Map<string, Entry>();
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly deps: RegistryDeps) { this.sleep = deps.sleep ?? (ms => Bun.sleep(ms)); }

  private entry(id: string, manifest: PluginManifest | null, bundled: boolean, dir: string | null): Entry {
    let e = this.entries.get(id);
    if (!e) { e = { id, manifest, bundled, dir, state: "idle", error: null, served: [], pluginProtocol: null, queue: Promise.resolve(), crashes: [], nextStartAt: 0, stopping: false, invalidatedAt: 0, invalidatePending: undefined, lastInvalidLog: new Map(), renders: new Map(), actions: [], inflight: new Set(), cache: new Map() }; this.entries.set(id, e); }
    e.manifest = manifest; e.bundled = bundled; e.dir = dir;
    return e;
  }

  private setState(ctx: Ctx, e: Entry, state: PluginState, error: string | null = null): void {
    if (e.state === state && e.error === error) return;
    e.state = state; e.error = error;
    if (state === "disabled" || state === "needs_grant" || state === "refused" || state === "failing") e.cache.clear();
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
      const covered = e.bundled || grantCovers(m, grant);
      if (cfg.disabled.includes(e.id)) { void this.stop(e); this.setState(ctx, e, "disabled"); return; }
      if (!covered) { void this.stop(e); this.setState(ctx, e, "needs_grant", `needs a grant for ${[...m.capabilities.map(c => c.name), ...surfaceKinds(m).map(k => `${k} surfaces`)].join(", ") || "no capabilities"}`); return; }
      if (!ENABLED.has(e.state) && e.state !== "failing") this.setState(ctx, e, "idle");
    };
    for (const b of this.deps.bundled) {
      const e = this.entry(b.manifest.id, b.manifest, true, null);
      apply(e, hostRangeAccepts(b.manifest.host, PLUGIN_PROTOCOL_VERSION) ? null : `needs host ${b.manifest.host}; this pacer serves ${PLUGIN_PROTOCOL_VERSION}`, null);
    }
    const root = join(ctx.pacerHome, "plugins");
    const folders = existsSync(root) ? readdirSync(root).filter(f => statSync(join(root, f)).isDirectory()) : [];
    for (const folder of folders) {
      const dir = join(root, folder);
      if (this.deps.bundled.some(b => b.manifest.id === folder)) { apply(this.entry(folder, null, false, dir), `shadows the bundled plugin ${folder}`, null); continue; }
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

  /** The plugin's current state with no refresh, no start and no event; null when the registry has not loaded it. */
  peek(id: string): PluginState | null { return this.entries.get(id)?.state ?? null; }

  list(ctx: Ctx): PluginInfo[] {
    this.refresh(ctx);
    const cfg = pluginsConfig(ctx);
    return [...this.entries.values()].sort((a, b) => a.id.localeCompare(b.id)).map(e => ({
      ui: this.counts(e), surfaces: surfaceKinds(e.manifest),
      id: e.id, version: e.manifest?.version ?? "", publisher: e.manifest?.publisher ?? "", tier: e.manifest?.tier ?? "free", bundled: e.bundled,
      enabled: ENABLED.has(e.state) || e.state === "failing", state: e.state, contributes: Object.keys(e.manifest?.contributes ?? {}),
      capabilities: e.manifest?.capabilities ?? [], grant: cfg.installed[e.id] ?? null, error: e.error, pid: e.process?.pid ?? null,
    }));
  }

  private counts(e: Entry): Record<SurfaceKind, number> {
    const ui = e.manifest ? uiOf(e.manifest) : null;
    return { activity: ui?.activity.length ?? 0, panelTabs: ui?.panelTabs.length ?? 0, settings: ui?.settings.length ?? 0, status: ui?.status.length ?? 0 };
  }

  /** Surfaces of every enabled, granted plugin. Starts nothing. */
  uiList(ctx: Ctx): SurfaceInfo[] {
    this.refresh(ctx);
    const out: SurfaceInfo[] = [];
    for (const e of [...this.entries.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      const ui = e.manifest ? uiOf(e.manifest) : null;
      if (!ui || !(ENABLED.has(e.state) || e.state === "failing")) continue;
      const hidden = readPluginSettings(ctx, e.id).hidden;
      for (const kind of KINDS) for (const s of ui[kind]) out.push({ plugin: e.id, surface: kind, id: s.id, title: s.title, icon: "icon" in s ? s.icon : null, context: "context" in s ? s.context : "global", visible: !hidden.includes(`${kind}:${s.id}`), state: e.state });
    }
    return out;
  }

  /** The manifest settings schema of a plugin that has a settings page. */
  settingsSchema(ctx: Ctx, id: string) {
    const e = this.find(ctx, id);
    const page = e.manifest ? uiOf(e.manifest)?.settings[0] : undefined;
    if (!page) throw new CoreError("not_found", `plugin ${id} has no settings page`);
    if (!(ENABLED.has(e.state) || e.state === "failing")) throw new CoreError("plugin_unavailable", `plugin ${id} is ${e.state}`);
    return page;
  }

  /** Ask a running plugin to veto values; a plugin that is not running cannot object. */
  async validateWithPlugin(ctx: Ctx, id: string, pageId: string, values: Record<string, unknown>): Promise<{ path: string; message: string }[]> {
    const e = this.find(ctx, id);
    if (e.state !== "ready") return [];
    const r = await this.call<{ ok: boolean; errors?: { path: string; message: string }[] }>(ctx, id, "ui.settings.validate", { id: pageId, values });
    return r.ok ? [] : (r.errors ?? []);
  }

  hasSurface(ctx: Ctx, id: string, kind: SurfaceKind, surfaceId: string): boolean {
    const e = this.find(ctx, id);
    const ui = e.manifest ? uiOf(e.manifest) : null;
    return !!ui?.[kind].some(s => s.id === surfaceId);
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
        onNotification: (m, p) => this.notified(ctx, e, m, p),
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


  /** Plugin → host notifications. Only allowlisted names, only from plugins serving the owning extension point. */
  private notified(ctx: Ctx, e: Entry, method: string, params: unknown): void {
    const def = NOTIFICATIONS[method];
    if (!def || !e.served.includes(def.point)) return;
    const parsed = def.params.safeParse(params);
    if (!parsed.success) return;
    const id = (parsed.data as { id?: string }).id ?? null;
    const ui = e.manifest ? uiOf(e.manifest) : null;
    if (!ui) return;
    if (id !== null) {
      const kinds = KINDS.filter(k => ui[k].some(x => x.id === id));
      if (!kinds.length) return;
      const hidden = readPluginSettings(ctx, e.id).hidden;
      if (kinds.every(k => hidden.includes(`${k}:${id}`))) return; // hidden surfaces drop invalidations
    }
    this.invalidate(ctx, e, id);
  }

  /** Drop cached documents and tell clients to re-render. Coalesced to one event per second with a trailing event, so the last change is never lost. */
  invalidate(ctx: Ctx, e: Entry, id: string | null): void {
    for (const k of [...e.cache.keys()]) if (id === null || k.startsWith(`${id}\u0000`)) e.cache.delete(k);
    e.invalidatePending = e.invalidatePending === undefined ? id : (e.invalidatePending === id ? id : null);
    const fire = () => {
      const target = e.invalidatePending; e.invalidatePending = undefined; e.invalidatedAt = Date.now();
      this.published = this.published.then(() => publish(ctx, [{ type: "entity", data: { kind: "plugin", id: e.id, value: { id: e.id, state: e.state, error: e.error, ui: target === null || target === undefined ? {} : { id: target } } } }])).catch(() => {});
    };
    const wait = 1000 - (Date.now() - e.invalidatedAt);
    if (wait <= 0) { fire(); return; }
    if (e.invalidateTimer) return;
    e.invalidateTimer = setTimeout(() => { e.invalidateTimer = undefined; if (e.invalidatePending !== undefined) fire(); }, wait);
    e.invalidateTimer.unref?.();
  }

  /** Called after a settings save: re-render every surface of the plugin. */
  invalidatePlugin(ctx: Ctx, id: string): void { this.invalidate(ctx, this.find(ctx, id), null); }

  private surfaceDef(e: Entry, surface: "activity" | "panelTab" | "status", id: string): { title: string; view?: string } {
    const ui = e.manifest ? uiOf(e.manifest) : null;
    const list = !ui ? [] : surface === "activity" ? ui.activity : surface === "panelTab" ? ui.panelTabs : ui.status;
    const found = list.find(s => s.id === id);
    if (!found) throw new CoreError("not_found", `plugin ${e.id} has no ${surface} surface ${id}`);
    return found;
  }

  /** Render one surface: validated, cached for its ttl, served stale when the plugin fails. Status items never start a plugin. */
  async renderSurface(ctx: Ctx, id: string, surface: "activity" | "panelTab" | "status", surfaceId: string, context: { route: string; taskId?: string; theme: string }): Promise<{ document: ViewDocument; renderedAt: number; ttlS: number; stale: boolean }> {
    const e = this.find(ctx, id);
    const def = this.surfaceDef(e, surface, surfaceId);
    const key = `${surfaceId}\u0000${context.route}\u0000${context.taskId ?? ""}\u0000${context.theme}`;
    if (!ENABLED.has(e.state)) throw new CoreError("plugin_unavailable", `plugin ${id} is ${e.state}${e.error ? `: ${e.error}` : ""}`);
    const hit = e.cache.get(key);
    const now = Date.now();
    if (hit && now - hit.at < hit.ttlS * 1000) return { document: hit.document, renderedAt: hit.at, ttlS: hit.ttlS, stale: false };
    if (surface === "status" && e.state !== "ready") throw new CoreError("plugin_unavailable", `plugin ${id} is not running`);
    const recent = (e.renders.get(surfaceId) ?? []).filter(t => now - t < 1000);
    if (recent.length >= 2) throw new CoreError("conflict", `surface ${surfaceId} is rendering too often`, "Retry in a second.");
    e.renders.set(surfaceId, [...recent, now]);
    if (e.renders.size > 16) e.renders.delete(e.renders.keys().next().value as string);
    try {
      const raw = await this.call<{ document: unknown; ttlS?: number }>(ctx, id, "ui.render", { surface, id: surfaceId, view: (def as { view: string }).view, context });
      const doc = (surface === "status" ? parseStatusItemDocument : parseViewDocument)(raw.document);
      if (!doc.ok) {
        if (now - (e.lastInvalidLog.get(surfaceId) ?? 0) >= 60_000) { e.lastInvalidLog.set(surfaceId, now); appendPluginLog(ctx, id, "stderr", `invalid ui.render document for ${surfaceId}: ${doc.error}`); } throw new CoreError("invalid_input", "This plugin's view couldn't be shown"); }
      const ttlS = Math.min(Math.max(raw.ttlS ?? 60, surface === "status" ? 30 : 0), 3600);
      for (const [k, v] of e.cache) if (now - v.at >= v.ttlS * 1000 * 10) e.cache.delete(k);
      while (e.cache.size >= MAX_CACHE_ENTRIES) e.cache.delete(e.cache.keys().next().value as string);
      e.cache.set(key, { document: doc.document, at: now, ttlS });
      return { document: doc.document, renderedAt: now, ttlS, stale: false };
    } catch (err) {
      if (hit && ENABLED.has(e.state) && err instanceof CoreError && err.code !== "invalid_input" && now - hit.at < Math.max(hit.ttlS, 30) * 1000 * 10) return { document: hit.document, renderedAt: hit.at, ttlS: hit.ttlS, stale: true };
      throw err;
    }
  }

  async actionSurface(ctx: Ctx, id: string, surface: "activity" | "panelTab" | "status", surfaceId: string, action: string, context: { route: string; taskId?: string; theme: string }, requestId: string, values?: Record<string, unknown>): Promise<{ result: "done" | "refresh"; message?: string }> {
    const e = this.find(ctx, id);
    this.surfaceDef(e, surface, surfaceId);
    const now = Date.now();
    e.actions = e.actions.filter(t => now - t < 60_000);
    if (e.actions.length >= 10) throw new CoreError("conflict", `plugin ${id} has had too many actions`, "Retry in a minute.");
    if (e.inflight.has(surfaceId)) throw new CoreError("conflict", `surface ${surfaceId} already has an action in flight`, "Retry shortly.");
    e.actions.push(now); e.inflight.add(surfaceId);
    try {
      const out = await this.call<{ result: "done" | "refresh"; message?: string }>(ctx, id, "ui.action", { surface, id: surfaceId, action, context, requestId, ...(values ? { values } : {}) });
      if (out.result === "refresh") for (const k of [...e.cache.keys()]) if (k.startsWith(`${surfaceId}\u0000`)) e.cache.delete(k);
      return out;
    } finally { e.inflight.delete(surfaceId); }
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
      const out = await proc.request<unknown>(method, params, def.deadlineMs);
      if (!method.startsWith("ui.")) return out as T;
      const checked = def.result.safeParse(out);
      if (!checked.success) { appendPluginLog(ctx, id, "stderr", `invalid ${method} result: ${checked.error.issues[0]?.path.join(".") || "result"}`); throw new CoreError("invalid_input", `plugin ${id} returned an invalid ${method} result`); }
      return checked.data as T;
    };
    if (e.manifest?.reentrant) return run();
    const result = e.queue.then(run, run);
    e.queue = result.catch(() => undefined);
    return result;
  }

  async enable(ctx: Ctx, id: string, grant: boolean): Promise<{ id: string; state: PluginState; needs?: string[]; surfaces?: SurfaceKind[] }> {
    this.refresh(ctx);
    const e = this.find(ctx, id);
    if (e.state === "refused") throw new CoreError("plugin_refused", `plugin ${id} cannot be enabled: ${e.error}`);
    const m = e.manifest!;
    const needs = m.capabilities.map(c => c.name);
    const current = pluginsConfig(ctx).installed[id];
    const surfaces = surfaceKinds(m);
    const covered = e.bundled || grantCovers(m, current);
    if (!covered && !grant) return { id, state: "needs_grant", needs, ...(surfaces.length ? { surfaces } : {}) };
    if (!e.bundled && (!covered || current?.version !== m.version)) await setPluginGrant(ctx, id, { version: m.version, capabilities: needs, surfaces });
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
    await forgetSettings(ctx, id);
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
