import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { CallAuthority } from "../authority";
import { CoreError } from "../../core/errors";
import { guardStorePath, within } from "./storage";

interface Pin { path: string; canonical: string; device: number; inode: number; targetDevice: number; targetInode: number }
interface IssuedState { home: string; pins: Pin[]; parents: { path: string; canonical: string }[]; stores: Map<string, string> }
const preparing = new WeakMap<CallAuthority, Promise<void>>();
const issued = new WeakMap<CallAuthority, IssuedState>();
function deny(): never { throw new CoreError("capability_denied", "usage state issuance identity is missing or changed"); }
async function pin(path: string): Promise<Pin> {
  const link = await lstat(path), canonical = await realpath(path), target = await stat(canonical);
  if (!target.isDirectory()) deny();
  return { path, canonical, device: link.dev, inode: link.ino, targetDevice: target.dev, targetInode: target.ino };
}
async function closest(path: string): Promise<Pin> {
  try { return await pin(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
    return closest(dirname(path));
  }
}
/** Issue before plugin dispatch. Repeated calls never repin an existing authority. */
export function prepareStateAuthority(authority: CallAuthority): Promise<void> {
  authority.assertActive();
  const previous = preparing.get(authority); if (previous) return previous;
  const pending = (async () => {
    if (!authority.resources.stores.length) {
      issued.set(authority, { home: "", pins: [], parents: [], stores: new Map() }); return;
    }
    const anchor = await closest(authority.ctx.pacerHome);
    const home = join(anchor.canonical, relative(anchor.path, authority.ctx.pacerHome));
    const pins = new Map<string, Pin>([[anchor.path, anchor]]);
    const parents = new Map<string, string>([[authority.ctx.pacerHome, home]]);
    const stores = new Map<string, string>();
    for (const store of authority.resources.stores) {
      authority.assertActive(); await guardStorePath(authority.ctx.pacerHome, store.path);
      if (!within(authority.ctx.pacerHome, store.path)) deny();
      stores.set(store.path, join(home, relative(authority.ctx.pacerHome, store.path)));
      const parent = dirname(store.path);
      parents.set(parent, join(home, relative(authority.ctx.pacerHome, parent)));
      let path = authority.ctx.pacerHome;
      const parts = relative(authority.ctx.pacerHome, parent).split(sep).filter(Boolean);
      for (let index = -1; index < parts.length; index++) {
        if (index >= 0) path = join(path, parts[index]);
        try {
          const observed = await pin(path);
          if (observed.canonical !== join(home, relative(authority.ctx.pacerHome, path))) deny();
          pins.set(path, observed);
        } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; }
      }
    }
    authority.assertActive();
    const state = { home, pins: [...pins.values()], parents: [...parents].map(([path, canonical]) => ({ path, canonical })), stores };
    await validate(authority, state);
    authority.assertActive(); issued.set(authority, state);
  })();
  preparing.set(authority, pending); return pending;
}
async function validate(authority: CallAuthority, state: IssuedState, active = true) {
  if (active) authority.assertActive();
  try {
    for (const expected of state.pins) {
      const current = await pin(expected.path);
      if (current.canonical !== expected.canonical || current.device !== expected.device || current.inode !== expected.inode
        || current.targetDevice !== expected.targetDevice || current.targetInode !== expected.targetInode) deny();
    }
    for (const parent of state.parents) {
      try { if (await realpath(parent.path) !== parent.canonical) deny(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  } catch (error) { if (active) authority.assertActive(); deny(); }
  if (active) authority.assertActive();
}
export async function validateStateAuthority(authority: CallAuthority) {
  const state = issued.get(authority); if (!state) deny();
  await validate(authority, state);
}
export function issuedStatePath(authority: CallAuthority, path: string) {
  const state = issued.get(authority), canonical = state?.stores.get(path);
  if (!state || !canonical) deny();
  return { home: state.home, path: canonical };
}

/** Cleanup needs the issuance identity even after new admission has expired. */
export async function validateStateCleanup(authority: CallAuthority) {
  const state = issued.get(authority); if (!state) deny();
  await validate(authority, state, false);
}
