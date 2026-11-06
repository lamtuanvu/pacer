/** Core-sealed call-scoped CallResources for flag-on ProcessOwner (P4d-7). */
import { isAbsolute, resolve } from "node:path";
import { CoreError } from "../core/errors";
import type { CallResources } from "./authority";
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
  hosts: NonNullable<CallResources["hosts"]>;
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

function sealProvided(resources: CallResources, grants: readonly string[]): SealedResources {
  const out = emptyResources();
  if (resources.reads.length && !grants.includes("fs.read")) return denied("fs.read is not granted");
  if ((resources.commands?.length ?? 0) > 0 && !grants.includes("process.spawn")) {
    return denied("process.spawn is not granted");
  }
  if (resources.http && !grants.includes("net.http")) return denied("net.http is not granted");
  if (resources.writes?.length) return denied("call_authority does not issue write resources in this slice");
  if (resources.hosts?.length) return denied("call_authority does not issue hosts resources in this slice");
  for (const read of resources.reads) {
    if (read.kind !== "file" && read.kind !== "codex-logs") return invalid("unsupported read resource kind");
    out.reads.push({ path: absoluteResourcePath(read.path), kind: read.kind });
  }
  for (const command of resources.commands ?? []) {
    if (!Array.isArray(command.argv) || command.argv.length === 0) return invalid("command argv required");
    if (!isExactIssuedPath(command.argv[0]!)) return denied("process command argv[0] must be an exact absolute path");
    if (!(command.timeoutMs > 0 && command.timeoutMs <= 600_000)) return invalid("command timeoutMs out of range");
    out.commands.push({
      argv: [...command.argv],
      timeoutMs: command.timeoutMs,
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
  return out;
}

export type CallAuthoritySeal = {
  resources: SealedResources;
  grants: string[];
  ttlMs: number;
};

/** Seal call-scoped resources Core hands to Rust ProcessOwner for one plugin call. */
export function sealCallAuthority(
  _ctx: Ctx,
  manifest: PluginManifest,
  grants: readonly string[],
  options: { resources?: CallResources; ttlMs?: number } = {},
): CallAuthoritySeal {
  const ttlMs = options.ttlMs && options.ttlMs > 0 && options.ttlMs <= 600_000
    ? Math.floor(options.ttlMs)
    : 30_000;
  const sealed = options.resources
    ? sealProvided(options.resources, grants)
    : autoIssueFromManifest(manifest, grants);
  return { resources: sealed, grants: [...grants], ttlMs };
}
