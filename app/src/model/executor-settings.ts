export interface ExecutorSettings {
  revision: string;
  order: string[];
  runners: {id: string; enabled: boolean; maxTasks: number}[];
}
export interface ExecutorDraft {
  order: string[];
  runners: Record<string, {enabled: boolean; maxTasks: string}>;
}
export function createExecutorDraft(saved: ExecutorSettings): ExecutorDraft {
  return {order: [...saved.order], runners: Object.fromEntries(saved.runners.map(r => [r.id, {enabled: r.enabled, maxTasks: String(r.maxTasks)}]))};
}
export function moveExecutor(draft: ExecutorDraft, id: string, by: number): void {
  const from = draft.order.indexOf(id), to = from + by;
  if (from < 0 || to < 0 || to >= draft.order.length) return;
  [draft.order[from], draft.order[to]] = [draft.order[to]!, draft.order[from]!];
}
export function validateExecutorDraft(draft: ExecutorDraft): Record<string, string> {
  return Object.fromEntries(Object.entries(draft.runners).filter(([, r]) => !/^\d+$/.test(r.maxTasks) || Number(r.maxTasks) < 1 || Number(r.maxTasks) > 16).map(([id]) => [id, 'Enter a whole number from 1 to 16.']));
}
export function isExecutorDraftDirty(draft: ExecutorDraft, saved: ExecutorSettings): boolean {
  return JSON.stringify(draft) !== JSON.stringify(createExecutorDraft(saved));
}
export function executorSavePayload(draft: ExecutorDraft, saved: ExecutorSettings) {
  if (Object.keys(validateExecutorDraft(draft)).length) throw new Error('Correct the parallel task limits before saving.');
  return {expectedRevision: saved.revision, order: [...draft.order], runners: draft.order.map(id => ({id, enabled: draft.runners[id].enabled, maxTasks: Number(draft.runners[id].maxTasks)}))};
}
export function matchesExecutorDraft(draft: ExecutorDraft, saved: ExecutorSettings): boolean {
  return JSON.stringify(draft.order) === JSON.stringify(saved.order) && saved.runners.every(r => draft.runners[r.id]?.enabled === r.enabled && Number(draft.runners[r.id]?.maxTasks) === r.maxTasks) && Object.keys(draft.runners).length === saved.runners.length;
}
