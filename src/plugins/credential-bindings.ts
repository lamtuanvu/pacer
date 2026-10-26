import { CoreError } from "../core/errors";
import { CallAuthority } from "./authority";
import { secretReference } from "./http-protocol";

export interface CredentialBinding {
  ref: string;
  resolve: () => Promise<string | null>;
}
export type BoundCredential = { bound: false } | { bound: true; value: string | null };
interface State {
  callbacks: Map<string, CredentialBinding["resolve"]>;
  pending: Map<string, Promise<string | null>>;
  started: Set<Promise<string | null>>;
  revoked: boolean;
}
const states = new WeakMap<CallAuthority, State>();
const denied = () => new CoreError("capability_denied", "credential reference is not bound to this call");
function active(authority: CallAuthority, state?: State): void {
  if (!(authority instanceof CallAuthority) || state?.revoked) throw denied();
  authority.assertActive();
}
function validRef(ref: unknown): ref is string {
  return secretReference.safeParse(ref).success;
}

/** Host-only issuance context; callbacks and resolved values never enter wire resources. */
export function prepareCredentialBindings(authority: CallAuthority, bindings: readonly CredentialBinding[]): void {
  active(authority);
  if (states.has(authority)) throw denied();
  const callbacks = new Map<string, CredentialBinding["resolve"]>();
  for (const binding of bindings) {
    if (!validRef(binding.ref) || typeof binding.resolve !== "function" || callbacks.has(binding.ref)) {
      throw new CoreError("invalid_input", "invalid credential bindings");
    }
    callbacks.set(binding.ref, binding.resolve);
  }
  const state: State = { callbacks, pending: new Map(), started: new Set(), revoked: false };
  authority.onRevoke(async () => {
    state.revoked = true;
    state.callbacks.clear();
    state.pending.clear();
    // No new lookup can enter after revoked is published. Wait for all admitted
    // callbacks, including those reserved but not yet started in their microtask.
    await Promise.allSettled([...state.started]);
    state.started.clear();
  });
  states.set(authority, state);
}

/** Call only after target/grant admission. This module does not grant access. */
export async function resolveBoundCredential(authority: CallAuthority, ref: string): Promise<BoundCredential> {
  active(authority);
  if (!validRef(ref)) throw new CoreError("invalid_input", "invalid credential reference");
  const state = states.get(authority);
  if (!state) return { bound: false };
  active(authority, state);
  let promise = state.pending.get(ref);
  if (!promise) {
    if (!state.callbacks.has(ref)) throw denied();
    // Reserve before invoking any host callback, even a synchronously reentrant
    // callback. The microtask also lets pre-start revocation stop lookup effects.
    promise = Promise.resolve().then(async () => {
      active(authority, state);
      const resolve = state.callbacks.get(ref);
      if (!resolve) throw denied();
      let value: string | null;
      try {
        value = await resolve();
        if (value !== null && typeof value !== "string") throw new Error();
      } catch {
        active(authority, state);
        throw new CoreError("capability_denied", "bound credential could not be resolved");
      }
      active(authority, state);
      return value;
    });
    state.pending.set(ref, promise);
    state.started.add(promise);
    void promise.then(() => state.started.delete(promise!), () => state.started.delete(promise!));
  }
  const value = await promise;
  active(authority, state);
  return { bound: true, value };
}
