import { parseJsonc } from "./jsonc";

export type HookFormat = "claude" | "cursor";
export interface HookSpec {
  event: string;
  matcher?: string;
  command: string;
  timeout?: number;
  statusMessage?: string;
}
export interface RemovedHook {
  event: string;
  matcher?: string;
  hook: { command: string; type?: string; timeout?: number; statusMessage?: string; [key: string]: unknown };
}
type HookDoc = Record<string, any>;

function cloneWithHooks(doc: HookDoc, fmt: HookFormat): HookDoc {
  const result = structuredClone(doc);
  if (fmt === "cursor" && result.version === undefined) result.version = 1;
  result.hooks ??= {};
  return result;
}

export function addHooks(doc: HookDoc, fmt: HookFormat, specs: HookSpec[]): HookDoc {
  const result = cloneWithHooks(doc, fmt);
  for (const spec of specs) {
    const entries = result.hooks[spec.event] ??= [];
    const exists = fmt === "cursor"
      ? entries.some((hook: RemovedHook["hook"]) => hook.command === spec.command)
      : entries.some((group: { hooks: RemovedHook["hook"][] }) => Array.isArray(group.hooks) && group.hooks.some((hook) => hook.command === spec.command));
    if (exists) continue;
    const hook: RemovedHook["hook"] = { command: spec.command };
    if (spec.timeout !== undefined) hook.timeout = spec.timeout;
    if (fmt === "cursor") {
      entries.push(hook);
    } else {
      hook.type = "command";
      if (spec.statusMessage !== undefined) hook.statusMessage = spec.statusMessage;
      entries.push({ ...(spec.matcher !== undefined ? { matcher: spec.matcher } : {}), hooks: [hook] });
    }
  }
  return result;
}

export function removeHooks(doc: HookDoc, fmt: HookFormat, match: (command: string) => boolean): { doc: HookDoc; removed: RemovedHook[] } {
  const result = structuredClone(doc);
  const removed: RemovedHook[] = [];
  for (const [event, entries] of Object.entries(result.hooks ?? {}) as [string, any[]][]) {
    const kept = [];
    const removedBefore = removed.length;
    for (const entry of entries) {
      if (fmt === "cursor") {
        if (match(entry.command)) removed.push({ event, hook: entry });
        else kept.push(entry);
      } else {
        if (!Array.isArray(entry.hooks) || entry.hooks.length === 0) {
          kept.push(entry);
          continue;
        }
        entry.hooks = entry.hooks.filter((hook: RemovedHook["hook"]) => {
          if (!match(hook.command)) return true;
          removed.push({ event, ...(entry.matcher !== undefined ? { matcher: entry.matcher } : {}), hook });
          return false;
        });
        if (entry.hooks.length) kept.push(entry);
      }
    }
    if (removed.length > removedBefore && !kept.length) delete result.hooks[event];
    else result.hooks[event] = kept;
  }
  return { doc: result, removed };
}

export function restoreHooks(doc: HookDoc, fmt: HookFormat, removed: RemovedHook[]): HookDoc {
  const result = cloneWithHooks(doc, fmt);
  for (const { event, matcher, hook } of removed) {
    const entries = result.hooks[event] ??= [];
    const restored = structuredClone(hook);
    entries.push(fmt === "cursor" ? restored : {
      ...(matcher !== undefined ? { matcher } : {}), hooks: [restored],
    });
  }
  return result;
}

export function isPacerHook(command: string, planner: string): boolean {
  const escapedPlanner = planner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return /pacer|cli\.(ts|js)/.test(command)
    && new RegExp(`\\s(guard --planner|status --hook|session-start --planner) ${escapedPlanner}$`).test(command);
}

export function editHooksFile(old: string | null, fmt: HookFormat, specs: HookSpec[], planner: string): string {
  const doc = old === null ? {} : parseJsonc(old);
  const cleaned = removeHooks(doc, fmt, (command) => isPacerHook(command, planner)).doc;
  return JSON.stringify(addHooks(cleaned, fmt, specs), null, 2) + "\n";
}
