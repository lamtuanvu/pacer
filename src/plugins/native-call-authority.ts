/** Core-sealed call-scoped CallResources for flag-on ProcessOwner (P4d-7/8). */
import { randomUUID } from "node:crypto";
import { basename, isAbsolute, resolve } from "node:path";
import { CoreError } from "../core/errors";
import type { CallResources, HostOperationResource } from "./authority";
import { CODEX_LIVE_ARGV } from "./capability-spawn";
import type { Ctx } from "../types";
import type { PluginManifest } from "./protocol";

const GLOB_META = /[*?[{]/;
const HTTP_HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

function denied(message: string): never {
  throw new CoreError("capability_denied", message);
}

function invalid(message: string): never {
  throw new CoreError("invalid_input", message);
}

/** Exact absolute path with no globs, variables, or relative segments. */
export function isExactIssuedPath(scope: string): boolean {
  if (typeof scope !== "string" || !scope || scope.length > 4096 || scope.includes("\0") || scope.includes("$")
    || GLOB_META.test(scope) || !isAbsolute(scope)
    || scope.split(/[\\/]/).some(part => part === "." || part === "..")) return false;
  return true;
}

/** Exact HTTP host label (no wildcards or URLs). */
export function isExactHttpHost(scope: string): boolean {
  return typeof scope === "string" && scope.length > 0 && scope.length <= 253
    && !scope.includes("*") && !scope.includes("/") && HTTP_HOST.test(scope);
}

function absoluteResourcePath(path: string): string {
  if (!isExactIssuedPath(path)) return denied("call resource path is not an exact absolute path");
  return resolve(path);
}

type SealedResources = {
  reads: { path: string; kind: "file" | "codex-logs" }[];
  writes: NonNullable<CallResources["writes"]>;
  commands: CallResources["commands"];
  hosts: HostOperationResource[];
  worktree?: { taskId: string; attempt: number; baseSha: string };
  executorClaim?: {
    taskId: string; attempt: number; providerId: string; executor: string;
    launch: {
      argv: string[]; cwd: string; executable: string;
      env: Record<string, string>; stdin?: string; session?: "interactive";
      umask?: string; keepColor?: string[];
      files?: { name: string; content: string; mode: number }[];
    };
  };
  orcaAttempt?: NonNullable<CallResources["orcaAttempt"]>;
  orcaLive?: NonNullable<CallResources["orcaLive"]>;
  http?: { hosts: string[]; origins?: string[] };
};

function emptyResources(): SealedResources {
  return { reads: [], writes: [], commands: [], hosts: [] };
}

function autoIssueFromManifest(manifest: PluginManifest, grants: readonly string[]): SealedResources {
  const out = emptyResources();
  if (grants.includes("fs.read")) {
    for (const cap of manifest.capabilities) {
      if (cap.name !== "fs.read") continue;
      for (const scope of cap.scopes ?? []) {
        if (!isExactIssuedPath(scope)) continue;
        out.reads.push({ path: resolve(scope), kind: "file" });
      }
    }
  }
  if (grants.includes("net.http")) {
    const hosts: string[] = [];
    for (const cap of manifest.capabilities) {
      if (cap.name !== "net.http") continue;
      for (const scope of cap.scopes ?? []) {
        if (isExactHttpHost(scope)) hosts.push(scope);
      }
    }
    if (hosts.length) out.http = { hosts: [...new Set(hosts)] };
  }
  return out;
}

const OBSERVATION_ADMISSION_METHODS = new Set(["diagnostic.ping", "policy.before"]);
const HOST_SCRIPT = /^[A-Z][A-Z0-9_]{0,31}$/;
const ORCA_PROVIDER = "pacer-exec-orca";
const ORCA_SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sealHostOperation(resource: HostOperationResource): HostOperationResource {
  if (typeof resource.alias !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(resource.alias)) {
    return invalid("host alias");
  }
  if (typeof resource.hostFingerprint !== "string" || !resource.hostFingerprint || resource.hostFingerprint.length > 128) {
    return invalid("host fingerprint");
  }
  if (typeof resource.script !== "string" || !HOST_SCRIPT.test(resource.script)) return invalid("host script");
  if (!Array.isArray(resource.args) || resource.args.some(arg => typeof arg !== "string" || arg.length > 512)) {
    return invalid("host args");
  }
  if (!(resource.timeoutMs > 0 && resource.timeoutMs <= 120_000)) return invalid("host timeoutMs");
  if (!(resource.maxBytes > 0 && resource.maxBytes <= 524_288)) return invalid("host maxBytes");
  return {
    alias: resource.alias,
    hostFingerprint: resource.hostFingerprint,
    script: resource.script,
    args: [...resource.args],
    timeoutMs: resource.timeoutMs,
    maxBytes: resource.maxBytes,
  };
}

/** Same admission `prepareSpawnAuthority` applies to a flag-off Codex live command. */
function sealCodexLive(command: CallResources["commands"][number], accountHome: string | null | undefined): void {
  if (basename(command.argv[0]!) !== CODEX_LIVE_ARGV[0]
    || JSON.stringify(command.argv.slice(1)) !== JSON.stringify(CODEX_LIVE_ARGV.slice(1))
    || !accountHome || !isAbsolute(accountHome) || command.env?.CODEX_HOME !== accountHome
    || command.cwd !== undefined || command.secretEnv !== undefined || command.stdin !== undefined || command.timeoutMs > 15_000)
    denied("Codex live command was not issued for this account");
}

function sealProvided(resources: CallResources, grants: readonly string[], accountHome?: string | null): SealedResources {
  const out = emptyResources();
  if (resources.reads.length && !grants.includes("fs.read")) return denied("fs.read is not granted");
  if ((resources.commands?.length ?? 0) > 0 && !grants.includes("process.spawn")) {
    return denied("process.spawn is not granted");
  }
  if (resources.http && !grants.includes("net.http")) return denied("net.http is not granted");
  if (resources.writes?.length) return denied("call_authority does not issue write resources in this slice");
  if ((resources.hosts?.length ?? 0) > 0 && !grants.includes("hosts")) return denied("hosts is not granted");
  for (const read of resources.reads) {
    if (read.kind !== "file" && read.kind !== "codex-logs") return invalid("unsupported read resource kind");
    out.reads.push({ path: absoluteResourcePath(read.path), kind: read.kind });
  }
  for (const command of resources.commands ?? []) {
    if (!Array.isArray(command.argv) || command.argv.length === 0) return invalid("command argv required");
    if (!isExactIssuedPath(command.argv[0]!)) return denied("process command argv[0] must be an exact absolute path");
    if (!(command.timeoutMs > 0 && command.timeoutMs <= 600_000)) return invalid("command timeoutMs out of range");
    if (command.mode !== undefined && command.mode !== "codex-live") return denied(`process mode ${command.mode} is not carried by the native call authority`);
    if (command.mode === "codex-live") sealCodexLive(command, accountHome);
    out.commands.push({
      argv: [...command.argv],
      timeoutMs: command.timeoutMs,
      ...(command.mode ? { mode: command.mode } : {}),
      ...(command.cwd ? { cwd: absoluteResourcePath(command.cwd) } : {}),
      ...(command.env ? { env: { ...command.env } } : {}),
      ...(command.stdin !== undefined ? { stdin: command.stdin } : {}),
      ...(command.suppressOutput ? { suppressOutput: true } : {}),
    });
  }
  if (resources.http) {
    const hosts = [...new Set(resources.http.hosts.filter(isExactHttpHost))];
    if (!hosts.length) return invalid("http hosts required");
    out.http = {
      hosts,
      ...(resources.http.origins?.length ? { origins: [...resources.http.origins] } : {}),
    };
  }
  for (const host of resources.hosts ?? []) {
    out.hosts.push(sealHostOperation(host));
  }
  if (resources.worktree) {
    if (!grants.includes("worktree")) return denied("worktree is not granted");
    const row = resources.worktree;
    if (typeof row.taskId !== "string" || !row.taskId || row.taskId.length > 128) return invalid("worktree taskId");
    if (!(row.attempt > 0 && row.attempt <= 1_000_000)) return invalid("worktree attempt");
    if (typeof row.baseSha !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(row.baseSha)) {
      return invalid("worktree baseSha");
    }
    out.worktree = { taskId: row.taskId, attempt: row.attempt, baseSha: row.baseSha };
  }
  if (resources.executorClaim) {
    if (!grants.includes("process.spawn")) return denied("process.spawn is not granted");
    const row = resources.executorClaim;
    if (typeof row.taskId !== "string" || !row.taskId || row.taskId.length > 128) return invalid("executorClaim taskId");
    if (!(row.attempt > 0 && row.attempt <= 1_000_000)) return invalid("executorClaim attempt");
    if (typeof row.providerId !== "string" || !row.providerId || row.providerId.length > 128) {
      return invalid("executorClaim providerId");
    }
    if (typeof row.executor !== "string" || !row.executor || row.executor.length > 128) {
      return invalid("executorClaim executor");
    }
    const launch = row.launch;
    if (!Array.isArray(launch.argv) || launch.argv.length === 0 || launch.argv.length > 32) {
      return invalid("executorClaim launch argv");
    }
    for (const arg of launch.argv) {
      if (typeof arg !== "string" || !arg || arg.includes("\0") || arg.length > 4096) return invalid("executorClaim argv");
    }
    if (!isExactIssuedPath(launch.executable)) return invalid("executorClaim executable");
    if (!isExactIssuedPath(launch.cwd)) return invalid("executorClaim cwd");
    if (!launch.env || typeof launch.env !== "object") return invalid("executorClaim env");
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(launch.env)) {
      if (typeof value !== "string" || key.includes("\0") || value.includes("\0")) return invalid("executorClaim env");
      env[key] = value;
    }
    if (launch.stdin !== undefined && (typeof launch.stdin !== "string" || launch.stdin.length > 262144)) {
      return invalid("executorClaim stdin");
    }
    if (launch.session !== undefined && launch.session !== "interactive") return invalid("executorClaim session");
    out.executorClaim = {
      taskId: row.taskId,
      attempt: row.attempt,
      providerId: row.providerId,
      executor: row.executor,
      launch: {
        argv: [...launch.argv],
        cwd: resolve(launch.cwd),
        executable: resolve(launch.executable),
        env,
        ...(launch.stdin === undefined ? {} : { stdin: launch.stdin }),
        ...(launch.session === undefined ? {} : { session: launch.session }),
        ...(launch.umask === undefined ? {} : { umask: launch.umask }),
        ...(launch.keepColor === undefined ? {} : { keepColor: [...launch.keepColor] }),
        ...(launch.files === undefined ? {} : {
          files: launch.files.map(file => {
            if (typeof file.name !== "string" || !file.name || file.name.length > 128) return invalid("executorClaim file name");
            if (typeof file.content !== "string" || file.content.length > 262144) return invalid("executorClaim file content");
            if (!(file.mode > 0 && file.mode <= 0o777)) return invalid("executorClaim file mode");
            return { name: file.name, content: file.content, mode: file.mode };
          }),
        }),
      },
    };
  }
  if (resources.orcaAttempt) {
    if (!grants.includes("orca")) return denied("orca is not granted");
    const row = resources.orcaAttempt;
    if (row.providerId !== ORCA_PROVIDER) return denied("orcaAttempt provider identity");
    if (typeof row.taskId !== "string" || !row.taskId || row.taskId.length > 128) return invalid("orca taskId");
    if (!(row.attempt > 0 && row.attempt <= 1_000_000)) return invalid("orca attempt");
    if (typeof row.executor !== "string" || !row.executor || row.executor.length > 128) return invalid("orca executor");
    if (typeof row.session !== "string" || !ORCA_SESSION.test(row.session)) return invalid("orca session");
    out.orcaAttempt = {
      taskId: row.taskId,
      attempt: row.attempt,
      providerId: ORCA_PROVIDER,
      executor: row.executor,
      session: row.session,
    };
  }
  if (resources.orcaLive) {
    if (!grants.includes("orca")) return denied("orca is not granted");
    const row = resources.orcaLive;
    if (row.providerId !== ORCA_PROVIDER) return denied("orcaLive provider identity");
    if (typeof row.taskId !== "string" || !row.taskId || row.taskId.length > 128) return invalid("orca taskId");
    if (!(row.attempt > 0 && row.attempt <= 1_000_000)) return invalid("orca attempt");
    if (typeof row.worker !== "string" || !row.worker || row.worker.length > 256) return invalid("orca worker");
    if (typeof row.terminal !== "string" || !row.terminal || row.terminal.length > 256) return invalid("orca terminal");
    if (row.action !== "stop" && row.action !== "inspect") return invalid("orca live action");
    if (row.incarnation !== undefined && (typeof row.incarnation !== "string" || row.incarnation.length > 256)) {
      return invalid("orca incarnation");
    }
    if (row.why !== undefined && (typeof row.why !== "string" || row.why.length > 4096)) return invalid("orca why");
    out.orcaLive = {
      taskId: row.taskId,
      attempt: row.attempt,
      providerId: ORCA_PROVIDER,
      worker: row.worker,
      terminal: row.terminal,
      action: row.action,
      ...(row.incarnation ? { incarnation: row.incarnation } : {}),
      ...(row.why ? { why: row.why } : {}),
    };
  }
  return out;
}

export type ObservationSeal = {
  callToken: string;
  bootstrap: boolean;
  readContext: { home: string; pacerHome: string; now: number };
};

export type HostSnapshotSeal = {
  alias: string;
  hostFingerprint: string;
  callerGeneration: string;
  providerGeneration: string;
  providerProcess: number;
  providerId: string;
};

export type OrcaContextSeal = {
  home: string;
  statusExecutable?: string;
  env?: Record<string, string>;
};

export type WorktreeContextSeal = {
  home: string;
  providerId: string;
  git: string;
  base: string;
  env: Record<string, string>;
};

export type CallAuthoritySeal = {
  resources: SealedResources;
  grants: string[];
  ttlMs: number;
  /** P4d-8: policy/doctor observation bootstrap for tasks.read / events.subscribe. */
  observation?: ObservationSeal;
  /** P4d-9: provider snapshots for flag-on ProcessOwner host attach. */
  hostSnapshots?: HostSnapshotSeal[];
  /** P4d-10: home + optional Orca status pin for ProcessOwner attach. */
  orcaContext?: OrcaContextSeal;
  /** P4d-10: bridge token when Core holds the live attempt session for this call. */
  orcaBridgeToken?: string;
  /** P4d-11: home + git pin for ProcessOwner worktree attach. */
  worktreeContext?: WorktreeContextSeal;
  /** P4d-12: home pin for ProcessOwner executor run attach. */
  executorContext?: { home: string };
};

function observationAdmission(
  method: string | undefined,
  grants: readonly string[],
  manifest: PluginManifest,
): boolean {
  if (!method || !OBSERVATION_ADMISSION_METHODS.has(method)) return false;
  const declared = manifest.capabilities.some(c => c.name === "tasks.read" || c.name === "events.subscribe");
  const granted = grants.some(g => g === "tasks.read" || g === "events.subscribe");
  return declared && granted;
}

/** Seal call-scoped resources Core hands to Rust ProcessOwner for one plugin call. */
export function sealCallAuthority(
  ctx: Ctx,
  manifest: PluginManifest,
  grants: readonly string[],
  options: { resources?: CallResources; ttlMs?: number; method?: string; accountHome?: string | null } = {},
): CallAuthoritySeal {
  const ttlMs = options.ttlMs && options.ttlMs > 0 && options.ttlMs <= 600_000
    ? Math.floor(options.ttlMs)
    : 30_000;
  const sealed = options.resources
    ? sealProvided(options.resources, grants, options.accountHome)
    : autoIssueFromManifest(manifest, grants);
  const observation = observationAdmission(options.method, grants, manifest)
    ? {
      callToken: randomUUID(),
      bootstrap: true,
      readContext: { home: ctx.home, pacerHome: ctx.pacerHome, now: ctx.now },
    }
    : undefined;
  return { resources: sealed, grants: [...grants], ttlMs, ...(observation ? { observation } : {}) };
}
