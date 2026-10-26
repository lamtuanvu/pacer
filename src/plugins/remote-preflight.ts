import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import { validatePersistedFetch, type PersistedFetchGrant } from "./fetch-issuer";
import type { HostFetchBinding } from "./host-lease";

export interface RemotePreflightReceipt { readonly head: string; readonly commits: number }
interface Issued { grant: PersistedFetchGrant; binding: HostFetchBinding; head: string; commits: number }
const receipts = new WeakMap<RemotePreflightReceipt, Issued>();
function deny(message: string): never { throw new CoreError("capability_denied", message); }

/** Host-only: validate framed read-only facts from the exact bound provider session. */
export function issueRemotePreflight(ctx: Ctx, grant: PersistedFetchGrant, binding: HostFetchBinding,
  result: unknown): RemotePreflightReceipt {
  validatePersistedFetch(ctx, grant);
  if (binding.resource !== grant.resource || binding.alias !== grant.resource.alias ||
    binding.hostFingerprint !== grant.resource.hostFingerprint || !binding.providerSession ||
    !binding.provider.process || !binding.provider.generation) deny("remote preflight binding changed");
  const output = result as { code?: unknown; stdout?: unknown; stderr?: unknown; timedOut?: unknown } | null;
  const stdout = output?.stdout, stderr = output?.stderr;
  if (!output || output.code !== 0 || output.timedOut !== false || typeof stdout !== "string" ||
    typeof stderr !== "string" || Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 65_536)
    deny("remote preflight failed or exceeded its bound");
  const facts = new Map<string, string>();
  for (const line of stdout.trimEnd().split("\n")) {
    const at = line.indexOf("=");
    if (at < 1 || facts.has(line.slice(0, at))) deny("remote preflight facts are malformed or duplicated");
    facts.set(line.slice(0, at), line.slice(at + 1));
  }
  const head = facts.get("head"), count = facts.get("commits"), base = grant.resource.args[1];
  if (facts.get("ancestor") !== "1" || facts.get("dirty") !== "0" ||
    !head || !new RegExp(`^[a-f0-9]{${base.length}}$`).test(head) ||
    !count || !/^[1-9]\d*$/.test(count) || Number(count) > 500 ||
    !Number.isSafeInteger(Number(count))) deny("remote preflight has no clean descendant head");
  const receipt: RemotePreflightReceipt = Object.freeze({ head, commits: Number(count) });
  receipts.set(receipt, { grant, binding, head, commits: Number(count) });
  return receipt;
}

/** A receipt is usable only for its original grant and selected provider session. */
export function validateRemotePreflight(ctx: Ctx, receipt: RemotePreflightReceipt,
  grant: PersistedFetchGrant, binding: HostFetchBinding): void {
  validatePersistedFetch(ctx, grant);
  const saved = receipts.get(receipt);
  if (!saved || saved.grant !== grant || saved.binding.providerSession !== binding.providerSession ||
    saved.binding.alias !== binding.alias || saved.binding.hostFingerprint !== binding.hostFingerprint ||
    saved.binding.sshTarget !== binding.sshTarget || saved.binding.controlPath !== binding.controlPath ||
    saved.binding.callerProcess !== binding.callerProcess ||
    saved.binding.callerGeneration !== binding.callerGeneration ||
    saved.binding.provider.id !== binding.provider.id ||
    saved.binding.provider.process !== binding.provider.process ||
    saved.binding.provider.generation !== binding.provider.generation ||
    saved.binding.resource !== binding.resource ||
    receipt.head !== saved.head || receipt.commits !== saved.commits) deny("remote preflight receipt is foreign or changed");
}
