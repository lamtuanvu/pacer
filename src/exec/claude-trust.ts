import { randomUUID } from "node:crypto";
import { closeSync, fchmodSync, fsyncSync, lstatSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, normalize, resolve } from "node:path";

/**
 * Pre-approves Claude Code's folder-trust dialog (and its external CLAUDE.md import prompt) for a task
 * worktree, the way Orca does. Only the named `projects` entries are touched; the file's other contents
 * are parsed to merge and written back unchanged, never logged, copied or returned.
 */
export type ClaudeTrustResult = {status: "granted" | "unchanged"} | {status: "skipped"; reason: string};

const TRUST = {hasTrustDialogAccepted: true};
// Claude Code 2.1.281 reads this from the canonical repository root's entry, not the worktree's. It is the
// answer "No": the prompt is not shown and external imports stay off. Approving them is left to the user.
const INCLUDES = {hasClaudeMdExternalIncludesWarningShown: true};
// proper-lockfile's retry schedule as Orca configures it: 50, 100, 200, 250 ms.
const LOCK_WAITS = [50, 100, 200, 250];
const queues = new Map<string, Promise<unknown>>();

/** The file Claude Code reads its account state from for this launch environment. */
export function claudeConfigFile(env: Record<string, string | undefined>, home: string): string {
  const dir = env.CLAUDE_CONFIG_DIR || undefined;
  const legacy = join((dir ?? join(home, ".claude")).normalize("NFC"), ".config.json");
  if (existsSync(legacy)) return legacy;
  return join(dir || home, `.claude${env.CLAUDE_CODE_CUSTOM_OAUTH_URL ? "-custom-oauth" : ""}.json`);
}

/** Both the lexical and the real path, NFC-normalized, as Claude may key either. */
export function folderKeys(dir: string): string[] {
  const keys = [resolve(dir)];
  try { keys.push(realpathSync.native(dir)); } catch { /* the lexical key still applies */ }
  return [...new Set(keys.map(key => normalize(key.normalize("NFC"))))];
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function merge(config: Json, trustKeys: string[], includeKeys: string[]): {kind: "refuse"} | {kind: "unchanged"} | {kind: "changed"; config: Json} {
  if (config.projects !== undefined && !isObject(config.projects)) return {kind: "refuse"};
  const projects: Json = {...config.projects};
  const entry = (key: string) => isObject(projects[key]) ? projects[key] as Json : undefined;
  const trusted = trustKeys.some(key => entry(key)?.hasTrustDialogAccepted === true);
  // Any earlier answer to the import prompt, yes or no, is the user's decision and stays.
  const decided = !includeKeys.length || includeKeys.some(key => entry(key)?.hasClaudeMdExternalIncludesApproved === true || entry(key)?.hasClaudeMdExternalIncludesWarningShown === true);
  if (trusted && decided) return {kind: "unchanged"};
  if (!trusted) for (const key of trustKeys) projects[key] = {...entry(key), ...TRUST};
  if (!decided) for (const key of includeKeys) projects[key] = {...entry(key), ...INCLUDES};
  return {kind: "changed", config: {...config, projects}};
}

type Read = {path: string; config: Json} | {reason: string};
function readConfig(file: string): Read {
  let path = file;
  try {
    if (lstatSync(file).isSymbolicLink()) path = realpathSync(file);
    if (!statSync(path).isFile()) return {reason: "the Claude config path is not a file"};
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {reason: code === "ENOENT" || code === "ENOTDIR" ? "the Claude config file does not exist yet" : "the Claude config file is unreadable"};
  }
  try {
    const config: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isObject(config) ? {path, config} : {reason: "the Claude config file is not a JSON object"};
  } catch { return {reason: "the Claude config file is not valid JSON"}; }
}

/** A proper-lockfile-compatible `<file>.lock` directory lock; a held lock is never taken over. */
async function lock(file: string): Promise<(() => void) | null> {
  const path = `${file}.lock`;
  for (let attempt = 0; ; attempt++) {
    try { mkdirSync(path); return () => { try { rmdirSync(path); } catch { /* already released */ } }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= LOCK_WAITS.length) return null;
      await Bun.sleep(LOCK_WAITS[attempt]);
    }
  }
}

/** Temp files left by a crash hold a copy of the account state; remove them on the next grant. */
function sweep(path: string): void {
  const prefix = `${basename(path)}.pacer-trust-`;
  try {
    for (const name of readdirSync(dirname(path))) {
      if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
      const file = join(dirname(path), name);
      try { if (lstatSync(file).isFile() && Date.now() - lstatSync(file).mtimeMs > 60_000) rmSync(file, {force: true}); }
      catch { /* the next entry still gets its turn */ }
    }
  } catch { /* best effort */ }
}

/** Written through the exclusively created descriptor, never reopened by path, and flushed before the rename. */
function writeTemporary(temporary: string, mode: number, text: string): void {
  const fd = openSync(temporary, "wx", mode);
  try { fchmodSync(fd, mode); writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
}

async function update(file: string, trustKeys: string[], includeKeys: string[]): Promise<ClaudeTrustResult> {
  const first = readConfig(file);
  if ("reason" in first) return {status: "skipped", reason: first.reason};
  const planned = merge(first.config, trustKeys, includeKeys);
  if (planned.kind === "refuse") return {status: "skipped", reason: "the Claude config has a malformed projects entry"};
  if (planned.kind === "unchanged") return {status: "unchanged"};
  sweep(first.path);
  const temporary = `${first.path}.pacer-trust-${randomUUID()}.tmp`;
  const release = await lock(file);
  if (!release) return {status: "skipped", reason: "the Claude config file is locked by another process"};
  try {
    // Claude or another launcher may have written since the first read.
    const current = readConfig(file);
    if ("reason" in current) return {status: "skipped", reason: current.reason};
    if (current.path !== first.path) return {status: "skipped", reason: "the Claude config file moved during the update"};
    const next = merge(current.config, trustKeys, includeKeys);
    if (next.kind === "refuse") return {status: "skipped", reason: "the Claude config has a malformed projects entry"};
    if (next.kind === "unchanged") return {status: "unchanged"};
    writeTemporary(temporary, statSync(current.path).mode & 0o777, `${JSON.stringify(next.config, null, 2)}\n`);
    renameSync(temporary, current.path);
    return {status: "granted"};
  } catch {
    return {status: "skipped", reason: "the Claude config file could not be updated"};
  } finally {
    rmSync(temporary, {force: true});
    release();
  }
}

/**
 * Marks `folder` trusted and, when given, records a declined external-import answer for `projectRoot`
 * if the user has not answered for that repository yet. Grants for one file run one at a time.
 */
export function grantClaudeFolderTrust(configFile: string, folder: string, projectRoot?: string): Promise<ClaudeTrustResult> {
  const trustKeys = folderKeys(folder), includeKeys = projectRoot ? folderKeys(projectRoot) : [];
  const run = (queues.get(configFile) ?? Promise.resolve()).then(() => update(configFile, trustKeys, includeKeys));
  const settled = run.then(() => undefined, () => undefined);
  queues.set(configFile, settled);
  void settled.then(() => { if (queues.get(configFile) === settled) queues.delete(configFile); });
  return run;
}
