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
import { classifierPluginConfig, classifierSnapshot } from "./classifier-config";
import type { AdapterId } from "../classify/types";
import { prepareHttpAuthority } from "./http-authority";
import { spawn as nodeSpawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs";
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
import { HostLeaseBroker, type HostFetchBinding, type HostFetchResult, type HostLeaseSnapshot } from "./host-lease";
import { callMetadata } from "./protocol";
import { PluginProcess, type SpawnSpec } from "./process";
import { EXTENSION_METHODS, HELLO_METHOD, PLUGIN_ID, PLUGIN_PROTOCOL_MAJOR, PLUGIN_PROTOCOL_VERSION, type PluginManifest, type PluginState, helloResult } from "./protocol";
import type { BundledPlugin } from "./types";
import { currentVersion } from "../update/version";
import { controlDir, sshArgv } from "../remote/ssh";
import { SCRIPTS } from "../remote/scripts";
import { HOST_RUNNER_METHODS } from "./host-runner-protocol";
import { discardTransferredBundle, prepareBundleStageAuthority, resolveStagedBundle,
  transferStagedBundleOwnership, type ClaimedBundleTicket } from "./bundle-stage";
import { finalizeClaimedPublication, rollbackClaimedPublication } from "./claimed-bundle";
import { consumePersistedFetch, validatePersistedFetch, type PersistedFetchGrant } from "./fetch-issuer";
import { validateRemotePreflight } from "./remote-preflight";
import { consumeConfiguredHostIdentity, validateConfiguredHostIdentity,
  type ConfiguredHostIdentityGrant } from "./host-identity-issuer";
import { consumePersistedQuestion, validatePersistedQuestion, type PersistedQuestionGrant } from "./question-issuer";
import { consumeConfiguredRemoteUsage, validateConfiguredRemoteUsage, type ConfiguredRemoteUsageGrant } from "./remote-usage-issuer";
import { consumeConfiguredHostClone, validateConfiguredHostClone, type ConfiguredHostCloneGrant } from "./host-clone-issuer";
import { consumeConfiguredHostClean, validateConfiguredHostClean, type ConfiguredHostCleanGrant } from "./host-clean-issuer";
import { consumeConfiguredHostStop, validateConfiguredHostStop, type ConfiguredHostStopGrant } from "./host-stop-issuer";
import { consumeConfiguredHostPrepare, validateConfiguredHostPrepare, type ConfiguredHostPrepareGrant } from "./host-prepare-issuer";
import { beginWorkSync, finishWorkSync } from "../update/desktop/admission";
import { z } from "zod";

const HOST_CHECK_ISSUER = Symbol("host-check-issuer");
type ConfiguredHostCheck = { ok: boolean; checks: { name: string; ok: boolean; detail: string }[]; facts?: Record<string, string> };
const HOST_FETCH_ISSUER = Symbol("host-fetch-issuer");
const HOST_CALL_FETCH_ISSUER = Symbol("host-call-fetch-issuer");
const HOST_CALL_IDENTITY_ISSUER = Symbol("host-call-identity-issuer");
const HOST_CALL_QUESTION_ISSUER = Symbol("host-call-question-issuer");
const HOST_CALL_USAGE_ISSUER = Symbol("host-call-usage-issuer");
const HOST_PROVIDER_MUTATION_ISSUER = Symbol("host-provider-mutation-issuer");
const stagedFetchResult = z.object({ handle: z.string().regex(/^[a-f0-9-]{36}$/),
  bytes: z.number().int().nonnegative().max(50 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type StagedFetchResult = z.infer<typeof stagedFetchResult>;
interface HostFetchAdmission { grant: PersistedFetchGrant; process: PluginProcess; generation: string;
  claim: (authority: CallAuthority, staged: StagedFetchResult) => void | Promise<void> }
interface HostCallerFetchAdmission { grant: PersistedFetchGrant;
  claim: (caller: CallAuthority, ticket: ClaimedBundleTicket) => void | Promise<void> }
export interface PluginCallOptions { plannerResources?: PlannerResources; credentialBindings?: readonly CredentialBinding[]; classifierConfig?: ClassifierConfig; resources?: CallResources; accountHome?: string | null; deadlineMs?: number; signal?: AbortSignal; onProgress?: (event: unknown) => void; /** Internal host-lease binding: never restart or substitute this provider. */ expectedProcess?: PluginProcess; [HOST_CHECK_ISSUER]?: true; [HOST_FETCH_ISSUER]?: HostFetchAdmission; [HOST_CALL_FETCH_ISSUER]?: HostCallerFetchAdmission; [HOST_CALL_IDENTITY_ISSUER]?: ConfiguredHostIdentityGrant; [HOST_CALL_QUESTION_ISSUER]?: PersistedQuestionGrant; [HOST_CALL_USAGE_ISSUER]?: ConfiguredRemoteUsageGrant; [HOST_PROVIDER_MUTATION_ISSUER]?: true }
export interface RegistryDeps { bundled: BundledPlugin[]; spawnBundled: (ctx: Ctx, id: string) => SpawnSpec; spawn?: typeof nodeSpawn; sleep?: (ms: number) => Promise<void>; eventPumpMs?:number }
export interface PluginInfo { id: string; version: string; publisher: string; tier: "free" | "commercial"; bundled: boolean; enabled: boolean; state: PluginState; contributes: string[]; capabilities: { name: string; scopes?: string[] }[]; grant: PluginGrant | null; error: string | null; pid: number | null }
export interface DoctorReport { id: string; ok: boolean; state: PluginState; served: string[]; protocol: { host: string; plugin: string | null }; pid: number | null; restarts: number; error: string | null; needs: string | null }

interface ClassifierGeneration { fingerprint: string; manifest: PluginManifest; config: Record<string, unknown> }

interface Entry {
  id: string; manifest: PluginManifest | null; bundled: boolean; dir: string | null;
  state: PluginState; error: string | null; served: string[]; pluginProtocol: string | null;
  process?: PluginProcess; starting?: Promise<PluginProcess>; queue: SerialCalls;
  authorities: Map<string, CallAuthority>;
  readOwner?:ReadOwner;subscription?:EventSubscription;observationFingerprint?:string;processObservationFingerprint?:string;
  crashes: number[]; nextStartAt: number; stopping: boolean;
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
const CRASH_WINDOW_S = 60, CRASH_LIMIT = 3, MAX_BACKOFF_MS = 30_000, HELLO_DEADLINE_MS = 10_000;

export class PluginRegistry {
  private readonly hostLeases = new HostLeaseBroker({ validate: (lease, authority) => this.validateHostLease(lease, authority) });
  private readonly hostCallGenerations = new WeakMap<CallAuthority, string>();
  private readonly hostCallerFetch = new WeakMap<CallAuthority, HostCallerFetchAdmission>();
  private readonly hostCallerIdentity = new WeakMap<CallAuthority, ConfiguredHostIdentityGrant>();
  private readonly hostCallerQuestion = new WeakMap<CallAuthority, PersistedQuestionGrant>();
  private readonly hostCallerUsage = new WeakMap<CallAuthority, ConfiguredRemoteUsageGrant>();
  private readonly retiredProcesses=new Set<Promise<void>>();
  private readonly observationAdmissions=new WeakSet<CallAuthority>();
  private eventTimer:ReturnType<typeof setInterval>|undefined;
  private published: Promise<unknown> = Promise.resolve();
  private readonly entries = new Map<string, Entry>();
  private readonly admission = new CallAdmission();
  private readonly refusedShadows = new Set<string>();
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly deps: RegistryDeps) { this.sleep = deps.sleep ?? (ms => Bun.sleep(ms)); }

  private hostGeneration(ctx: Ctx, e: Entry): string {
    const cfg = pluginsConfig(ctx);
    return JSON.stringify({ manifest: e.manifest, config: cfg.config[e.id] ?? {}, grant: e.bundled ? null : cfg.installed[e.id] ?? null });
  }

  /** Host state is the sole issuer for this read-only diagnostic check. */
  async checkConfiguredHost(ctx: Ctx, alias: string, repo?: string, signal?: AbortSignal): Promise<ConfiguredHostCheck> {
    return this.issuedHostCheck(ctx, alias, repo === undefined ? {} : { repo }, signal);
  }

  /** Host-only issuer for a declared account folder; the provider can only test directory presence. */
  async checkConfiguredAccountHome(ctx: Ctx, alias: string, account: string, signal?: AbortSignal): Promise<ConfiguredHostCheck> {
    return this.issuedHostCheck(ctx, alias, { account }, signal);
  }

  private async issuedHostCheck(ctx: Ctx, alias: string, target: { repo?: string; account?: string }, signal?: AbortSignal): Promise<ConfiguredHostCheck> {
    const host = loadStrategy(ctx).hosts[alias];
    // A paused host still needs diagnostics; the issued script is read-only.
    if (!host || (target.repo !== undefined && !Object.values(host.repos).includes(target.repo)) ||
      (target.account !== undefined && !Object.hasOwn(host.accounts, target.account)))
      throw new CoreError("capability_denied", "host check target is not configured");
    const home = target.account === undefined ? undefined : host.accounts[target.account]!.home;
    const fingerprint = JSON.stringify(host);
    const providers = this.findAll(ctx, "hostRunner", contribution =>
      Array.isArray(contribution.kinds) && contribution.kinds.length === 1 && contribution.kinds[0] === "ssh");
    if (providers.length !== 1 || providers[0] !== "pacer-ssh")
      throw new CoreError("plugin_unavailable", "bundled SSH host runner provider is required");
    const provider = this.entries.get(providers[0]!)!;
    await this.call(ctx, provider.id, "diagnostic.ping", {}, { deadlineMs: 5000, signal });
    const process = provider.process, generation = this.hostGeneration(ctx, provider);
    if (!process?.alive || !provider.served.includes("hostRunner"))
      throw new CoreError("plugin_unavailable", "SSH host runner provider is not ready");
    const directory = controlDir(ctx), original = lstatSync(directory);
    if (!original.isDirectory() || (original.mode & 0o077) !== 0 ||
      (globalThis.process.getuid && original.uid !== globalThis.process.getuid()))
      throw new CoreError("capability_denied", "SSH control directory is not private");
    const controlPath = join(directory, "cm-%C"), timeoutMs = 50_000;
    const argv = sshArgv(ctx, host, target.repo === undefined && home === undefined ? SCRIPTS.PROBE : SCRIPTS.CHECK_REPO,
      home !== undefined ? [home, "home"] : target.repo === undefined ? [] : [target.repo, "check"]);
    const active = () => {
      const current = loadStrategy(ctx).hosts[alias], now = lstatSync(directory);
      return current && JSON.stringify(current) === fingerprint &&
        provider.process === process && process.alive && this.hostGeneration(ctx, provider) === generation &&
        now.isDirectory() && now.dev === original.dev && now.ino === original.ino &&
        now.uid === original.uid && (now.mode & 0o7777) === (original.mode & 0o7777) &&
        argv.includes(`ControlPath=${controlPath}`);
    };
    if (!active()) throw new CoreError("capability_denied", "host check snapshot changed before issuance");
    const controller = new AbortController();
    const cancel = () => controller.abort(new CoreError("capability_denied", "host check retired"));
    signal?.addEventListener("abort", cancel, { once: true });
    const watch = setInterval(() => { try { if (!active()) cancel(); } catch { cancel(); } }, 100);
    watch.unref();
    try {
      if (signal?.aborted || !active()) throw new CoreError("capability_denied", "host check retired");
      const result = await this.call<ConfiguredHostCheck>(
        ctx, provider.id, "hostRunner.check", { alias, ...(target.repo === undefined ? {} : { repo: target.repo }),
          ...(home === undefined ? {} : { home }), sshTarget: host.ssh, controlPath },
        { deadlineMs: 60_000, signal: controller.signal, expectedProcess: process,
          resources: { reads: [], commands: [{ argv, timeoutMs }], stores: [] }, [HOST_CHECK_ISSUER]: true });
      if (home !== undefined && (result.checks.length !== 1 || result.checks[0]?.name !== "account home" ||
        result.checks[0].ok !== result.ok || result.facts !== undefined))
        throw new CoreError("plugin_refused", "SSH provider did not confirm the account-home check");
      if (!active()) throw new CoreError("capability_denied", "host check snapshot changed");
      return result;
    } finally { clearInterval(watch); signal?.removeEventListener("abort", cancel); }
  }

  /** Host-only one-use clone. A matching remote completion receipt is required to settle the mutation lease. */
  async cloneConfiguredHost(ctx: Ctx, grant: ConfiguredHostCloneGrant, signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
    await consumeConfiguredHostClone(ctx, grant);
    const { alias, args, hostFingerprint } = grant.resource;
    const host = loadStrategy(ctx).hosts[alias];
    if (!host || host.paused || JSON.stringify(host) !== hostFingerprint)
      throw new CoreError("capability_denied", "configured clone host changed");
    const providers = this.findAll(ctx, "hostRunner", contribution =>
      Array.isArray(contribution.kinds) && contribution.kinds.length === 1 && contribution.kinds[0] === "ssh");
    if (providers.length !== 1 || providers[0] !== "pacer-ssh")
      throw new CoreError("plugin_unavailable", "bundled SSH host runner provider is required");
    const provider = this.entries.get(providers[0]!)!;
    await this.call(ctx, provider.id, "diagnostic.ping", {}, { deadlineMs: 5000, signal });
    const process = provider.process, generation = this.hostGeneration(ctx, provider);
    if (!process?.alive || !provider.served.includes("hostRunner"))
      throw new CoreError("plugin_unavailable", "SSH host runner provider is not ready");
    const directory = controlDir(ctx), original = lstatSync(directory);
    if (!original.isDirectory() || (original.mode & 0o077) !== 0 ||
      (globalThis.process.getuid && original.uid !== globalThis.process.getuid()))
      throw new CoreError("capability_denied", "SSH control directory is not private");
    const controlPath = join(directory, "cm-%C"), timeoutMs = grant.resource.timeoutMs;
    const active = () => {
      const current = loadStrategy(ctx).hosts[alias], now = lstatSync(directory);
      return current && !current.paused && JSON.stringify(current) === hostFingerprint &&
        provider.process === process && process.alive && this.hostGeneration(ctx, provider) === generation &&
        now.isDirectory() && now.dev === original.dev && now.ino === original.ino &&
        now.uid === original.uid && (now.mode & 0o7777) === (original.mode & 0o7777);
    };
    if (!active()) throw new CoreError("capability_denied", "configured clone snapshot changed");
    const controller = new AbortController();
    const cancel = () => controller.abort(new CoreError("capability_denied", "configured clone retired"));
    signal?.addEventListener("abort", cancel, { once: true });
    const watch = setInterval(() => { try { if (!active()) cancel(); } catch { cancel(); } }, 100);
    watch.unref();
    let session: string | undefined;
    try {
      const opened = await this.call<{ session: string }>(ctx, provider.id, "hostRunner.open",
        { alias, sshTarget: host.ssh, controlPath },
        { deadlineMs: 10_000, signal: controller.signal, expectedProcess: process });
      session = opened.session;
      await validateConfiguredHostClone(ctx, grant);
      if (controller.signal.aborted || !active()) throw new CoreError("capability_denied", "configured clone retired");
      const nonce = beginWorkSync(ctx, { kind: "operation", id: randomUUID(), label: `Remote clone operation on ${alias}` });
      let issued = false;
      try {
        const argv = sshArgv(ctx, host, SCRIPTS.CHECK_REPO, [...args], nonce);
        if (!argv.includes(`ControlPath=${controlPath}`) || !active())
          throw new CoreError("capability_denied", "configured clone SSH path changed");
        issued = true;
        const result = await this.call<{ code: number; stdout: string; stderr: string; timedOut: boolean }>(
          ctx, provider.id, "hostRunner.run",
          { session, script: "CHECK_REPO", args: [...args], timeoutMs, maxBytes: grant.resource.maxBytes, completionNonce: nonce },
          { deadlineMs: 60_000, signal: controller.signal, expectedProcess: process,
            resources: { reads: [], commands: [{ argv, timeoutMs }], stores: [] }, [HOST_PROVIDER_MUTATION_ISSUER]: true });
        const receipt = `\n__PACER_DONE__=${nonce}\n`;
        if (result.timedOut || result.code === 255 || !result.stdout.endsWith(receipt))
          throw new CoreError("plugin_refused", "remote clone completion is unverified");
        finishWorkSync(ctx, nonce);
        await validateConfiguredHostClone(ctx, grant);
        if (!active()) throw new CoreError("capability_denied", "configured clone host changed after completion");
        return { ...result, stdout: result.stdout.slice(0, -receipt.length) };
      } catch (error) {
        if (!issued) finishWorkSync(ctx, nonce);
        throw error;
      }
    } finally {
      clearInterval(watch); signal?.removeEventListener("abort", cancel);
      if (session) await this.call(ctx, provider.id, "hostRunner.close", { session },
        { deadlineMs: 5000, expectedProcess: process }).catch(() => {});
    }
  }

  /** Host-only one-use cleanup; uncertain completion retains the durable mutation lease. */
  async cleanConfiguredHost(ctx: Ctx, grant: ConfiguredHostCleanGrant, signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
    await consumeConfiguredHostClean(ctx, grant);
    const { alias, args, hostFingerprint } = grant.resource;
    const host = loadStrategy(ctx).hosts[alias];
    if (!host || JSON.stringify(host) !== hostFingerprint)
      throw new CoreError("capability_denied", "configured cleanup host changed");
    const providers = this.findAll(ctx, "hostRunner", contribution =>
      Array.isArray(contribution.kinds) && contribution.kinds.length === 1 && contribution.kinds[0] === "ssh");
    if (providers.length !== 1 || providers[0] !== "pacer-ssh")
      throw new CoreError("plugin_unavailable", "bundled SSH host runner provider is required");
    const provider = this.entries.get(providers[0]!)!;
    await this.call(ctx, provider.id, "diagnostic.ping", {}, { deadlineMs: 5000, signal });
    const process = provider.process, generation = this.hostGeneration(ctx, provider);
    if (!process?.alive || !provider.served.includes("hostRunner"))
      throw new CoreError("plugin_unavailable", "SSH host runner provider is not ready");
    const directory = controlDir(ctx), original = lstatSync(directory);
    if (!original.isDirectory() || (original.mode & 0o077) !== 0 ||
      (globalThis.process.getuid && original.uid !== globalThis.process.getuid()))
      throw new CoreError("capability_denied", "SSH control directory is not private");
    const controlPath = join(directory, "cm-%C"), timeoutMs = grant.resource.timeoutMs;
    const active = () => {
      const current = loadStrategy(ctx).hosts[alias], now = lstatSync(directory);
      return current && JSON.stringify(current) === hostFingerprint &&
        provider.process === process && process.alive && this.hostGeneration(ctx, provider) === generation &&
        now.isDirectory() && now.dev === original.dev && now.ino === original.ino &&
        now.uid === original.uid && (now.mode & 0o7777) === (original.mode & 0o7777);
    };
    if (!active()) throw new CoreError("capability_denied", "configured cleanup snapshot changed");
    const controller = new AbortController();
    const cancel = () => controller.abort(new CoreError("capability_denied", "configured cleanup retired"));
    signal?.addEventListener("abort", cancel, { once: true });
    const watch = setInterval(() => { try { if (!active()) cancel(); } catch { cancel(); } }, 100);
    watch.unref();
    let session: string | undefined;
    try {
      const opened = await this.call<{ session: string }>(ctx, provider.id, "hostRunner.open",
        { alias, sshTarget: host.ssh, controlPath },
        { deadlineMs: 10_000, signal: controller.signal, expectedProcess: process });
      session = opened.session;
      await validateConfiguredHostClean(ctx, grant);
      if (controller.signal.aborted || !active()) throw new CoreError("capability_denied", "configured cleanup retired");
      const nonce = beginWorkSync(ctx, { kind: "operation", id: randomUUID(), label: `Remote cleanup operation on ${alias}` });
      let issued = false;
      try {
        const argv = sshArgv(ctx, host, SCRIPTS.CLEAN, [...args], nonce);
        if (!argv.includes(`ControlPath=${controlPath}`) || !active())
          throw new CoreError("capability_denied", "configured cleanup SSH path changed");
        issued = true;
        const result = await this.call<{ code: number; stdout: string; stderr: string; timedOut: boolean }>(
          ctx, provider.id, "hostRunner.run",
          { session, script: "CLEAN", args: [...args], timeoutMs, maxBytes: grant.resource.maxBytes, completionNonce: nonce },
          { deadlineMs: 60_000, signal: controller.signal, expectedProcess: process,
            resources: { reads: [], commands: [{ argv, timeoutMs }], stores: [] }, [HOST_PROVIDER_MUTATION_ISSUER]: true });
        const receipt = `\n__PACER_DONE__=${nonce}\n`;
        if (result.timedOut || result.code === 255 || !result.stdout.endsWith(receipt))
          throw new CoreError("plugin_refused", "remote cleanup completion is unverified");
        finishWorkSync(ctx, nonce);
        await validateConfiguredHostClean(ctx, grant);
        if (!active()) throw new CoreError("capability_denied", "configured cleanup host changed after completion");
        return { ...result, stdout: result.stdout.slice(0, -receipt.length) };
      } catch (error) {
        if (!issued) finishWorkSync(ctx, nonce);
        throw error;
      }
    } finally {
      clearInterval(watch); signal?.removeEventListener("abort", cancel);
      if (session) await this.call(ctx, provider.id, "hostRunner.close", { session },
        { deadlineMs: 5000, expectedProcess: process }).catch(() => {});
    }
  }

  /** Host-only one-use remote stop. Missing completion leaves the durable mutation lease unsettled. */
  async stopConfiguredHost(ctx: Ctx, grant: ConfiguredHostStopGrant, signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
    consumeConfiguredHostStop(ctx, grant);
    const { alias, args, hostFingerprint } = grant.resource;
    const host = loadStrategy(ctx).hosts[alias];
    if (!host || JSON.stringify(host) !== hostFingerprint)
      throw new CoreError("capability_denied", "configured stop host changed");
    const providers = this.findAll(ctx, "hostRunner", contribution =>
      Array.isArray(contribution.kinds) && contribution.kinds.length === 1 && contribution.kinds[0] === "ssh");
    if (providers.length !== 1 || providers[0] !== "pacer-ssh")
      throw new CoreError("plugin_unavailable", "bundled SSH host runner provider is required");
    const provider = this.entries.get(providers[0]!)!;
    await this.call(ctx, provider.id, "diagnostic.ping", {}, { deadlineMs: 5000, signal });
    const process = provider.process, generation = this.hostGeneration(ctx, provider);
    if (!process?.alive || !provider.served.includes("hostRunner"))
      throw new CoreError("plugin_unavailable", "SSH host runner provider is not ready");
    const directory = controlDir(ctx), original = lstatSync(directory);
    if (!original.isDirectory() || (original.mode & 0o077) !== 0 ||
      (globalThis.process.getuid && original.uid !== globalThis.process.getuid()))
      throw new CoreError("capability_denied", "SSH control directory is not private");
    const controlPath = join(directory, "cm-%C"), timeoutMs = grant.resource.timeoutMs;
    const active = () => {
      const current = loadStrategy(ctx).hosts[alias], now = lstatSync(directory);
      return current && JSON.stringify(current) === hostFingerprint &&
        provider.process === process && process.alive && this.hostGeneration(ctx, provider) === generation &&
        now.isDirectory() && now.dev === original.dev && now.ino === original.ino &&
        now.uid === original.uid && (now.mode & 0o7777) === (original.mode & 0o7777);
    };
    if (!active()) throw new CoreError("capability_denied", "configured stop snapshot changed");
    const controller = new AbortController();
    const cancel = () => controller.abort(new CoreError("capability_denied", "configured stop retired"));
    signal?.addEventListener("abort", cancel, { once: true });
    const watch = setInterval(() => { try { if (!active()) cancel(); } catch { cancel(); } }, 100);
    watch.unref();
    let session: string | undefined;
    try {
      const opened = await this.call<{ session: string }>(ctx, provider.id, "hostRunner.open",
        { alias, sshTarget: host.ssh, controlPath },
        { deadlineMs: 10_000, signal: controller.signal, expectedProcess: process });
      session = opened.session;
      validateConfiguredHostStop(ctx, grant);
      if (controller.signal.aborted || !active()) throw new CoreError("capability_denied", "configured stop retired");
      const nonce = beginWorkSync(ctx, { kind: "operation", id: randomUUID(), label: `Remote stop operation on ${alias}` });
      let issued = false;
      try {
        const argv = sshArgv(ctx, host, SCRIPTS.STOP, [...args], nonce);
        if (!argv.includes(`ControlPath=${controlPath}`) || !active())
          throw new CoreError("capability_denied", "configured stop SSH path changed");
        issued = true;
        const result = await this.call<{ code: number; stdout: string; stderr: string; timedOut: boolean }>(
          ctx, provider.id, "hostRunner.run",
          { session, script: "STOP", args: [...args], timeoutMs, maxBytes: grant.resource.maxBytes, completionNonce: nonce },
          { deadlineMs: timeoutMs + 10_000, signal: controller.signal, expectedProcess: process,
            resources: { reads: [], commands: [{ argv, timeoutMs }], stores: [] }, [HOST_PROVIDER_MUTATION_ISSUER]: true });
        const receipt = `\n__PACER_DONE__=${nonce}\n`;
        if (result.timedOut || result.code === 255 || !result.stdout.endsWith(receipt))
          throw new CoreError("plugin_refused", "remote stop completion is unverified");
        finishWorkSync(ctx, nonce);
        validateConfiguredHostStop(ctx, grant);
        if (!active()) throw new CoreError("capability_denied", "configured stop host changed after completion");
        return { ...result, stdout: result.stdout.slice(0, -receipt.length) };
      } catch (error) {
        if (!issued) finishWorkSync(ctx, nonce);
        throw error;
      }
    } finally {
      clearInterval(watch); signal?.removeEventListener("abort", cancel);
      if (session) await this.call(ctx, provider.id, "hostRunner.close", { session },
        { deadlineMs: 5000, expectedProcess: process }).catch(() => {});
    }
  }

  /** Host-only one-use PREPARE with an exact, bounded binary stdin snapshot. */
  async prepareConfiguredHost(ctx: Ctx, grant: ConfiguredHostPrepareGrant, signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
    const input = await consumeConfiguredHostPrepare(ctx, grant);
    const { alias, args, hostFingerprint } = grant.resource;
    const host = loadStrategy(ctx).hosts[alias];
    if (!host || JSON.stringify(host) !== hostFingerprint)
      throw new CoreError("capability_denied", "configured prepare host changed");
    const providers = this.findAll(ctx, "hostRunner", contribution =>
      Array.isArray(contribution.kinds) && contribution.kinds.length === 1 && contribution.kinds[0] === "ssh");
    if (providers.length !== 1 || providers[0] !== "pacer-ssh")
      throw new CoreError("plugin_unavailable", "bundled SSH host runner provider is required");
    const provider = this.entries.get(providers[0]!)!;
    await this.call(ctx, provider.id, "diagnostic.ping", {}, { deadlineMs: 5000, signal });
    const process = provider.process, generation = this.hostGeneration(ctx, provider);
    if (!process?.alive || !provider.served.includes("hostRunner"))
      throw new CoreError("plugin_unavailable", "SSH host runner provider is not ready");
    const directory = controlDir(ctx), original = lstatSync(directory);
    if (!original.isDirectory() || (original.mode & 0o077) !== 0 ||
      (globalThis.process.getuid && original.uid !== globalThis.process.getuid()))
      throw new CoreError("capability_denied", "SSH control directory is not private");
    const controlPath = join(directory, "cm-%C"), timeoutMs = grant.resource.timeoutMs;
    const active = () => {
      const current = loadStrategy(ctx).hosts[alias], now = lstatSync(directory);
      return current && !current.paused && JSON.stringify(current) === hostFingerprint &&
        provider.process === process && process.alive && this.hostGeneration(ctx, provider) === generation &&
        now.isDirectory() && now.dev === original.dev && now.ino === original.ino &&
        now.uid === original.uid && (now.mode & 0o7777) === (original.mode & 0o7777);
    };
    if (!active()) throw new CoreError("capability_denied", "configured prepare snapshot changed");
    const controller = new AbortController();
    const cancel = () => controller.abort(new CoreError("capability_denied", "configured prepare retired"));
    signal?.addEventListener("abort", cancel, { once: true });
    const watch = setInterval(() => { try { if (!active()) cancel(); } catch { cancel(); } }, 100);
    watch.unref();
    let session: string | undefined;
    try {
      const opened = await this.call<{ session: string }>(ctx, provider.id, "hostRunner.open",
        { alias, sshTarget: host.ssh, controlPath },
        { deadlineMs: 10_000, signal: controller.signal, expectedProcess: process });
      session = opened.session;
      await validateConfiguredHostPrepare(ctx, grant);
      if (controller.signal.aborted || !active()) throw new CoreError("capability_denied", "configured prepare retired");
      const nonce = beginWorkSync(ctx, { kind: "operation", id: randomUUID(), label: `Remote prepare operation on ${alias}` });
      let started = false;
      try {
        const argv = sshArgv(ctx, host, SCRIPTS.PREPARE, [...args], nonce);
        if (!argv.includes(`ControlPath=${controlPath}`) || !active())
          throw new CoreError("capability_denied", "configured prepare SSH path changed");
        started = true;
        const result = await this.call<{ code: number; stdout: string; stderr: string; timedOut: boolean }>(
          ctx, provider.id, "hostRunner.run",
          { session, script: "PREPARE", args: [...args], timeoutMs, maxBytes: grant.resource.maxBytes, completionNonce: nonce },
          { deadlineMs: timeoutMs + 10_000, signal: controller.signal, expectedProcess: process,
            resources: { reads: [], commands: [{ argv, timeoutMs, mode: "prepare-bundle", input,
              inputSha256: createHash("sha256").update(input).digest("hex") }], stores: [] },
            [HOST_PROVIDER_MUTATION_ISSUER]: true });
        const receipt = `\n__PACER_DONE__=${nonce}\n`;
        if (result.timedOut || result.code === 255 || !result.stdout.endsWith(receipt))
          throw new CoreError("plugin_refused", "remote prepare completion is unverified");
        finishWorkSync(ctx, nonce);
        await validateConfiguredHostPrepare(ctx, grant);
        if (!active()) throw new CoreError("capability_denied", "configured prepare host changed after completion");
        return { ...result, stdout: result.stdout.slice(0, -receipt.length) };
      } catch (error) {
        if (!started) finishWorkSync(ctx, nonce);
        throw error;
      }
    } finally {
      clearInterval(watch); signal?.removeEventListener("abort", cancel);
      if (session) await this.call(ctx, provider.id, "hostRunner.close", { session },
        { deadlineMs: 5000, expectedProcess: process }).catch(() => {});
    }
  }

  /** Host-only preparation seam. It returns no artifact until a later verified claimant is wired. */
  async callIssuedHostFetch(ctx: Ctx, id: string, grant: PersistedFetchGrant, params: unknown,
    claim: HostFetchAdmission["claim"], signal?: AbortSignal): Promise<void> {
    const resource = consumePersistedFetch(ctx, grant);
    const parsed = HOST_RUNNER_METHODS["hostRunner.fetch"].params.safeParse(params);
    if (!parsed.success || parsed.data.script !== "BUNDLE_OUT" ||
      JSON.stringify(parsed.data.args) !== JSON.stringify(resource.args) ||
      parsed.data.timeoutMs > resource.timeoutMs || parsed.data.maxBytes > resource.maxBytes)
      throw new CoreError("capability_denied", "host fetch does not match the persisted run");
    const provider = this.findEntry(ctx, id);
    await this.call(ctx, id, "diagnostic.ping", {}, { deadlineMs: 5000, signal });
    const process = provider.process, generation = this.hostGeneration(ctx, provider);
    if (!process?.alive || !provider.served.includes("hostRunner"))
      throw new CoreError("plugin_unavailable", "host fetch provider is unavailable");
    validatePersistedFetch(ctx, grant);
    await this.call<void>(ctx, id, "hostRunner.fetch", parsed.data,
      { deadlineMs: Math.min(120_000, parsed.data.timeoutMs + 10_000), signal, expectedProcess: process,
        resources: { reads: [], commands: [], stores: [], bundleStages: [{ ...resource,
          args: [...resource.args] as [string, string, string], argv: [...resource.argv] }] },
        [HOST_FETCH_ISSUER]: { grant, process, generation, claim } });
  }

  /** Host-only: attach one persisted fetch grant to the exact caller call authority. */
  async callWithIssuedHostFetch<T>(ctx: Ctx, id: string, method: string, params: unknown,
    grant: PersistedFetchGrant, claim: HostCallerFetchAdmission["claim"], signal?: AbortSignal): Promise<T> {
    validatePersistedFetch(ctx, grant);
    const caller = this.findEntry(ctx, id);
    if (method.startsWith("hostRunner.") || !caller.manifest?.capabilities.some(cap => cap.name === "hosts") ||
      caller.manifest.contributes.hostRunner)
      throw new CoreError("capability_denied", "persisted fetch requires a distinct hosts caller");
    return this.call<T>(ctx, id, method, params, { signal,
      deadlineMs: Math.min(120_000, grant.resource.timeoutMs + 30_000),
      [HOST_CALL_FETCH_ISSUER]: { grant, claim } });
  }

  /** Host-only: attach one configured identity operation to a distinct hosts caller. */
  async callWithIssuedHostIdentity<T>(ctx: Ctx, id: string, method: string, params: unknown,
    grant: ConfiguredHostIdentityGrant, signal?: AbortSignal): Promise<T> {
    await validateConfiguredHostIdentity(ctx, grant);
    const caller = this.findEntry(ctx, id);
    if (method.startsWith("hostRunner.") || !caller.manifest?.capabilities.some(cap => cap.name === "hosts") ||
      caller.manifest.contributes.hostRunner)
      throw new CoreError("capability_denied", "configured identity requires a distinct hosts caller");
    await consumeConfiguredHostIdentity(ctx, grant);
    return this.call<T>(ctx, id, method, params, { signal, deadlineMs: 60_000,
      resources: { reads: [], commands: [], stores: [], hosts: [{ ...grant.resource,
        args: [...grant.resource.args] }] }, [HOST_CALL_IDENTITY_ISSUER]: grant });
  }

  /** Host-only: bind one persisted task question operation to a distinct hosts caller. */
  async callWithIssuedHostQuestion<T>(ctx: Ctx, id: string, method: string, params: unknown,
    grant: PersistedQuestionGrant, signal?: AbortSignal): Promise<T> {
    validatePersistedQuestion(ctx, grant);
    const caller = this.findEntry(ctx, id);
    if (method !== "remoteCaller.questionRead" || grant.resource.script !== "QUESTION" ||
      !caller.manifest?.capabilities.some(cap => cap.name === "hosts") || caller.manifest.contributes.hostRunner)
      throw new CoreError("capability_denied", "persisted question requires a distinct hosts caller");
    consumePersistedQuestion(ctx, grant);
    return this.call<T>(ctx, id, method, params, { signal, deadlineMs: 40_000,
      resources: { reads: [], commands: [], stores: [], hosts: [{ ...grant.resource,
        args: [...grant.resource.args] }] }, [HOST_CALL_QUESTION_ISSUER]: grant });
  }

  /** Host-only: bind one configured passive usage read to a distinct hosts caller. */
  async callWithIssuedHostUsage<T>(ctx: Ctx, id: string, method: string, params: unknown,
    grant: ConfiguredRemoteUsageGrant, signal?: AbortSignal): Promise<T> {
    validateConfiguredRemoteUsage(ctx, grant);
    const caller = this.findEntry(ctx, id);
    if (method !== "remoteCaller.usageRead" || grant.resource.script !== "CODEX_USAGE" ||
      !caller.manifest?.capabilities.some(cap => cap.name === "hosts") || caller.manifest.contributes.hostRunner)
      throw new CoreError("capability_denied", "remote usage requires a distinct hosts caller");
    consumeConfiguredRemoteUsage(ctx, grant);
    return this.call<T>(ctx, id, method, params, { signal, deadlineMs: 90_000,
      resources: { reads: [], commands: [], stores: [], hosts: [{ ...grant.resource,
        args: [...grant.resource.args] }] }, [HOST_CALL_USAGE_ISSUER]: grant });
  }

  private async callBrokerHostFetch(ctx: Ctx, caller: CallAuthority, binding: HostFetchBinding,
    grant: PersistedFetchGrant, timeoutMs: number, maxBytes: number, deadlineAt: number,
    signal: AbortSignal): Promise<{ result: HostFetchResult; ticket: ClaimedBundleTicket }> {
    validatePersistedFetch(ctx, grant);
    const provider = this.entries.get(binding.provider.id);
    const process = binding.provider.process as PluginProcess;
    if (!provider || provider.process !== process || !process.alive ||
      this.hostGeneration(ctx, provider) !== binding.provider.generation)
      throw new CoreError("capability_denied", "bound host fetch provider retired");
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new CoreError("plugin_timeout", "host fetch deadline expired");
    const params = { session: binding.providerSession, script: "BUNDLE_OUT", args: [...binding.resource.args],
      timeoutMs: Math.min(timeoutMs, binding.resource.timeoutMs, Math.max(1, Math.floor(remaining))), maxBytes };
    let ticket: ClaimedBundleTicket | undefined, stagedResult: StagedFetchResult | undefined;
    try {
      await this.call<void>(ctx, provider.id, "hostRunner.fetch", params,
        { deadlineMs: remaining, signal, expectedProcess: process,
          resources: { reads: [], commands: [], stores: [], bundleStages: [{ ...binding.resource,
            args: [...binding.resource.args] as [string, string, string], argv: [...binding.resource.argv] }] },
          [HOST_FETCH_ISSUER]: { grant, process, generation: binding.provider.generation,
            claim: (providerAuthority, staged) => {
              const source = resolveStagedBundle(providerAuthority, staged.handle);
              if (source.bytes !== staged.bytes || source.sha256 !== staged.sha256)
                throw new CoreError("plugin_refused", "host fetch stage metadata changed");
              ticket = transferStagedBundleOwnership(providerAuthority, staged.handle, caller, grant);
              stagedResult = staged;
            } } });
      if (!ticket || !stagedResult) throw new CoreError("plugin_refused", "host fetch completed without a private claim");
      caller.assertGranted("hosts");
      return { ticket, result: { handle: ticket.id, bytes: stagedResult.bytes, sha256: stagedResult.sha256 } };
    } catch (error) {
      if (ticket) discardTransferredBundle(caller, ticket);
      throw error;
    }
  }

  private validateHostLease(lease: HostLeaseSnapshot, authority: CallAuthority): void {
    authority.assertGranted("hosts");
    this.refresh(authority.ctx);
    const caller = [...this.entries.values()].find(entry => entry.process === lease.callerProcess);
    if (!caller || !ENABLED.has(caller.state) || !caller.process?.alive ||
      !caller.manifest?.capabilities.some(capability => capability.name === "hosts") ||
      this.hostGeneration(authority.ctx, caller) !== lease.callerGeneration)
      throw new CoreError("capability_denied", "host caller generation retired");
    const host = loadStrategy(authority.ctx).hosts[lease.alias];
    if (!host || host.paused || host.ssh !== lease.sshTarget || JSON.stringify(host) !== lease.hostFingerprint)
      throw new CoreError("capability_denied", "host alias changed or is unavailable");
    const provider = this.entries.get(lease.provider.id);
    if (!provider || !ENABLED.has(provider.state) || provider.process !== lease.provider.process ||
      !provider.process?.alive || !provider.served.includes("hostRunner") ||
      this.hostGeneration(authority.ctx, provider) !== lease.provider.generation)
      throw new CoreError("capability_denied", "host provider generation retired");
  }

  private async answerHosts(ctx: Ctx, caller: Entry, callerProcess: PluginProcess,
    authority: CallAuthority, method: string, params: unknown): Promise<unknown> {
    authority.assertGranted("hosts");
    if (caller.manifest?.contributes.hostRunner) throw new CoreError("capability_denied", "host runner providers cannot forward hosts calls");
    if (method === "capability.hosts.fetch") {
      const admission = this.hostCallerFetch.get(authority);
      if (!admission) throw new CoreError("capability_denied", "host fetch has no persisted caller grant");
      const request = params as { session: string; timeoutMs: number; maxBytes: number };
      if (request.timeoutMs > admission.grant.resource.timeoutMs ||
        request.maxBytes > admission.grant.resource.maxBytes)
        throw new CoreError("capability_denied", "host fetch exceeds the issued bounds");
      let ticket: ClaimedBundleTicket | undefined, leaseBinding: HostFetchBinding | undefined;
      try {
        const preflight = await this.hostLeases.preflight(authority, request.session, admission.grant);
        await this.hostLeases.fetch(authority, request.session, admission.grant,
          async (binding, signal, deadlineAt) => {
            leaseBinding = binding;
            const claimed = await this.callBrokerHostFetch(ctx, authority, binding, admission.grant,
              request.timeoutMs, request.maxBytes, deadlineAt, signal);
            ticket = claimed.ticket;
            return claimed.result;
          }, () => { if (ticket) discardTransferredBundle(authority, ticket); });
        if (!ticket) throw new CoreError("plugin_refused", "host fetch did not claim a private stage");
        authority.assertGranted("hosts");
        await admission.claim(authority, ticket);
        authority.assertGranted("hosts");
        validatePersistedFetch(ctx, admission.grant);
        if (!leaseBinding) throw new CoreError("capability_denied", "host fetch lease binding is unavailable");
        this.validateHostLease(leaseBinding, authority);
        validateRemotePreflight(ctx, preflight, admission.grant, leaseBinding);
        finalizeClaimedPublication(authority, ticket, preflight);
        return { ok: true };
      } catch (error) {
        if (ticket) rollbackClaimedPublication(authority, ticket);
        if (ticket) discardTransferredBundle(authority, ticket);
        throw error;
      }
    }
    if (method === "capability.hosts.run") {
      const request = params as Parameters<HostLeaseBroker["run"]>[1];
      if (request.script === "QUESTION") {
        const grant = this.hostCallerQuestion.get(authority);
        if (!grant || grant.resource.script !== request.script)
          throw new CoreError("capability_denied", "host question has no persisted grant");
        validatePersistedQuestion(ctx, grant);
        const result = await this.hostLeases.run(authority, request);
        validatePersistedQuestion(ctx, grant);
        return result;
      }
      if (request.script === "SET_IDENTITY") {
        const grant = this.hostCallerIdentity.get(authority);
        if (!grant) throw new CoreError("capability_denied", "host identity has no configured grant");
        await validateConfiguredHostIdentity(ctx, grant);
        const result = await this.hostLeases.run(authority, request);
        await validateConfiguredHostIdentity(ctx, grant);
        return result;
      }
      if (request.script === "CODEX_USAGE") {
        const grant = this.hostCallerUsage.get(authority);
        if (!grant) throw new CoreError("capability_denied", "remote usage has no configured grant");
        validateConfiguredRemoteUsage(ctx, grant);
        const result = await this.hostLeases.run(authority, request);
        validateConfiguredRemoteUsage(ctx, grant);
        return result;
      }
      return this.hostLeases.run(authority, request);
    }
    if (method === "capability.hosts.close") return this.hostLeases.close(authority, params as { session: string });
    if (method !== "capability.hosts.open") throw new CoreError("unknown_op", "unknown hosts method");
    const callerGeneration = this.hostCallGenerations.get(authority);
    if (!callerGeneration) throw new CoreError("capability_denied", "host call has no captured generation");
    this.refresh(ctx);
    if (caller.process !== callerProcess || !callerProcess.alive || !ENABLED.has(caller.state) ||
      this.hostGeneration(ctx, caller) !== callerGeneration)
      throw new CoreError("capability_denied", "host caller process retired");
    const alias = (params as { alias: string }).alias;
    const host = loadStrategy(ctx).hosts[alias];
    if (!host || host.paused) throw new CoreError("not_found", "configured host alias is unavailable");
    const providers = this.findAll(ctx, "hostRunner", contribution =>
      Array.isArray(contribution.kinds) && contribution.kinds.length === 1 && contribution.kinds[0] === "ssh");
    if (providers.length !== 1 || providers[0] === caller.id)
      throw new CoreError("plugin_unavailable", "one distinct SSH host runner provider is required");
    const provider = this.entries.get(providers[0]!)!;
    const remaining = authority.deadlineMs - Date.now();
    if (remaining <= 0) throw new CoreError("plugin_timeout", "host call expired before provider startup");
    await this.call(ctx, provider.id, "diagnostic.ping", {}, { deadlineMs: Math.min(5000, remaining), signal: authority.signal });
    const process = provider.process;
    if (!process?.alive || !provider.served.includes("hostRunner"))
      throw new CoreError("plugin_unavailable", "SSH host runner provider is not ready");
    const providerGeneration = this.hostGeneration(ctx, provider);
    const controlDirectory = controlDir(ctx);
    const controlDirectoryEntry = lstatSync(controlDirectory);
    if (!controlDirectoryEntry.isDirectory() || (controlDirectoryEntry.mode & 0o077) !== 0 ||
      (globalThis.process.getuid && controlDirectoryEntry.uid !== globalThis.process.getuid()))
      throw new CoreError("capability_denied", "SSH control directory is not private");
    const controlPath = join(controlDirectory, "cm-%C");
    return this.hostLeases.open(authority, {
      alias, sshTarget: host.ssh, controlPath, hostFingerprint: JSON.stringify(host),
      callerProcess, callerGeneration,
      provider: { id: provider.id, generation: providerGeneration, process,
        invoke: async (providerMethod, input, deadlineAt, signal) => {
          if (provider.process !== process || !process.alive ||
            this.hostGeneration(ctx, provider) !== providerGeneration)
            throw new CoreError("capability_denied", "host provider process changed");
          const deadlineMs = deadlineAt - Date.now();
          if (deadlineMs <= 0) throw new CoreError("plugin_timeout", "host provider deadline expired");
          let resources: CallResources | undefined;
          if (providerMethod === "hostRunner.run") {
            const parsed = HOST_RUNNER_METHODS["hostRunner.run"].params.safeParse(input);
            if (!parsed.success) throw new CoreError("capability_denied", "host operation is not issued for this caller");
            const probe = parsed.data.script === "PROBE" && parsed.data.args.length === 0;
            const repoCheck = parsed.data.script === "CHECK_REPO" && parsed.data.args.length === 2 &&
              parsed.data.args[0]!.length > 0 && parsed.data.args[1] === "check";
            const preflight = parsed.data.script === "PREFLIGHT" && [3, 5].includes(parsed.data.args.length) &&
              parsed.data.args[0]!.startsWith("/") && /^[a-f0-9]{40,64}$/.test(parsed.data.args[1]!) &&
              /^pacer\/[A-Za-z0-9._/-]+$/.test(parsed.data.args[2]!) &&
              !parsed.data.args[2]!.includes("..") && !parsed.data.args[2]!.includes("//") &&
              (parsed.data.args.length === 3 || (/^[a-f0-9]{40}$/.test(parsed.data.args[3]!) &&
                /^[a-f0-9]{64}$/.test(parsed.data.args[4]!)));
            const identity = parsed.data.script === "SET_IDENTITY" && parsed.data.args.length === 3 &&
              parsed.data.args.every(arg => arg.length > 0) && !!parsed.data.completionNonce;
            const question = parsed.data.script === "QUESTION" && parsed.data.args.length === 1;
            const usage = parsed.data.script === "CODEX_USAGE" && parsed.data.args.length <= 1;
            if ((!probe && !repoCheck && !preflight && !identity && !question && !usage) || parsed.data.stdin !== undefined ||
              (!identity && parsed.data.completionNonce !== undefined) || parsed.data.maxBytes > 65_536)
              throw new CoreError("capability_denied", "host operation is not issued for this caller");
            const timeoutMs = Math.min(parsed.data.timeoutMs, Math.max(1, Math.floor(deadlineMs)));
            const currentDirectoryEntry = lstatSync(controlDirectory);
            if (!currentDirectoryEntry.isDirectory() || currentDirectoryEntry.dev !== controlDirectoryEntry.dev ||
              currentDirectoryEntry.ino !== controlDirectoryEntry.ino ||
              currentDirectoryEntry.uid !== controlDirectoryEntry.uid ||
              (currentDirectoryEntry.mode & 0o7777) !== (controlDirectoryEntry.mode & 0o7777))
              throw new CoreError("capability_denied", "SSH control directory changed during provider session");
            const argv = sshArgv(ctx, host, probe ? SCRIPTS.PROBE : preflight ? SCRIPTS.PREFLIGHT :
              identity ? SCRIPTS.SET_IDENTITY : question ? SCRIPTS.QUESTION : usage ? SCRIPTS.CODEX_USAGE : SCRIPTS.CHECK_REPO, parsed.data.args,
              identity ? parsed.data.completionNonce : undefined);
            const issuedDirectoryEntry = lstatSync(controlDirectory);
            if (!argv.includes(`ControlPath=${controlPath}`) ||
              issuedDirectoryEntry.dev !== controlDirectoryEntry.dev ||
              issuedDirectoryEntry.ino !== controlDirectoryEntry.ino ||
              issuedDirectoryEntry.uid !== controlDirectoryEntry.uid ||
              (issuedDirectoryEntry.mode & 0o7777) !== (controlDirectoryEntry.mode & 0o7777))
              throw new CoreError("capability_denied", "SSH control path changed during provider call");
            input = { ...parsed.data, timeoutMs };
            resources = { reads: [], commands: [{ argv, timeoutMs }], stores: [] };
          }
          const output = await this.call(ctx, provider.id, providerMethod, input,
            { deadlineMs, signal, expectedProcess: process, resources,
              ...(providerMethod === "hostRunner.run" && (input as { script?: string }).script === "SET_IDENTITY" ?
                { [HOST_PROVIDER_MUTATION_ISSUER]: true } : {}) });
          if (provider.process !== process || !process.alive ||
            this.hostGeneration(ctx, provider) !== providerGeneration)
            throw new CoreError("capability_denied", "host provider process changed");
          return output;
        } },
    });
  }

  private entry(id: string, manifest: PluginManifest | null, bundled: boolean, dir: string | null): Entry {
    let e = this.entries.get(id);
    if (!e) { e = { id, manifest, bundled, dir, state: "idle", error: null, served: [], pluginProtocol: null, queue: new SerialCalls(), authorities: new Map(), crashes: [], nextStartAt: 0, stopping: false }; this.entries.set(id, e); }
    e.manifest = manifest; e.bundled = bundled; e.dir = dir;
    return e;
  }

  /** Fresh metadata only: failing enabled policies must remain visible to closed mode. */
  policySnapshot(ctx:Ctx):readonly {id:string;manifest:PluginManifest;bundled:boolean;grant:PluginGrant|null;config:Record<string,unknown>}[] {
    this.refresh(ctx);const cfg=pluginsConfig(ctx);
    return [...this.entries.values()].filter(e=>e.manifest&&Object.hasOwn(e.manifest.contributes,"policy")&&["idle","starting","ready","failing"].includes(e.state))
      .sort((a,b)=>a.id.localeCompare(b.id)).map(e=>structuredClone({id:e.id,manifest:e.manifest!,bundled:e.bundled,grant:e.bundled?null:cfg.installed[e.id]??null,config:cfg.config[e.id]??{}}));
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
      const covered = e.bundled || (grant !== null && m.capabilities.every(c => grant.capabilities.includes(c.name)));
      if (cfg.disabled.includes(e.id)) { this.retireObservations(e);void this.stop(e); this.setState(ctx, e, "disabled"); return; }
      if (!covered) { this.retireObservations(e);void this.stop(e); this.setState(ctx, e, "needs_grant", `needs a grant for ${m.capabilities.map(c => c.name).join(", ") || "no capabilities"}`); return; }
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
    for (const [id, e] of this.entries) if (!seen.has(id)) { this.retireObservations(e);void this.stop(e); this.entries.delete(id); }
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
          return answerCapability(authority?.ctx ?? ctx, { id: e.id, manifest, ...(generation || canonicalNotifier ? { config } : {}) }, m, p, authority, deliver, transport,
            (hostMethod, hostParams, owner) => this.answerHosts(owner.ctx, e, proc, owner, hostMethod, hostParams));
        },
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
        proc.setFeatures(major === 1 && Number(hello.data.protocol.split(".")[1]) >= 1 ? (hello.data.features ?? []).filter(feature => feature === "chunkedResults" || (feature === "httpBodyChunks" && Number(hello.data.protocol.split(".")[1]) >= 2) || (feature === "fileWriteChunks" && Number(hello.data.protocol.split(".")[1]) >= 4) || (feature === "plannerInstallTransactions" && Number(hello.data.protocol.split(".")[1]) >= 4) || (feature===POLICY_OBSERVATIONS_FEATURE&&Number(hello.data.protocol.split(".")[1])>=5)) : []);
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
    if (method === "hostRunner.check" && options[HOST_CHECK_ISSUER] !== true)
      throw new CoreError("capability_denied", "host check requires host-owned issuance");
    if (method === "hostRunner.fetch" && !options[HOST_FETCH_ISSUER])
      throw new CoreError("capability_denied", "host fetch requires host-owned issuance");
    if (method === "hostRunner.run" && ((params as { script?: string } | null)?.script === "SET_IDENTITY" ||
      (params as { script?: string } | null)?.script === "CLEAN" ||
      (params as { script?: string } | null)?.script === "STOP" ||
      (params as { script?: string } | null)?.script === "PREPARE" ||
      ((params as { script?: string; args?: string[] } | null)?.script === "CHECK_REPO" &&
        (params as { args?: string[] }).args?.[1] === "clone")) &&
      !options[HOST_PROVIDER_MUTATION_ISSUER])
      throw new CoreError("capability_denied", "host mutation requires host-owned issuance");
    if (options.resources?.commands.some(command => command.mode === "prepare-bundle") &&
      (!options[HOST_PROVIDER_MUTATION_ISSUER] || method !== "hostRunner.run" ||
        (params as { script?: string } | null)?.script !== "PREPARE"))
      throw new CoreError("capability_denied", "remote prepare input requires host-owned issuance");
    if (options.resources?.hosts?.some(resource => resource.script === "SET_IDENTITY") && !options[HOST_CALL_IDENTITY_ISSUER])
      throw new CoreError("capability_denied", "host identity resource requires host-owned issuance");
    if (options.resources?.hosts?.some(resource => resource.script === "QUESTION") && !options[HOST_CALL_QUESTION_ISSUER])
      throw new CoreError("capability_denied", "host question resource requires host-owned issuance");
    if (options.resources?.hosts?.some(resource => resource.script === "CODEX_USAGE") && !options[HOST_CALL_USAGE_ISSUER])
      throw new CoreError("capability_denied", "remote usage resource requires host-owned issuance");
    const startedAt = Date.now();
    const credentialBindings = options.credentialBindings?.map(({ ref, resolve }) => ({ ref, resolve }));
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
    const hostRunner = method.startsWith("hostRunner.");
    const executorAvailable = method === "executor.available";
    if((hostRunner || executorAvailable) && requested === 0) throw new CoreError("invalid_input", "staged plugin calls require a finite deadline");
    const duration = method === "usage.read" || boundedObservation || hostRunner || executorAvailable ? requested === 0 ? def.deadlineMs : Math.min(requested, def.deadlineMs) : requested;
    if ((options.resources || credentialBindings !== undefined || (classifier && method === "classifier.ask")) && duration === 0) throw new CoreError("invalid_input", "scoped capabilities require a finite deadline");
    const deadlineAt = duration === 0 ? Infinity : startedAt + duration;
    const parsed = method === "usage.read" || hostRunner || executorAvailable || (classifier && method === "classifier.ask") ? def.params.safeParse(params) : null;
    if (parsed && !parsed.success) throw new CoreError("invalid_input", hostRunner ? "invalid host runner params" : executorAvailable ? "invalid executor availability params" : method === "usage.read" ? "invalid usage reader params" : "invalid classifier params");
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
        if(e.plannerRetirement)await e.plannerRetirement;
        if(e.plannerGenerationFailure)throw e.plannerGenerationFailure;
        if(plannerFingerprint!==e.plannerFingerprint)throw new CoreError("plugin_unavailable","planner configuration generation changed before admission");
        if (signal.aborted || Date.now() >= deadlineAt) throw new CoreError("plugin_timeout", "plugin call expired before execution");
        const proc = options.expectedProcess ? (() => {
          if (e.process !== options.expectedProcess || !options.expectedProcess.alive)
            throw new CoreError("capability_denied", "bound host provider process retired");
          return options.expectedProcess;
        })() : generation ? await this.startGeneration(ctx, e, generation, deadlineAt, signal) : observationFingerprint!==undefined?await this.generationTask(e,async()=>{
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
        if (options.expectedProcess && (e.process !== proc || !proc.alive))
          throw new CoreError("capability_denied", "bound host provider process retired before request");
        if(options.plannerResources&&(method==="planner.install"||method==="planner.uninstall")&&!proc.supports("plannerInstallTransactions"))throw new CoreError("capability_denied","planner effects require negotiated transactions");
        const observationAdmission=["diagnostic.ping","policy.before"].includes(method)&&manifest.capabilities.some(c=>c.name==="tasks.read"||c.name==="events.subscribe");
        const needsAuthority = observationAdmission || method === "usage.read" || options.plannerResources !== undefined || resources !== undefined || credentialBindings !== undefined || manifest.capabilities.some(capability => capability.name === "hosts");
        const grants = e.bundled ? manifest.capabilities.map(capability => capability.name) : pluginsConfig(ctx).installed[id]?.capabilities ?? [];
        const authority = needsAuthority ? createCallAuthority(ctx, resources ?? { reads: [], commands: [], stores: [] },
          { deadlineMs: deadlineAt, signal, grants, accountHome: options.accountHome }) : undefined;
        if (authority) {
          e.authorities.set(authority.token, authority);
          if (observationAdmission) this.observationAdmissions.add(authority);
          if (manifest.capabilities.some(capability => capability.name === "hosts"))
            this.hostCallGenerations.set(authority, this.hostGeneration(ctx, e));
          const hostFetch = options[HOST_CALL_FETCH_ISSUER];
          if (hostFetch) this.hostCallerFetch.set(authority, hostFetch);
          const hostIdentity = options[HOST_CALL_IDENTITY_ISSUER];
          if (hostIdentity) this.hostCallerIdentity.set(authority, hostIdentity);
          const hostQuestion = options[HOST_CALL_QUESTION_ISSUER];
          if (hostQuestion) this.hostCallerQuestion.set(authority, hostQuestion);
          const hostUsage = options[HOST_CALL_USAGE_ISSUER];
          if (hostUsage) this.hostCallerUsage.set(authority, hostUsage);
        }
        try {
          if (authority) {
            options.plannerResources?.bind(authority,method);
            if (credentialBindings !== undefined) prepareCredentialBindings(authority, credentialBindings);
            await prepareFilesystemAuthority(authority);
            if (authority.resources.writes?.length) await prepareWriteAuthority(authority);
            await prepareStateAuthority(authority);
            prepareSpawnAuthority(authority);
            prepareBundleStageAuthority(authority);
            prepareHttpAuthority(authority, {
              declaredScopes: endpointHttpScopes(this.canonicalEndpoint(e), method, manifest.capabilities.find(capability => capability.name === "net.http")?.scopes ?? [], authority.resources),
              explicitWildcardGrant: !e.bundled && grants.includes("net.http"),
            });
            authority.assertActive();
          }
          const result = await proc.request<T>(method, input, deadlineAt === Infinity ? 0 : Math.max(1, deadlineAt - Date.now()),
            { ...(options.plannerResources && (method==="planner.install"||method==="planner.uninstall"||method==="planner.plan") ? {prepareInput:(fits:(value:unknown)=>boolean)=>options.plannerResources!.prepareInput(input,fits)} : {}), signal: authority?.signal ?? signal, authority, metadata: authority ? { capabilityCall: authority.token } : undefined, onProgress: options.onProgress });
          if (method === "hostRunner.fetch") {
            const admission = options[HOST_FETCH_ISSUER]!;
            const staged = stagedFetchResult.safeParse(result);
            if (!staged.success || staged.data.bytes > (input as { maxBytes: number }).maxBytes)
              throw new CoreError("plugin_refused", "host provider returned an invalid staged bundle handle");
            if (!authority) throw new CoreError("capability_denied", "host fetch has no owning authority");
            authority.assertActive();
            validatePersistedFetch(ctx, admission.grant);
            if (e.process !== admission.process || !admission.process.alive ||
              this.hostGeneration(ctx, e) !== admission.generation)
              throw new CoreError("capability_denied", "host fetch provider generation retired");
            await admission.claim(authority, staged.data);
            authority.assertActive();
            validatePersistedFetch(ctx, admission.grant);
            if (e.process !== admission.process || !admission.process.alive ||
              this.hostGeneration(ctx, e) !== admission.generation)
              throw new CoreError("capability_denied", "host fetch provider generation retired during claim");
            return undefined as T;
          }
          if (method === "usage.read" || hostRunner || executorAvailable) {
            const output = def.result.safeParse(result);
            if (!output.success) throw new CoreError("plugin_refused", hostRunner ? "host runner returned an invalid result" : executorAvailable ? "executor returned an invalid availability result" : "usage reader returned an invalid reading");
            if(hostRunner && (method === "hostRunner.stream" || method === "hostRunner.fetch") &&
              (output.data as {bytes:number}).bytes > (input as {maxBytes:number}).maxBytes)
              throw new CoreError("plugin_refused", "host runner exceeded the requested byte limit");
            if(method === "hostRunner.run" &&
              Buffer.byteLength((output.data as {stdout:string;stderr:string}).stdout) + Buffer.byteLength((output.data as {stdout:string;stderr:string}).stderr) > (input as {maxBytes:number}).maxBytes)
              throw new CoreError("plugin_refused", "host runner exceeded the requested byte limit");
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
    await Promise.all([...this.retiredProcesses]);
    await this.published;
  }
}
