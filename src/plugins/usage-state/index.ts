import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { CoreError } from "../../core/errors";
import type { CallAuthority } from "../authority";
import { readCursorFile } from "./json";
import { CHUNK, readStateFile, guardStorePath, allowedCursorPath, cursorParts, privateDirectory, replaceCursor, reserve, within, writeParts } from "./storage";

type Operation = "begin" | "readChunk" | "stageChunk" | "commit" | "release";
type Store = CallAuthority["resources"]["stores"][number];
interface CursorState { files: Record<string, unknown>; dirty: boolean }
interface Lease {
  id: string; authority: CallAuthority; store: Store; directory: string; bytes: number; staged: number;
  pending: Promise<unknown>; unlock: () => void; detach: () => void; closed: boolean; busy: boolean; closing?: Promise<void>;
}
const leases = new Map<string, Lease>();
const owners = new WeakMap<CallAuthority, Lease>();
const cursorStates = new Map<string, CursorState>();
const queues = new Map<string, Promise<void>>();
function denied(message: string): never { throw new CoreError("capability_denied", message); }
function invalid(message: string): never { throw new CoreError("invalid_input", message); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function validCursor(value: unknown) {
  if (!object(value)) return false;
  const { size, mtime, inode, offset } = value;
  return [size, mtime, inode, offset].every(v => typeof v === "number" && Number.isFinite(v))
    && (size as number) >= 0 && (offset as number) >= 0 && (offset as number) <= (size as number) && Object.hasOwn(value, "aggregate");
}
async function acquire(authority: CallAuthority, path: string): Promise<() => void> {
  const previous = queues.get(path) ?? Promise.resolve();
  let unlock!: () => void;
  const own = new Promise<void>(resolve => { unlock = resolve; });
  const tail = previous.then(() => own); queues.set(path, tail);
  const release = () => { unlock(); void tail.then(() => { if (queues.get(path) === tail) queues.delete(path); }); };
  let detach = () => {};
  try {
    await Promise.race([previous, new Promise<never>((_, reject) => {
      const cancelled = () => reject(new CoreError("capability_denied", "owning state call expired while queued"));
      authority.signal.addEventListener("abort", cancelled, { once: true });
      detach = () => authority.signal.removeEventListener("abort", cancelled);
      if (authority.signal.aborted) cancelled();
    })]);
    authority.assertActive();
    return release;
  } catch (error) { release(); throw error; } finally { detach(); }
}
async function close(lease: Lease) {
  if (lease.closing) return lease.closing;
  lease.closed = true; leases.delete(lease.id); owners.delete(lease.authority); lease.detach();
  lease.closing = (async () => {
    try { if (lease.directory) await rm(lease.directory, { recursive: true, force: true }); }
    finally { lease.unlock(); }
  })();
  return lease.closing;
}

async function loadCursors(lease: Lease): Promise<CursorState> {
  const existing = cursorStates.get(lease.store.path); if (existing) return existing;
  let files: Record<string, unknown> = Object.create(null);
  try {
    const loaded = await readCursorFile(lease.store.path, () => lease.authority.assertActive());
    if (loaded.version === lease.store.version) for (const [path, cursor] of Object.entries(loaded.files)) if (validCursor(cursor)) files[path] = cursor;
  } catch (error) { lease.authority.assertActive(); /* Missing/corrupt compatibility cache is rebuilt. */ }
  const state = { files, dirty: false }; cursorStates.set(lease.store.path, state); return state;
}
async function begin(authority: CallAuthority, params: Record<string, unknown>) {
  if (owners.has(authority)) denied("owning call already has a usage state lease");
  const store = authority.resources.stores.find(store => store.id === params.store);
  if (!store) denied("usage state store is not authorized");
  if (store.kind === "cursors" && (!store.root || store.version !== 4)) denied("cursor store descriptor is incomplete");
  const lease: Lease = { id: randomUUID(), authority, store, directory: "", bytes: 0, staged: 0,
    pending: Promise.resolve(), unlock: () => {}, detach: () => {}, closed: false, busy: false };
  owners.set(authority, lease); leases.set(lease.id, lease);
  try {
    lease.detach = authority.onRevoke(async () => { await lease.pending.catch(() => {}); await close(lease); });
    const initialize = async () => {
      if (store.kind === "cursors") lease.unlock = await acquire(authority, store.path);
      authority.assertActive();
      await guardStorePath(authority.ctx.pacerHome, store.path);
      lease.directory = await privateDirectory(store.path, !!authority.ctx.readOnly);
      authority.assertActive();
      const snapshot = join(lease.directory, "snapshot");
      if (store.kind === "cursors") {
        const state = await loadCursors(lease);
        await writeParts(snapshot, cursorParts(state.files, 4, store.root), () => authority.assertActive());
      } else {
        let value: unknown = null;
        try { value = JSON.parse(await readStateFile(store.path)); } catch { /* Same missing/corrupt cache behavior as readJson. */ }
        await writeParts(snapshot, (async function* () { yield JSON.stringify(value); })(), () => authority.assertActive());
      }
      lease.bytes = (await stat(snapshot)).size;
      return { lease: lease.id, bytes: lease.bytes, ...(store.kind === "cursors" ? { version: 4, dirty: cursorStates.get(store.path)!.dirty } : {}) };
    };
    lease.pending = initialize(); return await lease.pending;
  } catch (error) { await close(lease); throw error; }
}
async function commit(lease: Lease, dirty: boolean) {
  const { authority, store } = lease; const staged = join(lease.directory, "staged");
  if (!lease.staged) invalid("usage state commit has no staged JSON");
  if (store.kind === "cache") {
    let value: unknown;
    try { value = JSON.parse(await readFile(staged, "utf8")); } catch { invalid("invalid provider cache JSON"); }
    if (!object(value) || typeof value.capturedAt !== "number" || !Number.isFinite(value.capturedAt) || !Object.hasOwn(value, "value")) invalid("invalid provider cache shape");
    authority.assertActive();
    if (authority.ctx.readOnly) return { saved: false };
    await guardStorePath(authority.ctx.pacerHome, store.path);
    authority.assertActive();
    // The active check admits this atomic replacement. Revocation waits for settlement.
    await rename(staged, store.path); return { saved: true };
  }
  let projected: Awaited<ReturnType<typeof readCursorFile>>;
  try { projected = await readCursorFile(staged, () => authority.assertActive()); }
  catch (error) { authority.assertActive(); invalid("invalid cursor state JSON"); }
  if (projected.version !== 4) invalid("invalid cursor state version");
  for (const [path, cursor] of Object.entries(projected.files)) {
    authority.assertActive();
    if (!validCursor(cursor)) invalid("invalid cursor entry");
    let allowed = false; try { allowed = await allowedCursorPath(store.root!, path); } catch { /* Refuse vanished/nonregular/escaped paths. */ }
    if (!allowed) denied("cursor state contains unauthorized log path");
  }
  authority.assertActive();
  const state = await loadCursors(lease);
  for (const path of Object.keys(state.files)) if (within(store.root!, path)) delete state.files[path];
  for (const [path, cursor] of Object.entries(projected.files)) state.files[path] = cursor;
  state.dirty ||= dirty;
  if (authority.ctx.readOnly) return { saved: false };
  if (!state.dirty) return { saved: true };
  try {
    await guardStorePath(authority.ctx.pacerHome, store.path);
    await replaceCursor(store.path, state.files, 4, () => authority.assertActive()); state.dirty = false;
    return { saved: true };
  } catch (error) {
    authority.assertActive();
    if (authority.ctx.env.PACER_TRACE_STATUS === "1") console.error("[pacer:status:debug] cursor persistence failed", (error as NodeJS.ErrnoException).code);
    return { saved: false };
  }
}
export async function answerUsageState(authority: CallAuthority, operation: Operation, params: Record<string, unknown>): Promise<unknown> {
  authority.assertGranted("usage.state");
  if (operation === "begin") return begin(authority, params);
  const lease = typeof params.lease === "string" ? leases.get(params.lease) : undefined;
  if (!lease || lease.authority !== authority || lease.closed) denied("unknown usage state lease");
  if (lease.busy) denied("only one usage state operation may be outstanding");
  lease.busy = true;
  const task = lease.pending.then(async () => {
    authority.assertActive();
    if (lease.closed) denied("unknown usage state lease");
    if (operation === "release") { await close(lease); return { ok: true }; }
    if (operation === "commit") {
      try {
        if (params.dirty !== undefined && typeof params.dirty !== "boolean") invalid("invalid cursor dirty marker");
        return await commit(lease, params.dirty === true);
      } finally { await close(lease); }
    }
    const offset = params.offset;
    if (!Number.isSafeInteger(offset) || (offset as number) < 0) invalid("invalid state chunk offset");
    if (operation === "readChunk") {
      const length = params.length;
      if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > CHUNK || (offset as number) + (length as number) > lease.bytes) invalid("invalid state read bounds");
      const file = await open(join(lease.directory, "snapshot"), "r");
      try { const bytes = Buffer.alloc(length as number); const { bytesRead } = await file.read(bytes, 0, bytes.length, offset as number); return { base64: bytes.subarray(0, bytesRead).toString("base64") }; }
      finally { await file.close(); }
    }
    if (operation === "stageChunk") {
      if (typeof params.base64 !== "string" || params.base64.length > Math.ceil(CHUNK / 3) * 4) invalid("invalid state chunk encoding");
      const bytes = Buffer.from(params.base64, "base64");
      if (bytes.length > CHUNK || bytes.toString("base64") !== params.base64 || !bytes.length || offset !== lease.staged) invalid("invalid or noncontiguous state chunk");
      await reserve(lease.directory, bytes.length); authority.assertActive();
      const file = await open(join(lease.directory, "staged"), lease.staged ? "a" : "wx", 0o600);
      try { await file.writeFile(bytes); lease.staged += bytes.length; return { bytes: lease.staged }; } finally { await file.close(); }
    }
    invalid("unknown usage state operation");
  });
  // Invalid RPCs cannot poison a later release or commit on the same lease.
  const settled = task.finally(() => { lease.busy = false; });
  lease.pending = settled.catch(() => {}); return settled;
}
