import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../fsutil";
import { withLockSync } from "../core/lock";
import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import { deriveItems, sortItems, type RuleInput } from "./rules";
import type { AttentionItem } from "./types";

type Entry = { since: number; dismissedSince?: number; snoozedUntil?: number };
type Store = Record<string, Entry>;
const pathFor = (ctx: Ctx) => join(ctx.pacerHome,"state","attention.json");
function transaction<T>(ctx: Ctx, fn: (store: Store) => T): T {
  return withLockSync(ctx,"attention",()=>{
    const path=pathFor(ctx),store=readJson<Store>(path)??{},before=JSON.stringify(store);
    const result=fn(store);
    if (!ctx.readOnly && before!==JSON.stringify(store)) writeJsonAtomic(path,store);
    return result;
  });
}
export function applyStore(ctx: Ctx, items: AttentionItem[]): AttentionItem[] {
  return transaction(ctx,store=>{
    const ids=new Set(items.map(i=>i.id));
    for (const id of Object.keys(store)) if (!ids.has(id)) delete store[id];
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
