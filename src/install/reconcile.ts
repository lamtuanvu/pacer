import type { Ctx } from "../types";
import { plannerSelectedSources } from "../plugins/planner-selection";
import { readInstallFile } from "./atomic";
import { managedContent } from "./managed-content";
import { readManifest, type PlannerRecord } from "./manifest";
import { sha256, shellCommand } from "./fsx";
import { getMember } from "./jsonc";
import { recordedAgent, resolveRecordedTarget } from "./reconcile-target";
import { pluginRegistry } from "../plugins";
import { withPlannerInstall } from "../plugins/planner-install";

export interface IntegrationResult {
  target: string;
  state: "current" | "refreshed" | "conflict" | "failed";
  detail?: string;
  hint?: string;
}
function errorResult(target: string, error: unknown): IntegrationResult {
  return {
    target,
    state: "conflict",
    detail: error instanceof Error ? error.message : String(error),
    hint: `Preserve your customizations, then reconnect the intended integration with pacer install ${target}`,
  };
}
async function assess(
  ctx: Ctx,
  key: string,
  prior: PlannerRecord,
  prepareOnly: boolean,
): Promise<IntegrationResult> {
  const agent = recordedAgent(key)!,
    env = resolveRecordedTarget(ctx, key, prior);
  const registry = pluginRegistry(ctx),
    id = registry.find(
      ctx,
      "planner",
      (value) => Array.isArray(value.agents) && value.agents.includes(agent),
    );
  if (!id) throw Error(`planner plugin unavailable: ${agent}`);
  let state: IntegrationResult["state"] = "current";
  await withPlannerInstall(env, agent, {
    pluginId: id,
    files: plannerSelectedSources(ctx, agent, env.folder!),
    roots: [env.folder!, ...(env.skillFolder ? [env.skillFolder] : [])],
    binaries: [],
    registry,
    prepareOnly,
    beforeCommit: (plan) => {
      const records = readManifest(ctx).planners;
      const latest = records[key] ?? prior;
      for (const [otherKey, other] of Object.entries(records))
        if (
          otherKey !== key &&
          recordedAgent(otherKey) &&
          latest.files.some((file) =>
            other.files.some((item) => item.path === file.path),
          )
        )
          throw Error(`integration ownership overlaps ${otherKey}`);
      for (const file of plan.files) {
        const old = latest.files.find((item) => item.path === file.path);
        if (file.before === null) continue;
        if (!old && file.before === file.after) continue;
        if (!old)
          throw Error(
            `unrecorded integration file would be replaced: ${file.path}`,
          );
        const intact = sha256(file.before) === old.afterHash;
        const managed =
          old.managed &&
          sha256(managedContent(file.before, old.undo)) === old.managed.hash;
        const ownsClaudeStatusLine = key.startsWith("claude-code") && old.undo.some(op => op.kind === "json-key" && op.key === "statusLine");
        const legacyStatusLineIntact = !ownsClaudeStatusLine ||
          getMember(file.before, ["statusLine", "command"]) === `${shellCommand(latest.pacerArgv)} statusline`;
        const legacyUnchanged = !old.managed && old.undo.length > 0 && file.after !== null
          && legacyStatusLineIntact && managedContent(file.before, old.undo) === managedContent(file.after, old.undo);
        if (
          !intact &&
          !managed &&
          !legacyUnchanged &&
          !(old.undo.length === 0 && file.before === file.after)
        )
          throw Error(`managed integration content changed: ${file.path}`);
      }
      for (const old of latest.files) {
        if (
          old.action === "moved" ||
          !old.undo.length ||
          plan.files.some((file) => file.path === old.path)
        )
          continue;
        const text = readInstallFile(old.path);
        if (text === null) continue;
        if (
          sha256(text) !== old.afterHash &&
          (!old.managed ||
            sha256(managedContent(text, old.undo)) !== old.managed.hash)
        )
          throw Error(`managed integration content changed: ${old.path}`);
      }
      const fingerprint = sha256(
        JSON.stringify({
          schema: 1,
          key,
          folder: env.folder,
          configEnv: env.configEnv,
          argv: env.pacerArgv,
          assets: plan.record.files
            .filter((file) => file.action !== "moved")
            .map((file) => [file.path, file.managed?.hash ?? file.afterHash])
            .sort(([a], [b]) => String(a).localeCompare(String(b))),
        }),
      );
      state =
        plan.touched.length > 0 ||
        latest.integration?.fingerprint !== fingerprint
          ? "refreshed"
          : "current";
      plan.record.integration = { schema: 1, fingerprint };
    },
  });
  return { target: key, state };
}
/** Ordinary planner.plan read authority; no file settlement or command borrow. */
export async function integrationFreshness(
  ctx: Ctx,
  target: string,
): Promise<IntegrationResult> {
  try {
    const record = readManifest(ctx).planners[target];
    if (!record || !recordedAgent(target)) return { target, state: "current" };
    return await assess(ctx, target, record, true);
  } catch (error) {
    return errorResult(target, error);
  }
}
export async function reconcileIntegrations(
  ctx: Ctx,
  options: { target?: string } = {},
): Promise<IntegrationResult[]> {
  const keys = Object.keys(readManifest(ctx).planners).filter(
    (key) => recordedAgent(key) && (!options.target || key === options.target),
  );
  const results: IntegrationResult[] = [];
  for (const key of keys) {
    try {
      const prior = readManifest(ctx).planners[key];
      if (prior) results.push(await assess(ctx, key, prior, false));
    } catch (error) {
      results.push(errorResult(key, error));
    }
  }
  return results;
}
