import { constants, closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Capture before setup gives subprocesses a private TMPDIR.
const parent = tmpdir();
export const OWNER_MARKER = ".pacer-test-owner.json";
const ownRoots = new Set<string>();

/** ps lstart is available on macOS and Linux; a failed probe is never proof of death. */
export function processStart(pid: number): string | null {
  const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart="], {env: {...process.env, LC_ALL: "C", TZ: "UTC"}});
  return result.exitCode === 0 && result.stdout.toString().trim() ? result.stdout.toString().trim() : null;
}

export function createTestRoot(prefix: "pacer-test-" | "pacer-test-home-"): string {
  const root = mkdtempSync(join(parent, prefix));
  ownRoots.add(root);
  writeFileSync(join(root, OWNER_MARKER), JSON.stringify({pid: process.pid, startTime: processStart(process.pid)}), {mode: 0o600});
  return root;
}

export function staleTestRoot(root: string, now = Date.now()): boolean {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || ownRoots.has(root)) return false;
  let fd: number;
  try { fd = openSync(join(root, OWNER_MARKER), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" && now - stat.mtimeMs > 24 * 60 * 60_000;
  }
  try {
    const marker = fstatSync(fd);
    if (!marker.isFile() || marker.size > 4096) return false;
    const owner = JSON.parse(readFileSync(fd, "utf8"));
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
    try { process.kill(owner.pid, 0); }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    const start = processStart(owner.pid);
    return typeof owner.startTime === "string" && start !== null && start !== owner.startTime;
  } catch { return false; }
  finally { closeSync(fd); }
}

/** Only immediate, real directories with our prefixes in the original os.tmpdir(). */
export function sweepTestRoots(): void {
  if (process.env.PACER_KEEP_TEST_TMP) return;
  for (const entry of readdirSync(parent, {withFileTypes: true})) {
    if (!entry.isDirectory() || !/^pacer-test-(?:home-)?[^/]+$/.test(entry.name)) continue;
    const root = join(parent, entry.name);
    try { if (staleTestRoot(root)) rmSync(root, {recursive: true, force: true}); }
    catch { /* A concurrent test run or filesystem error must not fail this run. */ }
  }
}
