import {ReadOwner} from "./read-owner";
import {EventSubscription} from "./event-subscription";
import {answerTaskCapability} from "./task-capability";
import {POLICY_CAPABILITY_METHODS, POLICY_OBSERVATIONS_FEATURE, pluginMetadata} from "./policy-protocol";
import type { PlannerResources } from "./planner-resources";
import { endpointHttpScopes } from "./endpoint-authority";
import { prepareCredentialBindings, type CredentialBinding } from "./credential-bindings";
import { BUNDLED } from "../../plugins/bundled";
import { loadStrategy, MissingStrategyError } from "../config/strategy";
import { validateClassifier, type ClassifierConfig } from "../config/classifier";
import { classifierCredentialBindings, classifierPluginConfig, classifierSnapshot } from "./classifier-config";
import type { AdapterId } from "../classify/types";
import { prepareHttpAuthority } from "./http-authority";
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
import { prepareStateAuthority } from "./usage-state";
import { prepareWriteAuthority } from "./capability-write";
import { prepareFilesystemAuthority } from "./capability-fs";
import { prepareSpawnAuthority } from "./capability-spawn";
import { CallAdmission, SerialCalls } from "./admission";
import { CallAuthority, createCallAuthority, type CallResources } from "./authority";
import { callMetadata } from "./protocol";
import { PluginProcess, type SpawnSpec } from "./process";
import { EXTENSION_METHODS, HELLO_METHOD, NOTIFICATIONS, uiOf, parseViewDocument, parseStatusItemDocument, type ViewDocument, PLUGIN_ID, PLUGIN_PROTOCOL_MAJOR, PLUGIN_PROTOCOL_VERSION, type PluginManifest, type PluginState, helloResult } from "./protocol";
import type { BundledPlugin } from "./types";
import { currentVersion } from "../update/version";

export interface PluginCallOptions { plannerResources?: PlannerResources; credentialBindings?: readonly CredentialBinding[]; classifierConfig?: ClassifierConfig; resources?: CallResources; accountHome?: string | null; deadlineMs?: number; signal?: AbortSignal; onProgress?: (event: unknown) => void }
export type SurfaceKind = "activity" | "panelTabs" | "settings" | "status";
export interface SurfaceInfo { plugin: string; surface: SurfaceKind; id: string; title: string; icon: string | null; context: "global" | "task"; visible: boolean; state: PluginState }
const KINDS: SurfaceKind[] = ["activity", "panelTabs", "settings", "status"];
/** Surface kinds a manifest contributes. A grant covers a kind, so a version that adds one asks again. */
export function surfaceKinds(m: PluginManifest | null): SurfaceKind[] {
  const ui = m ? uiOf(m) : null;
  return ui ? KINDS.filter(k => ui[k].length > 0) : [];
}
const grantCovers = (m: PluginManifest, g: PluginGrant | null | undefined) => g != null && m.capabilities.every(c => g.capabilities.includes(c.name)) && surfaceKinds(m).every(k => (g.surfaces ?? []).includes(k));

export interface RegistryDeps { bundled: BundledPlugin[]; spawnBundled: (ctx: Ctx, id: string) => SpawnSpec; spawn?: typeof nodeSpawn; sleep?: (ms: number) => Promise<void>; eventPumpMs?:number }
export interface PluginInfo { ui: Record<SurfaceKind, number>; surfaces: SurfaceKind[]; id: string; version: string; publisher: string; tier: "free" | "commercial"; bundled: boolean; enabled: boolean; state: PluginState; contributes: string[]; capabilities: { name: string; scopes?: string[] }[]; grant: PluginGrant | null; error: string | null; pid: number | null }
export interface DoctorReport { id: string; ok: boolean; state: PluginState; served: string[]; protocol: { host: string; plugin: string | null }; pid: number | null; restarts: number; error: string | null; needs: string | null }

interface ClassifierGeneration { fingerprint: string; manifest: PluginManifest; config: Record<string, unknown> }

interface Entry {
  id: string; manifest: PluginManifest | null; bundled: boolean; dir: string | null;
  state: PluginState; error: string | null; served: string[]; pluginProtocol: string | null;
  process?: PluginProcess; starting?: Promise<PluginProcess>; queue: SerialCalls;
  authorities: Map<string, CallAuthority>;
  readOwner?:ReadOwner;subscription?:EventSubscription;observationFingerprint?:string;processObservationFingerprint?:string;
  crashes: number[]; nextStartAt: number; stopping: boolean;
  invalidatedAt: number; invalidatePending: string | null | undefined; invalidateTimer?: ReturnType<typeof setTimeout>; lastInvalidLog: Map<string, number>; renders: Map<string, number[]>; actions: number[]; inflight: Set<string>; cache: Map<string, { document: ViewDocument; at: number; ttlS: number }>;
  plannerFingerprint?:string;plannerRetirement?:Promise<void>;plannerGenerationFailure?:unknown;
  generation?: ClassifierGeneration; processGeneration?: ClassifierGeneration;
  generationTail?: Promise<void>; generationFailure?: unknown; retiringGeneration?: boolean;
}
function freezeSnapshot<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}
const ENABLED: ReadonlySet<PluginState> = new Set(["idle", "starting", "ready"]);
const MAX_CACHE_ENTRIES = 64;
const CRASH_WINDOW_S = 60, CRASH_LIMIT = 3, MAX_BACKOFF_MS = 30_000, HELLO_DEADLINE_MS = 10_000;

export class PluginRegistry {
  private readonly retiredProcesses=new Set<Promise<void>>();
  private readonly observationAdmissions=new WeakSet<CallAuthority>();
  private eventTimer:ReturnType<typeof setInterval>|undefined;
  private published: Promise<unknown> = Promise.resolve();
  private readonly entries = new Map<string, Entry>();
  private readonly admission = new CallAdmission();
  private readonly refusedShadows = new Set<string>();
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly deps: RegistryDeps) { this.sleep = deps.sleep ?? (ms => Bun.sleep(ms)); }

  private entry(id: string, manifest: PluginManifest | null, bundled: boolean, dir: string | null): Entry {
    let e = this.entries.get(id);
    if (!e) { e = { id, manifest, bundled, dir, state: "idle", error: null, served: [], pluginProtocol: null, queue: new SerialCalls(), authorities: new Map(), crashes: [], nextStartAt: 0, stopping: false, invalidatedAt: 0, invalidatePending: undefined, lastInvalidLog: new Map(), renders: new Map(), actions: [], inflight: new Set(), cache: new Map() }; this.entries.set(id, e); }
    e.manifest = manifest; e.bundled = bundled; e.dir = dir;
    return e;
  }

  /** Fresh metadata only: failing enabled policies must remain visible to closed mode. */
  policySnapshot(ctx:Ctx):readonly {id:string;manifest:PluginManifest;bundled:boolean;grant:PluginGrant|null;config:Record<string,unknown>}[] {
    this.refresh(ctx);const cfg=pluginsConfig(ctx);
    return [...this.entries.values()].filter(e=>e.manifest&&Object.hasOwn(e.manifest.contributes,"policy")&&["idle","starting","ready","failing"].includes(e.state))
      .sort((a,b)=>a.id.localeCompare(b.id)).map(e=>structuredClone({id:e.id,manifest:e.manifest!,bundled:e.bundled,grant:e.bundled?null:cfg.installed[e.id]??null,config:cfg.config[e.id]??{}}));
  }
  /**
   * Granted, non-disabled policy plugins that cannot take part in decisions: an
   * updated manifest needs a new grant, the manifest is unreadable or incompatible,
   * or the folder is gone. Closed mode refuses while any is listed.
   */
  policyUnavailable(ctx:Ctx):readonly {id:string;reason:string}[] {
    this.refresh(ctx);const cfg=pluginsConfig(ctx);const out=new Map<string,string>();
    const healthy=(e:Entry|undefined)=>!!e?.manifest&&Object.hasOwn(e.manifest.contributes,"policy")&&["idle","starting","ready","failing"].includes(e.state);
    for(const e of this.entries.values()) {
      if(e.bundled||cfg.disabled.includes(e.id)||!cfg.installed[e.id]||healthy(e)) continue;
      if(cfg.installed[e.id]!.policy===true||(e.manifest&&Object.hasOwn(e.manifest.contributes,"policy"))) out.set(e.id,`${e.state}${e.error?`: ${e.error}`:""}`);
    }
    for(const [id,grant] of Object.entries(cfg.installed)) if(grant.policy===true&&!cfg.disabled.includes(id)&&!out.has(id)&&!healthy(this.entries.get(id))) out.set(id,this.entries.has(id)?"no longer contributes policy":"plugin folder is missing");
    return [...out].sort(([a],[b])=>a.localeCompare(b)).map(([id,reason])=>({id,reason}));
  }
  private eventTimerState():void {
    const active=[...this.entries.values()].some(e=>e.subscription?.active);
    if(!active&&this.eventTimer){clearInterval(this.eventTimer);this.eventTimer=undefined;}
    if(active&&!this.eventTimer&&this.deps.eventPumpMs!==0){this.eventTimer=setInterval(()=>{void this.pumpEvents();},this.deps.eventPumpMs??100);this.eventTimer.unref();}
  }
  /** Host-owned deterministic pump; independent from public API subscriptions. */
  async pumpEvents():Promise<void> {
    await Promise.all([...this.entries.values()].map(e=>e.subscription?.pump()));this.eventTimerState();
  }
  private retireObservations(e:Entry):void {
    e.subscription?.retire();e.readOwner?.revoke();e.subscription=undefined;e.readOwner=undefined;this.eventTimerState();
  }
  private readOwner(e:Entry,proc:PluginProcess,token:string,method:string):ReadOwner {
    const owner=e.readOwner;
    if(e.process!==proc||!owner||owner.token!==token)throw new CoreError("capability_denied","unknown or foreign read owner");
    const capability=method==="capability.events.subscribe"?"events.subscribe":["capability.tasks.read","capability.tasks.list"].includes(method)?"tasks.read":null;
    if(!capability)throw new CoreError("capability_denied","read owners cannot authorize effects");
    owner.assertGranted(capability);return owner;
  }
  private createReadOwner(ctx:Ctx,e:Entry,proc:PluginProcess,manifest:PluginManifest,grants:readonly string[]):ReadOwner {
    const fingerprint=e.observationFingerprint;
    const owner=new ReadOwner(ctx,manifest,grants,()=>{
      this.refresh(ctx);
      return this.entries.get(e.id)===e&&e.process===proc&&proc.alive&&ENABLED.has(e.state)&&e.observationFingerprint===fingerprint;
    });
    e.readOwner=owner;return owner;
  }
  private canonicalClassifier(e: Entry): boolean {
    const reference = BUNDLED.find(plugin => plugin.manifest.id === "pacer-classify");
    return e.bundled && e.id === "pacer-classify" && reference !== undefined && this.deps.bundled.includes(reference);
  }

  private canonicalEndpoint(e: Entry): boolean {
    const reference = BUNDLED.find(plugin => plugin.manifest.id === "pacer-endpoints");
    return e.bundled && e.id === "pacer-endpoints" && reference !== undefined && this.deps.bundled.includes(reference);
  }

  private classifierConfig(ctx: Ctx): ClassifierConfig {
    try {
      const strategy = loadStrategy(ctx);
      return validateClassifier(strategy.classifier, strategy.providers);
    } catch (error) {
      if (error instanceof MissingStrategyError) return validateClassifier(undefined, {});
      throw error;
    }
  }

  private classifierGeneration(cfg: ClassifierConfig): ClassifierGeneration {
    const reference = BUNDLED.find(plugin => plugin.manifest.id === "pacer-classify")!;
    const config = structuredClone(classifierPluginConfig(cfg));
    const scopes = [...new Set(["ollama", "jev"].flatMap(adapter => [...classifierSnapshot(cfg, adapter as AdapterId).hosts]))];
    const manifest = structuredClone(reference.manifest) as PluginManifest;
    manifest.capabilities = manifest.capabilities.map(capability => capability.name === "net.http"
      ? { ...capability, scopes } : capability);
    return freezeSnapshot({ fingerprint: JSON.stringify({ config, scopes }), manifest, config });
  }

  private generationTask<T>(e: Entry, action: () => Promise<T>): Promise<T> {
    const operation = (e.generationTail ?? Promise.resolve()).then(action);
    e.generationTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private updateGeneration(ctx: Ctx, e: Entry, generation: ClassifierGeneration): void {
    e.manifest = generation.manifest;
    if (e.generation?.fingerprint === generation.fingerprint) return;
    e.generation = generation;
    // Serialize retirement behind an in-flight hello; no replacement may start
    // until all old authorities have completed their mandatory revoke cleanup.
    void this.generationTask(e, async () => {
      if (e.processGeneration && e.processGeneration.fingerprint !== e.generation?.fingerprint) {
        try { await this.stopProcess(e); }
        catch (error) { e.generationFailure = error; this.setState(ctx, e, "failing", "classifier generation cleanup failed"); }
      }
    });
  }

  private startGeneration(ctx: Ctx, e: Entry, generation: ClassifierGeneration, deadline: number, signal: AbortSignal): Promise<PluginProcess> {
    return this.generationTask(e, async () => {
      if (e.generationFailure) throw e.generationFailure;
      if (!ENABLED.has(e.state)) throw new CoreError("plugin_unavailable", "classifier is not enabled");
      if (e.generation?.fingerprint !== generation.fingerprint) throw new CoreError("plugin_unavailable", "classifier configuration generation changed before admission");
      if (e.processGeneration && e.processGeneration.fingerprint !== generation.fingerprint) await this.stopProcess(e);
      return this.start(ctx, e, deadline, signal, generation);
    });
  }

  private setState(ctx: Ctx, e: Entry, state: PluginState, error: string | null = null): void {
    if (e.state === state && e.error === error) return;
    e.state = state; e.error = error;
    if (state === "disabled" || state === "needs_grant" || state === "refused" || state === "failing") e.cache.clear();
    if (ctx.readOnly) return; // Passive usage must not create durable plugin event storage.
    this.published = this.published.then(() => publish(ctx, [{ type: "entity", data: { kind: "plugin", id: e.id, value: { id: e.id, state, error } } }])).catch(() => {});
    if (state === "failing") appendActivity(ctx, { kind: "plugin_state", level: "warn", text: `Plugin ${e.id} is failing · ${error ?? "unknown error"}` });
  }

  /** Re-read manifests and config; runtime states survive unless config now disables or refuses the plugin. */
  refresh(ctx: Ctx): void {
    const cfg = pluginsConfig(ctx);
    const seen = new Set<string>();
    const apply = (e: Entry, refusal: string | null, grant: PluginGrant | null) => {
      seen.add(e.id);
      if (refusal) { this.retireObservations(e);void this.stop(e); this.setState(ctx, e, "refused", refusal); return; }
      const m = e.manifest!;
      if(Object.hasOwn(m.contributes,"policy")||m.capabilities.some(c=>c.name==="tasks.read"||c.name==="events.subscribe")) {
        const fingerprint=JSON.stringify({manifest:m,config:cfg.config[e.id]??{},grant});
        if(e.observationFingerprint!==undefined&&e.observationFingerprint!==fingerprint) {
          this.retireObservations(e);
          for(const authority of e.authorities.values())void authority.revoke().catch(()=>{});
          void this.generationTask(e,()=>this.stopProcess(e)).catch(()=>this.setState(ctx,e,"failing","observation generation cleanup failed"));
        }
        e.observationFingerprint=fingerprint;
      }

      if(Object.hasOwn(m.contributes,"planner")) {
        const fingerprint=JSON.stringify({manifest:m,config:cfg.config[e.id]??{},grant});
        if(e.plannerFingerprint!==undefined&&e.plannerFingerprint!==fingerprint) {
          for(const authority of e.authorities.values())void authority.revoke().catch(error=>{e.plannerGenerationFailure=error;});
          const retirement=e.plannerRetirement?e.plannerRetirement.then(()=>this.stopProcess(e)):this.stopProcess(e);
          e.plannerRetirement=retirement.catch(error=>{e.plannerGenerationFailure=error;throw error;});
          void e.plannerRetirement.catch(()=>{});
        }
        e.plannerFingerprint=fingerprint;
      }
      const covered = e.bundled || grantCovers(m, grant);
      if (cfg.disabled.includes(e.id)) { this.retireObservations(e);void this.stop(e); this.setState(ctx, e, "disabled"); return; }
      if (!covered) { this.retireObservations(e);void this.stop(e); this.setState(ctx, e, "needs_grant", `needs a grant for ${[...m.capabilities.map(c => c.name), ...surfaceKinds(m).map(k => `${k} surfaces`)].join(", ") || "no capabilities"}`); return; }
      if (!ENABLED.has(e.state) && e.state !== "failing") this.setState(ctx, e, "idle");
    };
    for (const b of this.deps.bundled) {
      const e = this.entry(b.manifest.id, b.manifest, true, null);
      if (this.canonicalClassifier(e)) this.updateGeneration(ctx, e, this.classifierGeneration(this.classifierConfig(ctx)));
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
      else if (Object.hasOwn(m.contributes, "assistant")) refusal = "only bundled plugins may serve the assistant extension point until installed plugins are sandboxed";
      else if (!hostRangeAccepts(m.host, PLUGIN_PROTOCOL_VERSION)) refusal = `needs host ${m.host}; this pacer serves ${PLUGIN_PROTOCOL_VERSION}`;
      apply(this.entry(folder, refusal ? null : m, false, dir), refusal, cfg.installed[folder] ?? null);
    }
    for (const [id, e] of this.entries) if (!seen.has(id)) { this.retireObservations(e);void this.stop(e); this.entries.delete(id); }
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
    const e = this.findEntry(ctx, id);
    const page = e.manifest ? uiOf(e.manifest)?.settings[0] : undefined;
    if (!page) throw new CoreError("not_found", `plugin ${id} has no settings page`);
    if (!(ENABLED.has(e.state) || e.state === "failing")) throw new CoreError("plugin_unavailable", `plugin ${id} is ${e.state}`);
    return page;
  }

  /** Ask a running plugin to veto values; a plugin that is not running cannot object. */
  async validateWithPlugin(ctx: Ctx, id: string, pageId: string, values: Record<string, unknown>): Promise<{ path: string; message: string }[]> {
    const e = this.findEntry(ctx, id);
    if (e.state !== "ready") return [];
    const r = await this.call<{ ok: boolean; errors?: { path: string; message: string }[] }>(ctx, id, "ui.settings.validate", { id: pageId, values });
    return r.ok ? [] : (r.errors ?? []);
  }

  hasSurface(ctx: Ctx, id: string, kind: SurfaceKind, surfaceId: string): boolean {
    const e = this.findEntry(ctx, id);
    const ui = e.manifest ? uiOf(e.manifest) : null;
    return !!ui?.[kind].some(s => s.id === surfaceId);
  }

  /** Deterministic enabled contribution selection; canonical bundles precede installed providers. */
  find(ctx: Ctx, point: keyof PluginManifest["contributes"], predicate: (contribution: Record<string, unknown>) => boolean): string | null {
    this.refresh(ctx);
    const candidates = [...this.entries.values()].filter(entry => ENABLED.has(entry.state) && entry.manifest
      && Object.hasOwn(entry.manifest.contributes, point));
    candidates.sort((a, b) => Number(b.bundled) - Number(a.bundled) || a.id.localeCompare(b.id));
    return candidates.find(entry => predicate(entry.manifest!.contributes[point] ?? {}))?.id ?? null;
  }

  /** Fan-out providers use lexical id order, independent of bundle preference. */
  findAll(ctx: Ctx, point: keyof PluginManifest["contributes"], predicate: (contribution: Record<string, unknown>) => boolean = () => true): string[] {
    this.refresh(ctx);
    return [...this.entries.values()].filter(entry => ENABLED.has(entry.state) && entry.manifest
      && Object.hasOwn(entry.manifest.contributes, point) && predicate(entry.manifest.contributes[point] ?? {}))
      .map(entry => entry.id).sort();
  }

  private findEntry(ctx: Ctx, id: string): Entry {
    if (!this.entries.size) this.refresh(ctx);
    const e = this.entries.get(id);
    if (!e) { this.refresh(ctx); const again = this.entries.get(id); if (!again) throw new CoreError("unknown_plugin", `unknown plugin ${id}`); return again; }
    return e;
  }

  private spec(ctx: Ctx, e: Entry): SpawnSpec {
    const env = { PATH: ctx.env.PATH, HOME: ctx.home, PACER_HOME: ctx.pacerHome, PACER_PLUGIN_ID: e.id, PACER_PLUGIN_PROTOCOL: PLUGIN_PROTOCOL_VERSION, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "" };
    if (e.bundled) {
      const spec = this.deps.spawnBundled(ctx, e.id);
      // Only the trusted launcher may issue a fixed development core selector.
      // Installed peers never inherit it, nor any other launcher environment.
      return { ...spec, env: { ...env, ...(typeof spec.env.PACER_CORE_ARGV === "string" ? {PACER_CORE_ARGV:spec.env.PACER_CORE_ARGV} : {}) } };
    }
    return { argv: [join(e.dir!, e.manifest!.entry!)], cwd: e.dir!, env };
  }

  private async start(ctx: Ctx, e: Entry, deadlineAt = Infinity, signal?: AbortSignal, generation?: ClassifierGeneration): Promise<PluginProcess> {
    // A process outlives its launching request; each pending call owns its signal separately.
    const {operation:_operation,...processCtx}=ctx;
    ctx=processCtx;
    if (e.starting) return e.starting;
    if (e.process?.alive) return e.process;
    e.starting = (async () => {
      const wait = e.nextStartAt - Date.now();
      if (signal?.aborted || Date.now() >= deadlineAt || Date.now() + wait >= deadlineAt) throw new CoreError("plugin_timeout", "plugin call expired before startup");
      if (wait > 0) await this.sleep(wait);
      if (signal?.aborted || Date.now() >= deadlineAt) throw new CoreError("plugin_timeout", "plugin call expired before startup");
      this.setState(ctx, e, "starting");
      const manifest = generation?.manifest ?? structuredClone(e.manifest!);
      const notifierReference = BUNDLED.find(plugin => plugin.manifest.id === "pacer-notify");
      const canonicalNotifier = e.bundled && e.id === "pacer-notify" && notifierReference !== undefined && this.deps.bundled.includes(notifierReference);
      const config = canonicalNotifier ? Object.freeze({ platform: process.platform }) : generation?.config ?? pluginsConfig(ctx).config[e.id] ?? {};
      const proc = new PluginProcess(this.spec(ctx, e), {
        spawn: this.deps.spawn,
        onRequest: async (m, p, metadata, deliver, transport) => {
          const parsed = pluginMetadata.safeParse(metadata);
          if(!parsed.success)throw new CoreError("capability_denied","invalid plugin authority metadata");
          const token=parsed.data&&"capabilityCall" in parsed.data?parsed.data.capabilityCall:undefined;
          const readToken=parsed.data&&"readOwner" in parsed.data?parsed.data.readOwner:undefined;
          const authority = token && e.process === proc ? e.authorities.get(token as string) : undefined;
          if(m==="capability.events.subscribe"||m==="capability.tasks.read"||m==="capability.tasks.list") {
            if(!proc.supports(POLICY_OBSERVATIONS_FEATURE))throw new CoreError("capability_denied","observation transport not negotiated");
            const capability=m==="capability.events.subscribe"?"events.subscribe":"tasks.read";
            if(!manifest.capabilities.some(c=>c.name===capability))throw new CoreError("capability_denied",`plugin ${e.id} did not declare ${capability}`);
            const owner=readToken?this.readOwner(e,proc,readToken as string,m):authority;
            if(!owner)throw new CoreError("capability_denied","observations require an active pending call or read owner");
            owner.assertGranted(capability);
            if(m!=="capability.events.subscribe")return answerTaskCapability(owner.ctx,m,p,owner,transport);
            if(!transport)throw new CoreError("capability_denied","observations require a captured transport");
            const input=POLICY_CAPABILITY_METHODS[m]!.params.safeParse(p);
            if(!input.success)throw new CoreError("invalid_input","invalid subscription types");
            const types=(input.data as {types:string[]}).types;
            if(new Set(types).size!==types.length)throw new CoreError("invalid_input","subscription types must be unique");
            if(owner.ctx.env.PACER_WORK_GRANT)throw new CoreError("not_allowed","Work grants cannot subscribe to global events");
            if(!transport.resultFits({ok:true,readOwner:"pro_"+"0".repeat(64)}))throw new CoreError("too_large","subscription acknowledgement exceeds transport frame");
            if(owner instanceof CallAuthority&&!this.observationAdmissions.has(owner))throw new CoreError("capability_denied","subscription bootstrap requires doctor or policy admission");
            const {eventsSince}=await import("../api/events");
            owner.assertGranted("events.subscribe");
            const grants=e.bundled?manifest.capabilities.map(c=>c.name):pluginsConfig(ctx).installed[e.id]?.capabilities??[];
            const generationOwner=e.readOwner??this.createReadOwner(owner.readContext(),e,proc,manifest,grants);
            generationOwner.assertGranted("events.subscribe");
            e.subscription?.retire(undefined,false);
            const subscription=new EventSubscription(generationOwner,types,{
              read:cursor=>eventsSince(generationOwner.readContext(),cursor,3),
              deliver:(event,guard)=>proc.notifyBounded("$/event",event,()=>{guard();if(e.process!==proc)throw new CoreError("capability_denied","event process retired");}),
              onRetire:reason=>{if(e.subscription!==subscription)return;appendPluginLog(ctx,e.id,"observation",reason);this.setState(ctx,e,"failing",reason);void this.stop(e).catch(()=>{});},
            });
            e.subscription=subscription;
            const result={ok:true,readOwner:generationOwner.token};if(deliver)deliver(result);this.eventTimerState();return Promise.resolve(result);
          }
          if(readToken)throw new CoreError("capability_denied","read owner cannot authorize this method");
          return answerCapability(authority?.ctx ?? ctx, { id: e.id, manifest, ...(generation || canonicalNotifier ? { config } : {}) }, m, p, authority, deliver, transport);
        },
        onNotification: (m, p) => this.notified(ctx, e, m, p),
        validateReadOwner:(token,method)=>{this.readOwner(e,proc,token,method);},
        onStderr: line => appendPluginLog(ctx, e.id, "stderr", line),
        onDisconnect:()=>{
          this.retiredProcesses.add(proc.exited);void proc.exited.then(()=>this.retiredProcesses.delete(proc.exited));
          if(e.process!==proc)return;
          this.retireObservations(e);
          for(const authority of e.authorities.values())void authority.revoke().catch(()=>appendPluginLog(ctx,e.id,"cleanup","owned capability cleanup failed"));
        },
        onExit: info => this.onExit(ctx, e, proc, info),
      });
      e.process = proc; e.processGeneration = generation;e.processObservationFingerprint=e.observationFingerprint;
      const grants = e.bundled ? manifest.capabilities.map(c => c.name) : (pluginsConfig(ctx).installed[e.id]?.capabilities ?? []);
      try {
        const raw = await proc.request(HELLO_METHOD, { protocol: PLUGIN_PROTOCOL_VERSION, features: ["chunkedResults", "httpBodyChunks", "fileWriteChunks", "plannerInstallTransactions",POLICY_OBSERVATIONS_FEATURE], pacer: currentVersion(), manifest, config, grants }, Math.min(HELLO_DEADLINE_MS, Math.max(1, deadlineAt - Date.now())), { signal });
        const hello = helloResult.safeParse(raw);
        if (!hello.success) throw new CoreError("plugin_refused", `handshake reply is malformed: ${hello.error.issues[0]?.message ?? "unknown"}`);
        const major = Number(hello.data.protocol.split(".")[0]);
        if (major !== PLUGIN_PROTOCOL_MAJOR) throw new CoreError("plugin_refused", `plugin speaks protocol ${hello.data.protocol}; this pacer serves ${PLUGIN_PROTOCOL_VERSION}`);
        if (hello.data.id !== manifest.id || hello.data.version !== manifest.version) throw new CoreError("plugin_refused", `handshake identity ${hello.data.id}@${hello.data.version} does not match the manifest ${manifest.id}@${manifest.version}`);
        proc.setFeatures(major === 1 && Number(hello.data.protocol.split(".")[1]) >= 1 ? (hello.data.features ?? []).filter(feature => feature === "chunkedResults" || (feature === "httpBodyChunks" && Number(hello.data.protocol.split(".")[1]) >= 2) || (feature === "fileWriteChunks" && Number(hello.data.protocol.split(".")[1]) >= 4) || (feature === "plannerInstallTransactions" && Number(hello.data.protocol.split(".")[1]) >= 4) || (feature===POLICY_OBSERVATIONS_FEATURE&&Number(hello.data.protocol.split(".")[1])>=6)) : []);
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
  invalidatePlugin(ctx: Ctx, id: string): void { this.invalidate(ctx, this.findEntry(ctx, id), null); }

  private surfaceDef(e: Entry, surface: "activity" | "panelTab" | "status", id: string): { title: string; view?: string } {
    const ui = e.manifest ? uiOf(e.manifest) : null;
    const list = !ui ? [] : surface === "activity" ? ui.activity : surface === "panelTab" ? ui.panelTabs : ui.status;
    const found = list.find(s => s.id === id);
    if (!found) throw new CoreError("not_found", `plugin ${e.id} has no ${surface} surface ${id}`);
    return found;
  }

  /** Render one surface: validated, cached for its ttl, served stale when the plugin fails. Status items never start a plugin. */
  async renderSurface(ctx: Ctx, id: string, surface: "activity" | "panelTab" | "status", surfaceId: string, context: { route: string; taskId?: string; theme: string }): Promise<{ document: ViewDocument; renderedAt: number; ttlS: number; stale: boolean }> {
    const e = this.findEntry(ctx, id);
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
    const e = this.findEntry(ctx, id);
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
    this.retiredProcesses.add(proc.exited);void proc.exited.then(()=>this.retiredProcesses.delete(proc.exited));
    if(e.process!==proc)return;
    this.retireObservations(e);
    if (e.process === proc) for (const authority of e.authorities.values()) void authority.revoke().catch(() => appendPluginLog(ctx, e.id, "cleanup", "owned capability cleanup failed"));
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
    if (this.canonicalClassifier(e)||e.observationFingerprint!==undefined) return this.generationTask(e, () => this.stopProcess(e));
    return this.stopProcess(e);
  }

  private async stopProcess(e: Entry): Promise<void> {
    this.retireObservations(e);
    if (this.canonicalClassifier(e)) e.retiringGeneration = true;
    const cleanup = await Promise.allSettled([...e.authorities.values()].map(authority => authority.revoke()));
    const proc = e.process; e.starting = undefined;
    if (proc) {
      e.stopping = true;
      try { await proc.terminate(); } finally { e.stopping = false; e.process = undefined; }
    }
    const failed = cleanup.find(result => result.status === "rejected");
    if (failed?.status === "rejected") {
      if (this.canonicalClassifier(e)) e.generationFailure = failed.reason;
      throw failed.reason;
    }
    e.retiringGeneration = false;
  }

  async call<T>(ctx: Ctx, id: string, method: string, params: unknown, options: PluginCallOptions = {}): Promise<T> {
    const startedAt = Date.now();
    let credentialBindings = options.credentialBindings?.map(({ ref, resolve }) => ({ ref, resolve }));
    const e = this.findEntry(ctx, id);
    const plannerFingerprint=e.plannerFingerprint;
    const observationFingerprint=e.observationFingerprint;
    const classifier = this.canonicalClassifier(e) ? structuredClone(options.classifierConfig ?? this.classifierConfig(ctx)) : undefined;
    const generation = classifier ? this.classifierGeneration(classifier) : undefined;
    if (generation) this.updateGeneration(ctx, e, generation);
    if (!ENABLED.has(e.state)) throw new CoreError("plugin_unavailable", `plugin ${id} is ${e.state}${e.error ? `: ${e.error}` : ""}`);
    const def = EXTENSION_METHODS[method];
    if (!def) throw new CoreError("unknown_op", `unknown plugin method ${method}`);
    const requested = options.deadlineMs ?? def.deadlineMs;
    if (!Number.isFinite(requested) || requested < 0) throw new CoreError("invalid_input", "plugin deadline must be non-negative");
    const boundedObservation=["diagnostic.ping","policy.before"].includes(method)&&e.manifest!.capabilities.some(c=>c.name==="tasks.read"||c.name==="events.subscribe");
    // usage, bounded observations and main's ui/assistant calls never outlive the method deadline.
    const capped = method === "usage.read" || boundedObservation || method.startsWith("ui.") || method.startsWith("assistant.");
    const duration = capped ? requested === 0 ? def.deadlineMs : Math.min(requested, def.deadlineMs) : requested;
    if ((options.resources || credentialBindings !== undefined || (classifier && method === "classifier.ask")) && duration === 0) throw new CoreError("invalid_input", "scoped capabilities require a finite deadline");
    const deadlineAt = duration === 0 ? Infinity : startedAt + duration;
    const parsed = method === "usage.read" || (classifier && method === "classifier.ask") ? def.params.safeParse(params) : null;
    if (parsed && !parsed.success) throw new CoreError("invalid_input", method === "usage.read" ? "invalid usage reader params" : "invalid classifier params");
    let input = parsed?.success ? parsed.data : params;
    let resources = options.resources;
    if (classifier && method === "classifier.ask") {
      const value = input as Record<string, unknown>;
      const selected = classifierSnapshot(classifier, value.adapter as AdapterId);
      input = { ...value, config: selected.config };
      const base = { ...(resources ?? { reads: [], commands: [], stores: [] }) };
      delete base.secretAliases;
      resources = { ...base, http: { hosts: [...selected.hosts], origins: [...selected.origins] } };
      // The canonical classifier may resolve only the key reference of its selected configuration.
      credentialBindings = classifierCredentialBindings(ctx, selected);
    }
    return this.admission.run(deadlineAt, async signal => {
      const run = async () => {
        if(e.plannerRetirement)await e.plannerRetirement;
        if(e.plannerGenerationFailure)throw e.plannerGenerationFailure;
        if(plannerFingerprint!==e.plannerFingerprint)throw new CoreError("plugin_unavailable","planner configuration generation changed before admission");
        if (signal.aborted || Date.now() >= deadlineAt) throw new CoreError("plugin_timeout", "plugin call expired before execution");
        const proc = generation ? await this.startGeneration(ctx, e, generation, deadlineAt, signal) : observationFingerprint!==undefined?await this.generationTask(e,async()=>{
          if(e.observationFingerprint!==observationFingerprint)throw new CoreError("plugin_unavailable","observation generation changed before admission");
          if(e.process&&e.processObservationFingerprint!==observationFingerprint)await this.stopProcess(e);
          return this.start(ctx,e,deadlineAt,signal);
        }):await this.start(ctx, e, deadlineAt, signal);
        if(observationFingerprint!==e.observationFingerprint)throw new CoreError("plugin_unavailable","observation generation changed before request");
        if (generation && (e.retiringGeneration || e.generation?.fingerprint !== generation.fingerprint || e.process !== proc)) throw new CoreError("plugin_unavailable", "classifier configuration generation changed before request");
        const manifest = generation?.manifest ?? e.manifest!;
        const point = method.split(".")[0]!;
        if (!e.served.includes(point)) throw new CoreError("plugin_unavailable", `plugin ${id} does not serve ${point}`);
        if (signal.aborted || Date.now() >= deadlineAt) throw new CoreError("plugin_timeout", "plugin call expired before request");
        if(options.plannerResources&&(method==="planner.install"||method==="planner.uninstall")&&!proc.supports("plannerInstallTransactions"))throw new CoreError("capability_denied","planner effects require negotiated transactions");
        const observationAdmission=["diagnostic.ping","policy.before"].includes(method)&&manifest.capabilities.some(c=>c.name==="tasks.read"||c.name==="events.subscribe");
        const needsAuthority = observationAdmission || method === "usage.read" || options.plannerResources !== undefined || resources !== undefined || credentialBindings !== undefined;
        const grants = e.bundled ? manifest.capabilities.map(capability => capability.name) : pluginsConfig(ctx).installed[id]?.capabilities ?? [];
        const authority = needsAuthority ? createCallAuthority(ctx, resources ?? { reads: [], commands: [], stores: [] },
          { deadlineMs: deadlineAt, signal, grants, accountHome: options.accountHome }) : undefined;
        if (authority) {e.authorities.set(authority.token, authority);if(observationAdmission)this.observationAdmissions.add(authority);}
        try {
          if (authority) {
            options.plannerResources?.bind(authority,method);
            if (credentialBindings !== undefined) prepareCredentialBindings(authority, credentialBindings);
            await prepareFilesystemAuthority(authority);
            if (authority.resources.writes?.length) await prepareWriteAuthority(authority);
            await prepareStateAuthority(authority);
            prepareSpawnAuthority(authority);
            prepareHttpAuthority(authority, {
              declaredScopes: endpointHttpScopes(this.canonicalEndpoint(e), method, manifest.capabilities.find(capability => capability.name === "net.http")?.scopes ?? [], authority.resources),
              explicitWildcardGrant: !e.bundled && grants.includes("net.http"),
            });
            authority.assertActive();
          }
          const result = await proc.request<T>(method, input, deadlineAt === Infinity ? 0 : Math.max(1, deadlineAt - Date.now()),
            { ...(options.plannerResources && (method==="planner.install"||method==="planner.uninstall"||method==="planner.plan") ? {prepareInput:(fits:(value:unknown)=>boolean)=>options.plannerResources!.prepareInput(input,fits)} : {}), signal: authority?.signal ?? signal, authority, metadata: authority ? { capabilityCall: authority.token } : undefined, onProgress: options.onProgress });
          if (method === "usage.read") {
            const output = def.result.safeParse(result);
            if (!output.success) throw new CoreError("plugin_refused", "usage reader returned an invalid reading");
            return output.data as T;
          }
          if (method.startsWith("ui.")) {
            const checked = def.result.safeParse(result);
            if (!checked.success) { appendPluginLog(ctx, id, "stderr", `invalid ${method} result: ${checked.error.issues[0]?.path.join(".") || "result"}`); throw new CoreError("invalid_input", `plugin ${id} returned an invalid ${method} result`); }
            return checked.data as T;
          }
          return result;
        } finally {
          if (authority) { try { await authority.revoke(); } finally { e.authorities.delete(authority.token); } }
        }
      };
      if (e.manifest?.reentrant) return run();
      return e.queue.run(signal, run);
    }, options.signal);
  }

  async enable(ctx: Ctx, id: string, grant: boolean): Promise<{ id: string; state: PluginState; needs?: string[]; surfaces?: SurfaceKind[] }> {
    this.refresh(ctx);
    const e = this.findEntry(ctx, id);
    if (e.state === "refused") throw new CoreError("plugin_refused", `plugin ${id} cannot be enabled: ${e.error}`);
    const m = e.manifest!;
    const needs = m.capabilities.map(c => c.name);
    const current = pluginsConfig(ctx).installed[id];
    const surfaces = surfaceKinds(m);
    const covered = e.bundled || grantCovers(m, current);
    if (!covered && !grant) return { id, state: "needs_grant", needs, ...(surfaces.length ? { surfaces } : {}) };
    const policy = Object.hasOwn(m.contributes, "policy");
    if (!e.bundled && (!covered || current?.version !== m.version || (current?.policy === true) !== policy)) await setPluginGrant(ctx, id, { version: m.version, capabilities: needs, surfaces, ...(policy ? { policy: true as const } : {}) });
    await setPluginDisabled(ctx, id, false);
    e.crashes = []; e.nextStartAt = 0;
    if (e.state === "failing") e.state = "idle";
    this.refresh(ctx);
    return { id, state: e.state };
  }

  async disable(ctx: Ctx, id: string): Promise<{ id: string; state: PluginState }> {
    const e = this.findEntry(ctx, id);
    if (e.state === "refused") throw new CoreError("plugin_refused", `plugin ${id} is refused: ${e.error}`);
    await setPluginDisabled(ctx, id, true);
    await this.stop(e);
    this.refresh(ctx);
    return { id, state: e.state };
  }

  async remove(ctx: Ctx, id: string): Promise<{ id: string; removed: true }> {
    const e = this.findEntry(ctx, id);
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
    const targets = id ? [this.findEntry(ctx, id)] : [...this.entries.values()].sort((a, b) => a.id.localeCompare(b.id));
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
    await Promise.all([...this.retiredProcesses]);
    await this.published;
  }
}
