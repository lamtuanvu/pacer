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
  return list.models.some(m => m.id === model) ? null : `${displayModel(model)} is no longer offered by ${provider}`;
}
