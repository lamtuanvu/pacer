/** Rail badge helpers kept apart from the Runs store so the shell does not pull the lazy Runs chunk into app.js. */
import type { AttentionItem } from "../../../src/attention/types";

/** Open person-answerable run questions; order is the attention queue's (unblocks → priority → age). */
export function runAttentionQueue(attention: AttentionItem[] | undefined): AttentionItem[] {
  return (attention ?? []).filter(a => a.run && a.kind === "question" && a.question);
}

/** Badge count for the rail: person-answerable run questions. */
export function runsBadgeCount(attention: AttentionItem[] | undefined): number {
  return runAttentionQueue(attention).length;
}
