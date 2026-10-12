import { chmodSync, closeSync, copyFileSync, fsyncSync, linkSync, openSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
export async function replaceBinary(target: string, bytes: Uint8Array, version: string, smoke: SmokeFn = runVersion): Promise<ReplaceResult> {
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
