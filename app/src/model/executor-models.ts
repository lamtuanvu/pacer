import type { ModelRecord, TierTargets } from "../../../src/dispatch/types";
import { selectModel } from "../../../src/dispatch/tier-select";

// Pure helpers for the Models section on the executor detail (Settings › Executors).
import type { AvailableModels } from "../../../src/models/available";

/** "zhipu/glm-4.7" -> "glm-4.7"; also strips the "pacer-<acct>/" prefix of endpoint connections. */
export function displayModel(id: string): string {
  const i = id.indexOf("/");
  return i === -1 ? id : id.slice(i + 1);
}

/** Warning copy when a known listing no longer offers the executor's default model; an unknown
 * listing (models null) or an absent default warns of nothing, because there is nothing verified to report. */
export function modelWarning(list: AvailableModels, model: string | null, provider: string): string | null {
  if (model === null || list.models === null) return null;
  return list.models.some(m => m.id === model) ? null : `${displayModel(model)} is no longer offered by ${list.provider ?? provider}`;
}

import type { AvailableModel } from "../../../src/models/available";
import type { ModelDeclaration, RunnerModels } from "../../../src/core/runner-models";

export function suggestTier(model: AvailableModel): "small" | "medium" | "frontier" | null {
  return model.costOut == null ? null : model.costOut < 1 ? "small" : model.costOut < 5 ? "medium" : "frontier";
}
export const tierLabels = { small: "Small", medium: "Medium", frontier: "Frontier", unknown: "Unrated" };
export type ModelsEdit = { type: "replace"; id: string; with: string } | { type: "add" | "remove" | "default"; id: string } | { type: "tier"; id: string; tier: ModelDeclaration["tier"] };
/** Edit only the local draft, preserving metadata and the revision used for the eventual save. */
export function editModels(draft: RunnerModels, edit: ModelsEdit): RunnerModels {
  const exists = draft.models.some(m => m.id === edit.id);
  if (edit.type === "add") {
    if (exists || !edit.id.trim()) return draft;
    const models: ModelDeclaration[] = [...draft.models];
    // Declaring task options must not silently replace an executor's existing default.
    if (!models.length && draft.default && draft.default !== edit.id) {
      models.push({ id: draft.default, tier: "unknown" });
    }
    models.push({ id: edit.id, tier: "unknown" });
    return { ...draft, default: draft.default || edit.id, models };
  }
  if (!exists) return draft;
  if (edit.type === "replace") {
    const replacement = edit.with.trim();
    if (!replacement || draft.models.some(m => m.id === replacement)) return draft;
    return { ...draft, default: draft.default === edit.id ? replacement : draft.default,
      models: draft.models.map(m => m.id === edit.id ? { ...m, id: replacement } : m) };
  }
  if (edit.type === "default") return { ...draft, default: edit.id };
  if (edit.type === "tier") return { ...draft, models: draft.models.map(m => m.id === edit.id ? { ...m, tier: edit.tier } : m) };
  const models = draft.models.filter(m => m.id !== edit.id);
  return { ...draft, models, default: draft.default === edit.id ? models[0]?.id ?? draft.default : draft.default };
}

export const difficultyLabels = { simple: "Simple", standard: "Standard", complex: "Complex" } as const;
export const difficulties = ["simple", "standard", "complex"] as const;
export function choiceModel(records: ModelRecord[], difficulty: typeof difficulties[number], targets: TierTargets, options: {fixedExecutor?: boolean; defaultModel?: string} = {}): string {
  if (!records.some(record => record.binding.kind === "exact")) return "Always uses the default model";
  const { record } = selectModel(records, { difficulty, targets, ...options });
  return record?.binding.kind === "exact" ? displayModel(record.binding.id) : record ? "Always uses the default model" : "No usable model";
}
export function tierSummary(models: ModelDeclaration[], targets: TierTargets, defaultModel?: string): string {
  if (!models.length) return "Always uses the default model";
  const records: ModelRecord[] = models.map(model => ({ ...model, strengths: model.strengths ?? [], runner: "preview", account: "preview", executor: "preview",
    binding: { kind: "exact", id: model.id }, actualModel: null, provenance: "declared" }));
  return difficulties.map(difficulty => `${difficultyLabels[difficulty]} → ${choiceModel(records, difficulty, targets, {fixedExecutor: true, defaultModel})}`).join(" · ");
}
