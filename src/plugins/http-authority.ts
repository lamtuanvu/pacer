/** Host-only HTTP admission; secret values never become capability results. */
import { CallAuthority, type CallResources } from "./authority";
import { CoreError } from "../core/errors";
import { secret } from "../classify/secrets";
import { resolveBoundCredential } from "./credential-bindings";
import type { Ctx } from "../types";

// Matches the reviewed canonical StageA secretReference schema exactly.
const REFERENCE = /^(env|secrets|endpoint):[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
type HttpResources = CallResources & { http?: { hosts: readonly string[]; origins?: readonly string[] } };
interface Prepared {
  scopes: readonly string[];
  hosts: readonly string[];
  /** Exact host-issued origins (scheme, host, port); credentials are injected only for these. */
  origins: readonly string[] | null;
  explicitWildcardGrant: boolean;
}
export interface AuthorizedHttpTarget {
  readonly __hostOnlyTarget?: never;
}
const prepared = new WeakMap<CallAuthority, Prepared>();
const targets = new WeakMap<
  object,
  { authority: CallAuthority; url: string }
>();
function active(authority: CallAuthority, grant?: string): void {
  if (!(authority instanceof CallAuthority))
    throw new CoreError(
      "capability_denied",
      "an active host owning call is required",
    );
  if (grant) authority.assertGranted(grant);
  else authority.assertActive();
}
function hostname(scope: string): string {
  try {
    const url = new URL("http://" + scope);
    if (
      !scope ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw Error("not hostname");
    return url.hostname;
  } catch {
    throw new CoreError(
      "capability_denied",
      "invalid captured HTTP host scope",
    );
  }
}
function origin(value: string): string {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== value)
      throw Error("not origin");
    return url.origin;
  } catch {
    throw new CoreError(
      "capability_denied",
      "invalid captured HTTP origin",
    );
  }
}
function pattern(scope: string): string {
  return scope === "*"
    ? scope
    : scope.startsWith("*.")
      ? "*." + hostname(scope.slice(2))
      : hostname(scope);
}
/** Issuance-only trusted host operation; never call with plugin RPC scope claims. */
export function prepareHttpAuthority(
  authority: CallAuthority,
  options: {
    declaredScopes: readonly string[];
    explicitWildcardGrant: boolean;
  },
): void {
  active(authority);
  if (prepared.has(authority))
    throw new CoreError("conflict", "HTTP owning call already prepared");
  const http = (authority.resources as HttpResources).http;
  const hosts = http?.hosts ?? [];
  prepared.set(
    authority,
    Object.freeze({
      scopes: Object.freeze(options.declaredScopes.map(pattern)),
      hosts: Object.freeze(hosts.map(pattern)),
      origins: http?.origins ? Object.freeze(http.origins.map(origin)) : null,
      explicitWildcardGrant: options.explicitWildcardGrant === true,
    }),
  );
}
function matches(
  host: string,
  scopes: readonly string[],
  explicit: boolean,
): boolean {
  return scopes.some((scope) =>
    scope === "*"
      ? explicit
      : scope.startsWith("*.")
        ? host.endsWith("." + scope.slice(2))
        : host === scope,
  );
}
/** Scope admission only. No DNS, network request, credential lookup or output staging. */
export async function authorizeHttpUrl(
  authority: CallAuthority,
  input: unknown,
): Promise<AuthorizedHttpTarget> {
  active(authority, "net.http");
  let url: URL;
  try {
    if (typeof input !== "string") throw Error("URL required");
    url = new URL(input);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw Error("unsupported URL");
  } catch {
    throw new CoreError(
      "invalid_input",
      "HTTP URL must use HTTP(S) without user information",
    );
  }
  const scope = prepared.get(authority);
  if (
    !scope ||
    !matches(url.hostname, scope.scopes, scope.explicitWildcardGrant) ||
    !matches(url.hostname, scope.hosts, scope.explicitWildcardGrant) ||
    (scope.origins !== null && !scope.origins.includes(url.origin))
  )
    throw new CoreError(
      "capability_denied",
      "HTTP destination is outside the owning call scopes",
    );
  active(authority, "net.http");
  const target = Object.freeze(Object.create(null)) as AuthorizedHttpTarget;
  targets.set(target, { authority, url: url.href });
  return target;
}
/** Host fetch integration may read this immutable admitted URL; target itself reveals nothing. */
export function authorizedHttpUrl(
  authority: CallAuthority,
  target: unknown,
): string {
  active(authority, "net.http");
  const admitted =
    target !== null && typeof target === "object"
      ? targets.get(target)
      : undefined;
  if (!admitted || admitted.authority !== authority)
    throw new CoreError(
      "capability_denied",
      "HTTP target does not belong to the owning call",
    );
  return admitted.url;
}
function parseReference(input: unknown): string {
  if (typeof input !== "string" || !REFERENCE.test(input))
    throw new CoreError("invalid_input", "invalid secret reference");
  return input;
}
/** Only references the host bound to this owning call resolve; nothing falls back to host env or secrets. */
async function resolveReference(
  authority: CallAuthority,
  input: unknown,
): Promise<string | null> {
  const ref = parseReference(input);
  const bound = await resolveBoundCredential(authority, ref);
  if (!bound.bound)
    throw new CoreError(
      "capability_denied",
      "credential reference is not bound to this call",
    );
  return bound.value;
}
/**
 * Host-only lookup for a reference the host itself took from validated configuration.
 * Use it only inside a credential binding; never with a plugin-chosen reference.
 */
export function resolveConfiguredSecret(
  ctx: Ctx,
  input: string,
  aliases?: Readonly<Record<string, string>>,
): string | null {
  const ref = parseReference(input);
  const colon = ref.indexOf(":"),
    kind = ref.slice(0, colon),
    refName = ref.slice(colon + 1);
  const name =
    kind === "secrets" && aliases && Object.hasOwn(aliases, refName)
      ? aliases[refName]!
      : refName;
  // Only own string entries are environment values; inherited Object properties are not secrets.
  const value = Object.hasOwn(ctx.env, name) ? ctx.env[name] : undefined;
  const environment = typeof value === "string" ? value : undefined;
  if (kind === "endpoint") return null; // Endpoint keys are bound by the endpoint adapter.
  if (kind === "env") return environment || null;
  const env: Record<string, string | undefined> = Object.create(null);
  if (environment !== undefined) env[name] = environment;
  try {
    const result = secret({ ...ctx, env }, name);
    return typeof result === "string" && result ? result : null;
  } catch {
    throw new CoreError(
      "capability_denied",
      "secret reference could not be resolved",
    );
  }
}
export async function secretPresence(
  authority: CallAuthority,
  ref: unknown,
): Promise<{ present: boolean }> {
  active(authority, "secrets.resolve");
  const value = await resolveReference(authority, ref);
  active(authority, "secrets.resolve");
  return { present: value !== null };
}
/** Internal injection value only. Scope admission must precede any credential resolution. */
export async function resolveHttpSecret(
  authority: CallAuthority,
  target: unknown,
  ref: unknown,
): Promise<string | null> {
  const url = authorizedHttpUrl(authority, target);
  const origins = prepared.get(authority)?.origins;
  if (!origins || !origins.includes(new URL(url).origin))
    throw new CoreError(
      "capability_denied",
      "credentials are injected only for host-issued HTTP origins",
    );
  const value = await resolveReference(authority, ref);
  active(authority, "net.http");
  return value;
}
