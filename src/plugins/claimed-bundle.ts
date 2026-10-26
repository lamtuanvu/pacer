import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync,
  realpathSync, rmSync, statSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CoreError } from "../core/errors";
import { execProcess } from "../exec/process";
import type { CallAuthority } from "./authority";
import { assertTransferredBundleGrant, relocateTransferredBundle, resolveTransferredBundle,
  type ClaimedBundleTicket } from "./bundle-stage";
import { validatePersistedFetch, type PersistedFetchGrant } from "./fetch-issuer";
import type { RemotePreflightReceipt } from "./remote-preflight";
import { WRITE_OPEN, writeNative } from "./write-native";

const MAX_GIT_OUTPUT = 1024 * 1024;
export interface PreparedBundle { readonly head: string; readonly commits: number }
interface Captured { caller: CallAuthority; ticket: ClaimedBundleTicket; grant: PersistedFetchGrant;
  head: string; commits: number; sha256: string; used: boolean }
const prepared = new WeakMap<PreparedBundle, Captured>();
interface Publication { caller: CallAuthority; grant: PersistedFetchGrant; path: string;
  name: string; directoryFd: number;
  directory: Stats; file: Stats; sha256: string; head: string; commits: number;
  finalized: boolean; consumed: boolean; detach?: () => void }
const published = new WeakMap<ClaimedBundleTicket, Publication>();

function denied(message: string): CoreError { return new CoreError("capability_denied", message); }

/** Capture bounded, verified bytes without ever exposing a writable temporary inode. */
function snapshotBundleInput(stage: Readonly<{ path: string; bytes: number; sha256: string }>,
  issuedSource?: number): Blob {
  let source: number | undefined = issuedSource;
  try {
    source ??= openSync(stage.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash("sha256"), chunk = Buffer.allocUnsafe(65_536), parts: Uint8Array<ArrayBuffer>[] = [];
    let bytes = 0, count: number;
    while ((count = readSync(source, chunk, 0, chunk.length, null)) > 0) {
      bytes += count;
      if (bytes > stage.bytes) throw denied("claimed bundle size changed during inspection");
      hash.update(chunk.subarray(0, count));
      const part = new Uint8Array(count);
      part.set(chunk.subarray(0, count));
      parts.push(part);
    }
    if (bytes !== stage.bytes || hash.digest("hex") !== stage.sha256)
      throw denied("claimed bundle changed during inspection");
    const snapshot = new Blob(parts);
    if (snapshot.size !== stage.bytes) throw denied("claimed bundle snapshot size changed");
    return snapshot;
  } finally {
    if (source !== undefined) closeSync(source);
  }
}

/** Host-only verification in a disposable object database; never mutate the caller's repository. */
export async function prepareClaimedBundle(caller: CallAuthority, ticket: ClaimedBundleTicket,
  grant: PersistedFetchGrant): Promise<PreparedBundle> {
  caller.assertGranted("hosts");
  validatePersistedFetch(caller.ctx, grant);
  assertTransferredBundleGrant(ticket, grant);
  const stage = resolveTransferredBundle(caller, ticket);
  if (stage.bytes < 1 || stage.bytes > grant.resource.maxBytes)
    throw denied("claimed bundle exceeds the issued size");
  const repo = grant.repo, base = grant.resource.args[1], branch = grant.resource.args[2];
  if (!isAbsolute(repo) || !/^[a-f0-9]{40,64}$/.test(base) || !/^pacer\/[A-Za-z0-9._/-]+$/.test(branch))
    throw denied("persisted bundle identity is invalid");
  const executable = caller.ctx.which("git");
  if (!executable || !isAbsolute(executable)) throw new CoreError("plugin_unavailable", "local git is unavailable");
  const canonical = realpathSync(executable), link = lstatSync(executable), binary = statSync(canonical);
  if (!binary.isFile() || !(binary.mode & 0o111)) throw denied("local git executable is unavailable");
  const run = async (args: string[], env: Record<string, string | undefined> = {}, stdinBlob?: Blob) => {
    caller.assertActive(); validatePersistedFetch(caller.ctx, grant);
    const currentLink = lstatSync(executable), currentBinary = statSync(canonical);
    if (realpathSync(executable) !== canonical || currentLink.dev !== link.dev || currentLink.ino !== link.ino ||
      currentBinary.dev !== binary.dev || currentBinary.ino !== binary.ino ||
      currentBinary.mtimeMs !== binary.mtimeMs || currentBinary.size !== binary.size)
      throw denied("local git executable changed during verification");
    const remaining = caller.deadlineMs - Date.now();
    if (remaining <= 0) throw new CoreError("plugin_timeout", "bundle verification expired");
    const result = await execProcess({ argv: [canonical, ...args], cwd: caller.ctx.home,
      env: { PATH: caller.ctx.env.PATH, HOME: caller.ctx.home,
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0", ...env }, timeoutMs: Math.min(10_000, remaining),
      maxStdoutBytes: MAX_GIT_OUTPUT, stdinBlob });
    caller.assertActive(); validatePersistedFetch(caller.ctx, grant);
    if (result.timedOut || result.stdoutOverflow)
      throw new CoreError("plugin_timeout", "bundle verification output or deadline exceeded");
    if (result.code !== 0) throw denied("claimed git bundle failed local verification");
    return result.stdout.trim();
  };
  const runBundle = async (args: string[], env: Record<string, string | undefined> = {}) => {
    caller.assertActive();
    return run(args, env, snapshotBundleInput(stage));
  };
  let inspection: string | undefined;
  try {
    const localEmail = await run(["-C", repo, "config", "user.email"]);
    if (!localEmail || /[\r\n\u0000]/.test(localEmail)) throw denied("local git identity is unavailable");
    if (await run(["-C", repo, "rev-parse", "--verify", `${base}^{commit}`]) !== base)
      throw denied("bundle base does not match the local repository");
    const objectFormat = await run(["-C", repo, "rev-parse", "--show-object-format"]);
    if (objectFormat !== "sha1" && objectFormat !== "sha256") throw denied("unsupported local git object format");
    if (base.length !== (objectFormat === "sha1" ? 40 : 64)) throw denied("bundle base object format differs from repository");
    await runBundle(["-C", repo, "bundle", "verify", "/dev/fd/0"]);
    const listed = await runBundle(["-C", repo, "bundle", "list-heads", "/dev/fd/0"]);
    const match = /^([a-f0-9]{40,64}) refs\/heads\/(pacer\/[A-Za-z0-9._/-]+)$/.exec(listed);
    if (!match || match[2] !== branch) throw denied("claimed bundle head differs from the persisted branch");
    const head = match[1]!;
    const objects = await run(["-C", repo, "rev-parse", "--path-format=absolute", "--git-path", "objects"]);
    if (!isAbsolute(objects)) throw denied("local git object store is unavailable");
    inspection = mkdtempSync(join(caller.ctx.pacerHome, "transfers", ".bundle-inspect-"));
    await run(["init", "--bare", "-q", `--object-format=${objectFormat}`, inspection]);
    const alternate = { GIT_ALTERNATE_OBJECT_DIRECTORIES: resolve(objects) };
    const unbundled = await runBundle(["-C", inspection, "bundle", "unbundle", "/dev/fd/0"], alternate);
    if (unbundled !== `${head} refs/heads/${branch}` ||
      await run(["-C", inspection, "rev-parse", "--verify", `${head}^{commit}`], alternate) !== head)
      throw denied("fetched bundle head changed");
    await run(["-C", inspection, "merge-base", "--is-ancestor", base, head], alternate);
    const countText = await run(["-C", inspection, "rev-list", "--count", `${base}..${head}`], alternate);
    const commits = Number(countText);
    if (!/^\d+$/.test(countText) || !Number.isSafeInteger(commits) || commits < 1 || commits > 500)
      throw denied("claimed bundle commit count is outside 1–500");
    const log = await run(["-C", inspection, "log", "--format=%ae%x00%ce%x00%B%x00%x00",
      `${base}..${head}`], alternate);
    const records = log.split("\u0000\u0000").filter(Boolean);
    if (records.length !== commits) throw denied("claimed bundle commit history is incomplete");
    for (const record of records) {
      const [author, committer, ...body] = record.replace(/^\n+/, "").split("\u0000");
      if (!author || !committer || author !== localEmail || committer !== localEmail)
        throw denied("claimed bundle contains foreign commit identity");
      for (const signoff of body.join("\u0000").matchAll(/^Signed-off-by:.*<([^>]+)>/gim)) {
        if (signoff[1] !== localEmail) throw denied("claimed bundle contains foreign sign-off identity");
      }
    }
    caller.assertActive(); validatePersistedFetch(caller.ctx, grant);
    const receipt: PreparedBundle = Object.freeze({ head, commits });
    prepared.set(receipt, { caller, ticket, grant, head, commits, sha256: stage.sha256, used: false });
    return receipt;
  } catch (error) {
    if (!caller.signal.aborted && Date.now() < caller.deadlineMs) {
      // Preserve a bounded, explicitly untrusted forensic copy; never accept it.
      const quarantined = relocateTransferredBundle(caller, ticket, grant.taskId, true);
      closeSync(quarantined.directoryFd);
    }
    throw error;
  } finally {
    if (inspection) {
      try { rmSync(inspection, { recursive: true, force: true }); }
      catch { throw new CoreError("plugin_unavailable", "temporary bundle inspection cleanup failed; cleanup unverified"); }
    }
  }
}

/** Host-only atomic publication after every trust check has passed. */
export function publishPreparedBundle(caller: CallAuthority, receipt: PreparedBundle):
  { path: string; head: string; commits: number } {
  const saved = prepared.get(receipt);
  if (!saved || saved.caller !== caller || saved.used)
    throw denied("verified bundle receipt is foreign or already used");
  saved.used = true;
  caller.assertGranted("hosts");
  validatePersistedFetch(caller.ctx, saved.grant);
  const placement = relocateTransferredBundle(caller, saved.ticket, saved.grant.taskId, false);
  const record: Publication = { caller, grant: saved.grant, path: placement.path,
    name: placement.name, directoryFd: placement.directoryFd,
    directory: fstatSync(placement.directoryFd), file: placement.file, sha256: saved.sha256,
    head: saved.head, commits: saved.commits, finalized: false, consumed: false };
  published.set(saved.ticket, record);
  try { record.detach = caller.onRevoke(() => rollbackClaimedPublication(caller, saved.ticket)); }
  catch (error) { rollbackClaimedPublication(caller, saved.ticket); throw error; }
  return { path: placement.path, head: saved.head, commits: saved.commits };
}

function checkPublished(record: Publication): void {
  const parent = lstatSync(dirname(record.path)), pinnedParent = fstatSync(record.directoryFd);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.dev !== pinnedParent.dev ||
    parent.ino !== pinnedParent.ino) throw denied("private bundle publication directory changed");
  const now = lstatSync(record.path);
  if (!now.isFile() || now.isSymbolicLink() || now.dev !== record.file.dev ||
    now.ino !== record.file.ino || now.size !== record.file.size || (now.mode & 0o077) !== 0)
    throw denied("private bundle publication changed");
  const fd = writeNative().openAt(record.directoryFd, record.name, WRITE_OPEN);
  try {
    const hash = createHash("sha256"), chunk = Buffer.allocUnsafe(65_536);
    let size = 0, count: number;
    while ((count = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      size += count;
      if (size > record.file.size) throw denied("private bundle size changed");
      hash.update(chunk.subarray(0, count));
    }
    if (size !== record.file.size || hash.digest("hex") !== record.sha256 ||
      fstatSync(fd).ino !== record.file.ino || lstatSync(record.path).ino !== record.file.ino)
      throw denied("private bundle content changed");
  } finally { closeSync(fd); }
}

/** Roll back an unaccepted private publication without deleting a substituted file. */
export function rollbackClaimedPublication(caller: CallAuthority, ticket: ClaimedBundleTicket): void {
  const record = published.get(ticket);
  if (!record) return;
  if (record.caller !== caller) throw denied("foreign private bundle publication");
  if (record.finalized) return;
  let fd: number | undefined;
  try {
    fd = writeNative().openAt(record.directoryFd, record.name, WRITE_OPEN);
    const current = fstatSync(fd);
    if (current.dev !== record.file.dev || current.ino !== record.file.ino)
      throw denied("private bundle rollback identity changed");
    writeNative().unlinkAt(record.directoryFd, record.name, false);
    if (fstatSync(fd).nlink !== 0)
      throw denied("private bundle rollback did not remove the pinned inode");
  } catch {
    throw new CoreError("plugin_unavailable", "private bundle rollback failed; cleanup unverified");
  } finally { if (fd !== undefined) closeSync(fd); }
  closeSync(record.directoryFd);
  record.detach?.();
  published.delete(ticket);
}

/** Commit only after the registry has rechecked task, caller and provider generations. */
export function finalizeClaimedPublication(caller: CallAuthority, ticket: ClaimedBundleTicket,
  preflight?: RemotePreflightReceipt): void {
  const record = published.get(ticket);
  if (!record) return;
  if (record.caller !== caller || record.finalized) throw denied("foreign or replayed private publication");
  caller.assertGranted("hosts");
  validatePersistedFetch(caller.ctx, record.grant);
  if (preflight && (record.head !== preflight.head || record.commits !== preflight.commits))
    throw denied("verified bundle differs from remote preflight");
  checkPublished(record);
  caller.assertActive();
  closeSync(record.directoryFd);
  record.finalized = true;
  record.detach?.();
}

/** Consume an immutable, bounded byte snapshot after the plugin call has retired. */
export async function withFinalizedClaimedBundleInput<T>(caller: CallAuthority,
  ticket: ClaimedBundleTicket, grant: PersistedFetchGrant, consume: (input: Blob) => Promise<T>): Promise<T> {
  const record = published.get(ticket);
  if (!record || !record.finalized || record.consumed || record.caller !== caller || record.grant !== grant)
    throw denied("finalized bundle input is foreign or already consumed");
  record.consumed = true;
  validatePersistedFetch(caller.ctx, grant);
  const parentPath = dirname(record.path);
  let directory: number | undefined, source: number | undefined;
  try {
    const parent = lstatSync(parentPath);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.dev !== record.directory.dev ||
      parent.ino !== record.directory.ino) throw denied("private bundle publication directory changed");
    directory = openSync(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const openedParent = fstatSync(directory);
    if (openedParent.dev !== record.directory.dev || openedParent.ino !== record.directory.ino)
      throw denied("private bundle publication directory changed");
    source = writeNative().openAt(directory, record.name, WRITE_OPEN);
    const file = fstatSync(source);
    if (!file.isFile() || file.dev !== record.file.dev || file.ino !== record.file.ino ||
      file.size !== record.file.size || (file.mode & 0o077) !== 0)
      throw denied("private bundle publication changed");
    const current = lstatSync(record.path);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== file.dev || current.ino !== file.ino)
      throw denied("private bundle publication changed");
    const ownedSource = source;
    source = undefined;
    const snapshot = snapshotBundleInput({ path: record.path, bytes: record.file.size,
      sha256: record.sha256 }, ownedSource);
    const after = lstatSync(record.path);
    const pinnedParent = fstatSync(directory), currentParent = lstatSync(parentPath);
    if (after.dev !== file.dev || after.ino !== file.ino ||
      pinnedParent.dev !== record.directory.dev || pinnedParent.ino !== record.directory.ino ||
      currentParent.dev !== record.directory.dev || currentParent.ino !== record.directory.ino)
      throw denied("private bundle publication changed during consumption");
    closeSync(directory); directory = undefined;
    validatePersistedFetch(caller.ctx, grant);
    return await consume(snapshot);
  } finally {
    if (source !== undefined) closeSync(source);
    if (directory !== undefined) closeSync(directory);
  }
}
