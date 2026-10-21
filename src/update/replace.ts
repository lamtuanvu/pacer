import { chmodSync, closeSync, constants, existsSync, lstatSync, copyFileSync, fsyncSync, linkSync, openSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { signStaged } from "./signing";
import { ReleaseError } from "./errors";

/** Runs `<path> --version` and returns its stdout. */
export type SmokeFn = (path: string) => Promise<string>;
export interface ReplaceResult { path: string; backup: string }

export const runVersion: SmokeFn = async (path) => {
  try {
    const p = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return code === 0 ? out : "";
  } catch {
    return "";
  }
};

export function reportsVersion(output: string, version: string): boolean {
  return output.trim().split(/\s+/).includes(version);
}

function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // some filesystems refuse fsync on a directory; the rename is still atomic
  }
}

/**
 * Stage the new binary next to the real target, fsync it, smoke-run it, keep the old one as <target>.bak
 * (hard link, else copy), then rename over the target. A running process keeps its old inode, and
 * macOS never sees a signed binary modified in place.
 */
export async function replaceBinary(target: string, bytes: Uint8Array, version: string, smoke: SmokeFn = runVersion, sign: (path: string) => Promise<unknown> = signStaged): Promise<ReplaceResult> {
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    throw new ReleaseError(`cannot find the running binary at ${target}`);
  }
  const dir = dirname(real);
  const tmp = join(dir, `.${basename(real)}.update-${process.pid}`);
  const backup = `${real}.bak`;
  const backupTmp = `${backup}.update-${process.pid}`;
  try {
    const fd = openSync(tmp, "w", 0o755);
    try {
      let off = 0;
      while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o755);
    await sign(tmp);
    const out = await smoke(tmp);
    if (!reportsVersion(out, version)) {
      throw new ReleaseError(`the downloaded binary did not report version ${version} when run (output: ${out.trim().slice(0, 200) || "none"}); nothing was changed`);
    }
    try {
      linkSync(real, backupTmp);
    } catch {
      copyFileSync(real, backupTmp);
    }
    renameSync(backupTmp, backup);
    renameSync(tmp, real);
    fsyncDir(dir);
    return { path: real, backup };
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* preserve the replacement failure */ }
    try { rmSync(backupTmp, { force: true }); } catch { /* preserve the replacement failure */ }
    if (e instanceof ReleaseError) throw e;
    const code = (e as { code?: unknown }).code;
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
      throw new ReleaseError(`cannot write to ${dir} (${String(code)}). Reinstall pacer into a directory you own (install.sh defaults to ~/.local/bin)`);
    }
    throw new ReleaseError(`could not replace ${real}: ${(e as Error).message}`);
  }
}


export interface ReplacePairOptions {
  target: string;
  bytes: Uint8Array;
  companions: { target: string; bytes: Uint8Array }[];
  version: string;
  smoke?: SmokeFn;
  sign?: (path: string) => Promise<unknown>;
  rename?: (from: string, to: string) => void;
}

/** Stages and validates the entire pair before changing either installed executable. */
export async function replacePair(o: ReplacePairOptions): Promise<ReplaceResult & { companions: ReplaceResult[] }> {
  const front = realpathSync(o.target);
  const rename = o.rename ?? renameSync;
  const entries = [...o.companions, { target: front, bytes: o.bytes }].map(entry => {
    const target = join(realpathSync(dirname(entry.target)), basename(entry.target));
    return {
      target, bytes: entry.bytes, tmp: `${target}.new`, backup: `${target}.bak`,
      backupTmp: `${target}.bak.update-${process.pid}`,
      existed: false, staged: false, backedUp: false, installed: false,
    };
  });
  const paths = new Set<string>();
  for (const entry of entries) {
    if (dirname(entry.target) !== dirname(front) || paths.has(entry.target)) throw new ReleaseError("pair targets must be distinct siblings of the running binary");
    paths.add(entry.target);
    if (existsSync(entry.target)) {
      if (!lstatSync(entry.target).isFile()) throw new ReleaseError(`pair target is not a regular file: ${entry.target}`);
      entry.existed = true;
    }
  }
  try {
    for (const entry of entries) {
      const fd = openSync(entry.tmp, "wx", 0o755);
      entry.staged = true;
      try {
        let offset = 0;
        while (offset < entry.bytes.length) offset += writeSync(fd, entry.bytes, offset, entry.bytes.length - offset);
        fsyncSync(fd);
      } finally { closeSync(fd); }
    }
    for (const entry of entries) {
      await (o.sign ?? signStaged)(entry.tmp);
    }
    for (const entry of entries) {
      if (!reportsVersion(await (o.smoke ?? runVersion)(entry.tmp), o.version)) throw new ReleaseError(`the downloaded binary ${basename(entry.target)} did not report version ${o.version}; nothing was changed`);
    }
    for (const entry of entries) {
      if (!entry.existed) continue;
      try { linkSync(entry.target, entry.backupTmp); entry.backedUp = true; }
      catch { copyFileSync(entry.target, entry.backupTmp, constants.COPYFILE_EXCL); entry.backedUp = true; }
      rename(entry.backupTmp, entry.backup);
    }
    for (const entry of entries) {
      rename(entry.tmp, entry.target);
      entry.installed = true;
      fsyncDir(dirname(entry.target));
    }
    return { path: front, backup: `${front}.bak`, companions: entries.slice(0, -1).map(e => ({ path: e.target, backup: e.backup })) };
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const entry of entries.slice().reverse()) {
      if (!entry.installed) continue;
      try {
        if (entry.existed) renameSync(entry.backup, entry.target);
        else rmSync(entry.target);
        fsyncDir(dirname(entry.target));
      } catch (rollback) { rollbackErrors.push(`${entry.target}: ${(rollback as Error).message}`); }
    }
    throw new ReleaseError(`could not replace pair: ${(error as Error).message}${rollbackErrors.length ? `; rollback failed: ${rollbackErrors.join("; ")}` : ""}`);
  } finally {
    for (const entry of entries) {
      if (entry.staged) try { rmSync(entry.tmp, { force: true }); } catch { /* preserve transaction error */ }
      if (entry.backedUp) try { rmSync(entry.backupTmp, { force: true }); } catch { /* preserve transaction error */ }
    }
  }
}
