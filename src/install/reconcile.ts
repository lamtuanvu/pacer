import type { Ctx } from "../types";
import { installClaude } from "./claude";
import { installCodex } from "./codex";
import { installCursor } from "./cursor";
import { installOpencodeFiles } from "./opencode";
import { managedContent } from "./managed-content";
import { readManifest, type PlannerRecord } from "./manifest";
import { planInstall, type Txn } from "./txn";
import { sha256, shellCommand } from "./fsx";
import { getMember } from "./jsonc";
import { withInstallLock } from "./lock";
import { recoverInstall } from "./journal";
import { recordedAgent, resolveRecordedTarget } from "./reconcile-target";

export interface IntegrationResult { target: string; state: "current" | "refreshed" | "conflict" | "failed"; detail?: string; hint?: string }
const adapters = { "claude-code": installClaude, codex: installCodex, cursor: installCursor, opencode: installOpencodeFiles };
function errorResult(target: string, error: unknown): IntegrationResult {
  return { target, state: "conflict", detail: error instanceof Error ? error.message : String(error), hint: `Preserve your customizations, then reconnect the intended integration with pacer install ${target}` };
}
async function plan(ctx: Ctx, key: string, prior: PlannerRecord): Promise<{ tx: Txn; result: IntegrationResult }> {
  const agent = recordedAgent(key)!;
  const env = resolveRecordedTarget(ctx, key, prior);
  const tx = await planInstall(env, key, adapters[agent]);
  for (const [path, file] of tx.pending) {
    const old = prior.files.find(item => item.path === path);
    if (file.before === null) continue;
    if (!old && file.before === file.after) continue;
    if (!old) throw Error(`unrecorded integration file would be replaced: ${path}`);
    const intact = sha256(file.before) === old.afterHash;
    const managed = old.managed && sha256(managedContent(file.before, old.undo)) === old.managed.hash;
    const ownsClaudeStatusLine = key.startsWith("claude-code") && old.undo.some(op => op.kind === "json-key" && op.key === "statusLine");
    const legacyStatusLineIntact = !ownsClaudeStatusLine ||
      getMember(file.before, ["statusLine", "command"]) === `${shellCommand(prior.pacerArgv)} statusline`;
    const legacyUnchanged = !old.managed && old.undo.length > 0 && file.after !== null
      && legacyStatusLineIntact && managedContent(file.before, old.undo) === managedContent(file.after, old.undo);
    if (!intact && !managed && !legacyUnchanged && !(old.undo.length === 0 && file.before === file.after)) throw Error(`managed integration content changed: ${path}`);
  }
  const fingerprint = sha256(JSON.stringify({
    schema: 1, key, folder: env.folder, configEnv: env.configEnv, argv: env.pacerArgv,
    assets: [...tx.pending.values()].filter(file => tx.record.files.some(item => item.path === file.path && item.action !== "moved"))
      .map(file => [file.path, file.after === null ? null : sha256(managedContent(file.after, tx.record.files.find(item => item.path === file.path)!.undo))]).sort(([a], [b]) => String(a).localeCompare(String(b))),
  }));
  const changed = tx.touched.length > 0 || prior.integration?.fingerprint !== fingerprint;
  tx.record.integration = { schema: 1, fingerprint };
  return { tx, result: { target: key, state: changed ? "refreshed" : "current" } };
}
/** Read-only desired-state assessment, separate from historical file integrity. */
export async function integrationFreshness(ctx: Ctx, target: string): Promise<IntegrationResult> {
  try {
    const record = readManifest(ctx).planners[target];
    if (!record || !recordedAgent(target)) return { target, state: "current" };
    return (await plan(ctx, target, record)).result;
  } catch (error) { return errorResult(target, error); }
}
export async function reconcileIntegrations(ctx: Ctx, options: { target?: string } = {}): Promise<IntegrationResult[]> {
  // The common empty-install path does not create state or locks.
  const keys = Object.keys(readManifest(ctx).planners).filter(key => recordedAgent(key) && (!options.target || key === options.target));
  if (!keys.length) return [];
  return withInstallLock(ctx, async () => {
    recoverInstall(ctx);
    const results: IntegrationResult[] = [];
    for (const key of keys) {
      try {
        const records = readManifest(ctx).planners, prior = records[key];
        if (!prior) continue;
        const env = resolveRecordedTarget(ctx, key, prior);
        // Two installations owning the same destination are ambiguous: require an explicit reconnect.
        for (const [otherKey, other] of Object.entries(records)) {
          if (otherKey !== key && recordedAgent(otherKey) && prior.files.some(file => other.files.some(item => item.path === file.path))) throw Error(`integration ownership overlaps ${otherKey}`);
        }
        const { tx, result } = await plan(env.ctx, key, prior);
        if (result.state === "refreshed") tx.commit();
        results.push(result);
      } catch (error) { results.push(errorResult(key, error)); }
    }
    return results;
  });
}
