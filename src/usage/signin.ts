import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { AccountCfg, AccountKind } from "../config/accounts";
import { loginIndicator } from "../install/login";
import { orcaAccountHome } from "../orca/accounts";
import type { Ctx } from "../types";
import { authObservation } from "./auth";
import { accountEvidenceScope } from "../evidence/scope";
import type { EvidenceScope } from "../evidence/types";
import { readEvidence } from "../core/evidence";
import { appliesTo, currentEvidence, evidenceFact } from "../engine/evidence";

/**
 * Local sign-in state of an account on this machine.
 * `signedIn` is null when pacer cannot tell: endpoint accounts (they have keys,
 * not a sign-in), agents without a login indicator, and Orca accounts whose
 * folder is missing.
 */
export interface SignInState {
  signedIn: boolean | null;
  reason?: string;
  fix?: string;
  recoveredAt?: number;
  recoveredScopes?: EvidenceScope[];
}

const AGENT: Partial<Record<AccountKind, string>> = { claude: "claude-code", codex: "codex", cursor: "cursor" };

/** The account's config folder on this machine; undefined means the agent's default folder. */
export function localAccountFolder(ctx: Ctx, account: AccountCfg): string | null | undefined {
  if (account.home) return resolve(account.home.replace(/^~(?=\/|$)/, ctx.home));
  if (account.source === "orca" && (account.kind === "claude" || account.kind === "codex")) return orcaAccountHome(ctx, account.kind, account.orcaAccount ?? "");
  return undefined;
}

const fixText = (fix: string) => fix.startsWith("run ") ? fix : `run ${fix}`;

/**
 * The single source of local native sign-in, shared by `account list`, routing,
 * the read model and runner checks. It combines the login indicator (presence of
 * a login in the agent's config, never the credential itself) with recorded
 * authentication failures. A failure recorded before the agent last rewrote its
 * login file (for example after logging in again) no longer counts.
 */
export function accountSignIn(ctx: Ctx, account: AccountCfg, scope: EvidenceScope = accountEvidenceScope(account)): SignInState {
  const agent = AGENT[account.kind];
  if (!agent) return { signedIn: null };
  const folder = localAccountFolder(ctx, account);
  if (folder === null) return { signedIn: null };
  const login = loginIndicator(ctx, agent, folder);
  if (!login) return { signedIn: null };
  const fix = fixText(login.fix);
  if (!login.loggedIn) return { signedIn: false, reason: `signed out — ${fix}`, fix };
  // A name-only or differently scoped failure cannot describe this account identity.
  const snapshot = readEvidence(ctx, scope), observation = authObservation(ctx, scope);
  const facts = [...snapshot.evidence.facts.availability];
  if (observation) facts.push(evidenceFact(observation.scope, "execution", observation.at,
    observation.at + 7200, "authentication_failed", "unavailable"));
  const failures = facts.filter(f => f.reason === "authentication_failed" && f.value === "unavailable"
    && appliesTo(f, scope) && currentEvidence(f, ctx.now)
    && f.observedAt! > (snapshot.retiredAt ?? -1)
    && !facts.some(recovery => recovery.value === "ready" && currentEvidence(recovery, ctx.now)
      && recovery.observedAt! > f.observedAt!
      && (["account", "identity", "runner", "model", "host"] as const).every(key => recovery.scope[key] === f.scope[key])));
  if (failures.length) {
    const failedAt = Math.max(...failures.map(f => f.observedAt!));
    let changedAt = 0;
    try { changedAt = statSync(login.file).mtimeMs / 1000; } catch { /* The indicator came from the environment. */ }
    if (changedAt <= failedAt || changedAt > ctx.now) return { signedIn: false, reason: `signed out — authentication failed; ${fix}`, fix };
    return { signedIn: true, recoveredAt: changedAt, recoveredScopes: failures.map(f => f.scope) };
  }
  return { signedIn: true };
}
