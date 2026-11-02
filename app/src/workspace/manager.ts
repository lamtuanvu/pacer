export const DRAFT_LIMIT = 64 * 1024;
export function workspaceKey(identity: string, task?: string, section = 'workspace'): string { return JSON.stringify([identity, task ? `task:${task}` : 'section', section]); }
interface Storage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
const prefix = 'pacer:workspace:';
function capped(value: unknown, budget = { bytes: DRAFT_LIMIT }): unknown {
 if (typeof value === 'string') { let end = 0; for (const point of value) { const code = point.codePointAt(0)!, bytes = code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4; if (bytes > budget.bytes) break; budget.bytes -= bytes; end += point.length; } return value.slice(0, end); }
 if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, capped(item, budget)]));
 return value;
}
export function createWorkspaceManager(storage?: Storage) {
 const entries = new Map<string, Record<string, unknown>>(), touched = new Map<string, number>(), loaded = new Set<string>(), absent = new Map<string, number>(), listeners = new Map<string, Set<() => void>>(), dirty = new Set<string>();
 let timer: ReturnType<typeof setTimeout> | undefined;
 const identityOf = (key: string) => JSON.parse(key)[0] as string;
 const persistent = (field: string) => field.startsWith('draft:') || field === 'openSessions';
 const notify = (key: string, field: string) => { for (const listener of listeners.get(JSON.stringify([key, field])) ?? []) listener(); };
 function touch(key: string) { const fields = entries.get(key); if (fields) { entries.delete(key); entries.set(key, fields); touched.set(key, Date.now()); } }
 function bound() { while (entries.size > 200) { const key = entries.keys().next().value!; entries.delete(key); touched.delete(key); absent.delete(key); dirty.add(identityOf(key)); } }
 function load(identity: string) {
  if (loaded.has(identity)) return; loaded.add(identity);
  try { const saved = JSON.parse(storage?.getItem(prefix + identity) ?? '{}'); for (const [key, fields] of Object.entries(saved)) if (identityOf(key) === identity && fields && typeof fields === 'object') { const values = fields as Record<string, unknown>; entries.set(key, Object.fromEntries(Object.entries(values).filter(([field]) => persistent(field)).map(([field, value]) => [field, field.startsWith('draft:') ? capped(value) : value]))); if (typeof values.$absent === 'number') absent.set(key, values.$absent); touched.set(key, typeof values.$touched === 'number' ? values.$touched : Date.now()); } bound(); } catch { /* Storage may be denied or malformed. */ }
 }
 function persist(identity: string) {
  const saved: Record<string, unknown> = {};
  for (const [key, fields] of entries) if (identityOf(key) === identity) { const values = Object.fromEntries(Object.entries(fields).filter(([field, value]) => persistent(field) && value !== '' && value !== undefined)); if (Object.keys(values).length) saved[key] = { ...values, $touched: touched.get(key), ...(absent.has(key) ? { $absent: absent.get(key) } : {}) }; }
  try { if (Object.keys(saved).length) storage?.setItem(prefix + identity, JSON.stringify(saved)); else storage?.removeItem(prefix + identity); } catch { /* Memory state remains usable when storage is full. */ }
 }
 function flush() { clearTimeout(timer); timer = undefined; for (const identity of dirty) persist(identity); dirty.clear(); }
 function schedule(identity: string) { dirty.add(identity); clearTimeout(timer); timer = setTimeout(flush, 200); }
 return {
  flush,
  selectIdentity(origin: string, identity: string) { const key = 'pacer:workspace-service:' + origin; try { const previous = storage?.getItem(key); if (previous && previous !== identity) this.clearIdentity(previous); storage?.setItem(key, identity); } catch { /* Identity remains scoped in memory when storage is denied. */ } },
  get<T>(key: string, field: string, initial: T): T { load(identityOf(key)); touch(key); return (entries.get(key)?.[field] as T | undefined) ?? initial; },
  has(key: string, field: string) { load(identityOf(key)); return entries.get(key)?.[field] !== undefined; },
  set<T>(key: string, field: string, value: T) { const identity = identityOf(key); load(identity); const fields = entries.get(key) ?? {}; const next = field.startsWith('draft:') ? capped(value) : value; if (Object.is(fields[field], next)) return; fields[field] = next; entries.set(key, fields); touch(key); bound(); if (persistent(field) || dirty.size) schedule(identity); notify(key, field); },
  remove(key: string, field: string) { const identity = identityOf(key); load(identity); const fields = entries.get(key); if (fields) delete fields[field]; if (persistent(field)) schedule(identity); notify(key, field); },
  prune(identity: string, tasks: ReadonlySet<string>, now = Date.now()) { load(identity); for (const key of entries.keys()) { const [, task] = JSON.parse(key); if (identityOf(key) !== identity || !task?.startsWith('task:')) continue; if (tasks.has(task.slice(5))) { absent.delete(key); continue; } if (!absent.has(key)) { absent.set(key, now); schedule(identity); } if (now - absent.get(key)! >= 86400000) { entries.delete(key); touched.delete(key); absent.delete(key); schedule(identity); } } },
  clearIdentity(identity: string) { for (const [key, fields] of entries) if (identityOf(key) === identity) { entries.delete(key); touched.delete(key); absent.delete(key); for (const field of Object.keys(fields)) notify(key, field); } dirty.delete(identity); loaded.add(identity); try { storage?.removeItem(prefix + identity); } catch {} },
  subscribe(key: string, field: string, listener: () => void) { const id = JSON.stringify([key, field]), set = listeners.get(id) ?? new Set(); listeners.set(id, set); set.add(listener); return () => { set.delete(listener); if (!set.size) listeners.delete(id); }; },
 };
}
export const workspaceManager = createWorkspaceManager({ getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value), removeItem: key => localStorage.removeItem(key) });

export function reconcileIdentity(manager: Pick<ReturnType<typeof createWorkspaceManager>, 'clearIdentity'>, previous: string, identity: string, ended: boolean) {
 if (previous !== identity) manager.clearIdentity(previous);
 if (ended) manager.clearIdentity(identity);
}
