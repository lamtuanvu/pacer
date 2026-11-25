import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../fsutil";
import { withLockSync } from "../core/lock";
import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import { deriveItems, sortItems, type RuleInput } from "./rules";
import type { AttentionItem } from "./types";

type Entry = { since: number; dismissedSince?: number; snoozedUntil?: number };
type Store = Record<string, Entry>;
/** Task items are derived as `${kind}:${taskId}`; a task id may itself contain `:`. */
const taskOwnerOf = (id: string): string | undefined => {
  const colon = id.indexOf(":");
  return colon < 0 ? undefined : id.slice(colon + 1);
};
const pathFor = (ctx: Ctx) => join(ctx.pacerHome,"state","attention.json");
function transaction<T>(ctx: Ctx, fn: (store: Store) => T): T {
  return withLockSync(ctx,"attention",()=>{
    const path=pathFor(ctx),store=readJson<Store>(path)??{},before=JSON.stringify(store);
    const result=fn(store);
    if (!ctx.readOnly && before!==JSON.stringify(store)) writeJsonAtomic(path,store);
    return result;
  });
}
/**
 * Apply a freshly derived item set to the attention store and return the visible items.
 * `prune` is `true` when `items` covers the full task set (a full pass or a genuine
 * reconcile), so every unmatched entry no longer applies and is deleted. For a partial
 * read it is the set of task ids that read covered: an unmatched entry is deleted only
 * when the id after its `kind:` prefix is a covered task id, so a settled item's stale
 * dismissal/snooze cannot survive to hide a follow-up. Every other entry (uncovered tasks
 * and non-task items such as `executor_down:<id>` or `update:<v>`) keeps its
 * since/dismissedSince/snoozedUntil until the next full pass decides authoritatively.
 */
export function applyStore(ctx: Ctx, items: AttentionItem[], prune: true | ReadonlySet<string> = true): AttentionItem[] {
  return transaction(ctx,store=>{
    const ids=new Set(items.map(i=>i.id));
    for (const id of Object.keys(store)) {
      if (ids.has(id)) continue;
      const owner=taskOwnerOf(id);
      if (prune === true || owner === undefined || prune.has(owner)) delete store[id];
    }
    return sortItems(items.flatMap(item=>{
      const entry=store[item.id]??= {since:ctx.now};
      if (entry.dismissedSince===entry.since || (entry.snoozedUntil??0)>ctx.now) return [];
      return [{...item,since:entry.since,...(!item.taskId?{raisedAt:entry.since}:{}),...(entry.snoozedUntil!==undefined?{snoozedUntil:entry.snoozedUntil}:{})}];
    }));
  });
}
export function currentAttention(ctx: Ctx, input: RuleInput): AttentionItem[] { return applyStore(ctx,deriveItems(input)); }
function raised(store: Store, ctx: Ctx, id: string, items: AttentionItem[], allowDismissed = false): Entry {
  if (!items.some(i=>i.id===id) && !(allowDismissed && store[id]?.dismissedSince===store[id]?.since && store[id])) throw new CoreError("unknown_task",`unknown attention item "${id}"`);
  return store[id]??= {since:ctx.now};
}
export function dismissItem(ctx: Ctx, id: string, items: AttentionItem[], onDismiss?: (item: AttentionItem) => void): {dismissed:true} {
  return transaction(ctx,store=>{
    const entry=raised(store,ctx,id,items,true),item=items.find(i=>i.id===id);
    if (entry.dismissedSince!==entry.since && item) onDismiss?.(item);
    entry.dismissedSince=entry.since;
    return {dismissed:true};
  });
}
export function snoozeItem(ctx: Ctx, id: string, duration: "1h" | "4h" | "1d", items: AttentionItem[]): {until:number} {
  return transaction(ctx,store=>{
    const entry=raised(store,ctx,id,items),until=ctx.now+({"1h":3600,"4h":14400,"1d":86400}[duration]);
    entry.snoozedUntil=until;
    return {until};
  });
}
