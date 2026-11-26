import type { ExecutorSettingsState } from "./useExecutorSettings";
import type { ModelDraftsState } from "./useModelDrafts";

export type AgentsSaveResult = { ok: true } | { ok: false; reason: "busy" | "models" | "limits" };

/**
 * One Save for the Agents page draft: the models first (`runner.models.set_many`), then the limits against the
 * revision that write returned (`runner.settings.save`). While Takes work is saving, nothing is sent. When the
 * models save but the limits do not, the limits stay in the draft with their error and no "Saved." notice.
 */
export async function saveAgentsDraft(models: Pick<ModelDraftsState, "dirty" | "save" | "reload" | "clearNotice">, settings: Pick<ExecutorSettingsState, "dirty" | "enabledBusy" | "busy" | "rebase" | "save" | "refresh">): Promise<AgentsSaveResult> {
  if (settings.enabledBusy || settings.busy) return { ok: false, reason: "busy" };
  let revision: string | undefined;
  if (models.dirty) {
    const result = await models.save();
    if (!result.ok) return { ok: false, reason: "models" };
    revision = result.revision;
  }
  if (settings.dirty) {
    if (revision) settings.rebase(revision);
    if (!await settings.save(revision)) { if (revision) models.clearNotice(); return { ok: false, reason: "limits" }; }
    models.reload();
  } else if (revision) void settings.refresh();
  return { ok: true };
}
