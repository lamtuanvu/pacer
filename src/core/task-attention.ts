import { deriveItems, type RuleInput } from "../attention/rules";
import { supersededTaskIds } from "../api/read-model/tasks";

/** Apply service task identity and display titles before exposing attention. */
export function deriveTaskItems(input: RuleInput) {
  const superseded = supersededTaskIds(input.tasks);
  const inactiveRetries = new Set(input.tasks.filter(t => t.dismissed || t.state === "stopped").map(t => t.id));
  // A forward link can arrive before its retry enters the snapshot. Preserve it
  // until the retry is known to be inactive so existing attention is removed.
  const tasks = input.tasks.filter(t => !superseded.has(t.id)).map(t =>
    t.retriedBy && inactiveRetries.has(t.retriedBy) ? {...t, retriedBy: undefined} : t);
  const titles = new Map(tasks.map(t => [t.id, t.title]));
  return deriveItems({...input, tasks}).map(item => item.taskId
    ? {...item, title: titles.get(item.taskId)!}
    : item);
}
