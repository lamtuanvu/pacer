import { endpointHttpScopes } from "./endpoint-authority";
import { prepareCredentialBindings, type CredentialBinding } from "./credential-bindings";
import { BUNDLED } from "../../plugins/bundled";
import { loadStrategy, MissingStrategyError } from "../config/strategy";
import { validateClassifier, type ClassifierConfig } from "../config/classifier";
import { classifierPluginConfig, classifierSnapshot } from "./classifier-config";
import type { AdapterId } from "../classify/types";
import { prepareHttpAuthority } from "./http-authority";
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
import { prepareStateAuthority } from "./usage-state";
import { prepareWriteAuthority } from "./capability-write";
import { prepareFilesystemAuthority } from "./capability-fs";
import { prepareSpawnAuthority } from "./capability-spawn";
import { CallAdmission, SerialCalls } from "./admission";
import { CallAuthority, createCallAuthority, type CallResources } from "./authority";
import { callMetadata } from "./protocol";
import { PluginProcess, type SpawnSpec } from "./process";
import { EXTENSION_METHODS, HELLO_METHOD, PLUGIN_ID, PLUGIN_PROTOCOL_MAJOR, PLUGIN_PROTOCOL_VERSION, type PluginManifest, type PluginState, helloResult } from "./protocol";
import type { BundledPlugin } from "./types";
import { currentVersion } from "../update/version";

export interface PluginCallOptions { credentialBindings?: readonly CredentialBinding[]; classifierConfig?: ClassifierConfig; resources?: CallResources; accountHome?: string | null; deadlineMs?: number; signal?: AbortSignal; onProgress?: (event: unknown) => void }
export interface RegistryDeps { bundled: BundledPlugin[]; spawnBundled: (ctx: Ctx, id: string) => SpawnSpec; spawn?: typeof nodeSpawn; sleep?: (ms: number) => Promise<void> }
export interface PluginInfo { id: string; version: string; publisher: string; tier: "free" | "commercial"; bundled: boolean; enabled: boolean; state: PluginState; contributes: string[]; capabilities: { name: string; scopes?: string[] }[]; grant: PluginGrant | null; error: string | null; pid: number | null }
export interface DoctorReport { id: string; ok: boolean; state: PluginState; served: string[]; protocol: { host: string; plugin: string | null }; pid: number | null; restarts: number; error: string | null; needs: string | null }

interface ClassifierGeneration { fingerprint: string; manifest: PluginManifest; config: Record<string, unknown> }

interface Entry {
  id: string; manifest: PluginManifest | null; bundled: boolean; dir: string | null;
  state: PluginState; error: string | null; served: string[]; pluginProtocol: string | null;
  process?: PluginProcess; starting?: Promise<PluginProcess>; queue: SerialCalls;
  authorities: Map<string, CallAuthority>;
  crashes: number[]; nextStartAt: number; stopping: boolean;
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
const CRASH_WINDOW_S = 60, CRASH_LIMIT = 3, MAX_BACKOFF_MS = 30_000, HELLO_DEADLINE_MS = 10_000;

export class PluginRegistry {
  private published: Promise<unknown> = Promise.resolve();
  private readonly entries = new Map<string, Entry>();
  private readonly admission = new CallAdmission();
  private readonly refusedShadows = new Set<string>();
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly deps: RegistryDeps) { this.sleep = deps.sleep ?? (ms => Bun.sleep(ms)); }

  private entry(id: string, manifest: PluginManifest | null, bundled: boolean, dir: string | null): Entry {
    let e = this.entries.get(id);
    if (!e) { e = { id, manifest, bundled, dir, state: "idle", error: null, served: [], pluginProtocol: null, queue: new SerialCalls(), authorities: new Map(), crashes: [], nextStartAt: 0, stopping: false }; this.entries.set(id, e); }
    e.manifest = manifest; e.bundled = bundled; e.dir = dir;
    return e;
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
      if (refusal) { void this.stop(e); this.setState(ctx, e, "refused", refusal); return; }
      const m = e.manifest!;
      const covered = e.bundled || (grant !== null && m.capabilities.every(c => grant.capabilities.includes(c.name)));
      if (cfg.disabled.includes(e.id)) { void this.stop(e); this.setState(ctx, e, "disabled"); return; }
      if (!covered) { void this.stop(e); this.setState(ctx, e, "needs_grant", `needs a grant for ${m.capabilities.map(c => c.name).join(", ") || "no capabilities"}`); return; }
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
    const env = { PATH: ctx.env.PATH, HOME: ctx.home, PACER_HOME: ctx.pacerHome, PACER_PLUGIN_ID: e.id, PACER_PLUGIN_PROTOCOL: PLUGIN_PROTOCOL_VERSION };
    if (e.bundled) return { ...this.deps.spawnBundled(ctx, e.id), env };
    return { argv: [join(e.dir!, e.manifest!.entry!)], cwd: e.dir!, env };
  }

  private async start(ctx: Ctx, e: Entry, deadlineAt = Infinity, signal?: AbortSignal, generation?: ClassifierGeneration): Promise<PluginProcess> {
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
        onRequest: (m, p, metadata, deliver, transport) => {
          const parsed = callMetadata.safeParse(metadata);
          const token = parsed.success ? parsed.data?.capabilityCall : undefined;
          const authority = token && e.process === proc ? e.authorities.get(token) : undefined;
          return answerCapability(authority?.ctx ?? ctx, { id: e.id, manifest, ...(generation || canonicalNotifier ? { config } : {}) }, m, p, authority, deliver, transport);
        },
        onStderr: line => appendPluginLog(ctx, e.id, "stderr", line),
        onExit: info => this.onExit(ctx, e, proc, info),
      });
      e.process = proc; e.processGeneration = generation;
      const grants = e.bundled ? manifest.capabilities.map(c => c.name) : (pluginsConfig(ctx).installed[e.id]?.capabilities ?? []);
      try {
        const raw = await proc.request(HELLO_METHOD, { protocol: PLUGIN_PROTOCOL_VERSION, features: ["chunkedResults", "httpBodyChunks", "fileWriteChunks"], pacer: currentVersion(), manifest, config, grants }, Math.min(HELLO_DEADLINE_MS, Math.max(1, deadlineAt - Date.now())), { signal });
        const hello = helloResult.safeParse(raw);
        if (!hello.success) throw new CoreError("plugin_refused", `handshake reply is malformed: ${hello.error.issues[0]?.message ?? "unknown"}`);
        const major = Number(hello.data.protocol.split(".")[0]);
        if (major !== PLUGIN_PROTOCOL_MAJOR) throw new CoreError("plugin_refused", `plugin speaks protocol ${hello.data.protocol}; this pacer serves ${PLUGIN_PROTOCOL_VERSION}`);
        if (hello.data.id !== manifest.id || hello.data.version !== manifest.version) throw new CoreError("plugin_refused", `handshake identity ${hello.data.id}@${hello.data.version} does not match the manifest ${manifest.id}@${manifest.version}`);
        proc.setFeatures(major === 1 && Number(hello.data.protocol.split(".")[1]) >= 1 ? (hello.data.features ?? []).filter(feature => feature === "chunkedResults" || (feature === "httpBodyChunks" && Number(hello.data.protocol.split(".")[1]) >= 2) || (feature === "fileWriteChunks" && Number(hello.data.protocol.split(".")[1]) >= 4)) : []);
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
    if (this.canonicalClassifier(e)) return this.generationTask(e, () => this.stopProcess(e));
    return this.stopProcess(e);
  }

  private async stopProcess(e: Entry): Promise<void> {
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
    const credentialBindings = options.credentialBindings?.map(({ ref, resolve }) => ({ ref, resolve }));
    const e = this.findEntry(ctx, id);
    const classifier = this.canonicalClassifier(e) ? structuredClone(options.classifierConfig ?? this.classifierConfig(ctx)) : undefined;
    const generation = classifier ? this.classifierGeneration(classifier) : undefined;
    if (generation) this.updateGeneration(ctx, e, generation);
    if (!ENABLED.has(e.state)) throw new CoreError("plugin_unavailable", `plugin ${id} is ${e.state}${e.error ? `: ${e.error}` : ""}`);
    const def = EXTENSION_METHODS[method];
    if (!def) throw new CoreError("unknown_op", `unknown plugin method ${method}`);
    const requested = options.deadlineMs ?? def.deadlineMs;
    if (!Number.isFinite(requested) || requested < 0) throw new CoreError("invalid_input", "plugin deadline must be non-negative");
    const duration = method === "usage.read" ? requested === 0 ? def.deadlineMs : Math.min(requested, def.deadlineMs) : requested;
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
      resources = { ...base, http: { hosts: [...selected.hosts] },
        ...(selected.secretAliases ? { secretAliases: { ...selected.secretAliases } } : {}) };
    }
    return this.admission.run(deadlineAt, async signal => {
      const run = async () => {
        if (signal.aborted || Date.now() >= deadlineAt) throw new CoreError("plugin_timeout", "plugin call expired before execution");
        const proc = generation ? await this.startGeneration(ctx, e, generation, deadlineAt, signal) : await this.start(ctx, e, deadlineAt, signal);
        if (generation && (e.retiringGeneration || e.generation?.fingerprint !== generation.fingerprint || e.process !== proc)) throw new CoreError("plugin_unavailable", "classifier configuration generation changed before request");
        const manifest = generation?.manifest ?? e.manifest!;
        const point = method.split(".")[0]!;
        if (!e.served.includes(point)) throw new CoreError("plugin_unavailable", `plugin ${id} does not serve ${point}`);
        if (signal.aborted || Date.now() >= deadlineAt) throw new CoreError("plugin_timeout", "plugin call expired before request");
        const needsAuthority = method === "usage.read" || resources !== undefined || credentialBindings !== undefined;
        const grants = e.bundled ? manifest.capabilities.map(capability => capability.name) : pluginsConfig(ctx).installed[id]?.capabilities ?? [];
        const authority = needsAuthority ? createCallAuthority(ctx, resources ?? { reads: [], commands: [], stores: [] },
          { deadlineMs: deadlineAt, signal, grants, accountHome: options.accountHome }) : undefined;
        if (authority) e.authorities.set(authority.token, authority);
        try {
          if (authority) {
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
            { signal: authority?.signal ?? signal, authority, metadata: authority ? { capabilityCall: authority.token } : undefined, onProgress: options.onProgress });
          if (method === "usage.read") {
            const output = def.result.safeParse(result);
            if (!output.success) throw new CoreError("plugin_refused", "usage reader returned an invalid reading");
            return output.data as T;
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

  async enable(ctx: Ctx, id: string, grant: boolean): Promise<{ id: string; state: PluginState; needs?: string[] }> {
    this.refresh(ctx);
    const e = this.findEntry(ctx, id);
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
    await this.published;
  }
}
