import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { basename, join } from "node:path";
import { loadStrategy } from "../config/strategy";
import { CoreError } from "../core/errors";
import { controlDir, sshArgv } from "../remote/ssh";
import { SCRIPTS } from "../remote/scripts";
import type { Ctx } from "../types";
import { tasksDir } from "../tasks/store";
import type { BundleStageResource, CallAuthority } from "./authority";
import type { PersistedFetchGrant } from "./fetch-issuer";
import { NativeWriteError, WRITE_DIRECTORY, WRITE_OPEN, writeNative } from "./write-native";

const MAX_BUNDLE = 50 * 1024 * 1024, MAX_STDERR = 65_536;
const deny = (message: string): never => { throw new CoreError("capability_denied", message); };
const same = (left: Stats, right: Stats) => left.dev === right.dev && left.ino === right.ino &&
  left.size === right.size && left.mtimeMs === right.mtimeMs && left.mode === right.mode;
const sameDirectory = (left: Stats, right: Stats) => left.isDirectory() &&
  left.dev === right.dev && left.ino === right.ino && left.uid === right.uid &&
  (left.mode & 0o7777) === (right.mode & 0o7777);

interface Pin { resource: BundleStageResource; selected: string; canonical: string; link: Stats; stat: Stats;
  controlDirectory: string; controlEntry: Stats }
interface Stage { root: string; rootEntry: Stats; dir: string; dirEntry: Stats; path: string; fileEntry: Stats;
  bytes: number; sha256: string; resource: BundleStageResource }
interface State { pins: Pin[]; used: Set<number>; stages: Map<string, Stage>; active?: Promise<unknown>;
  stop?: () => void; cleanupFailure?: CoreError }
const states = new WeakMap<CallAuthority, State>();
export interface ClaimedBundleTicket { readonly id: string }
interface ClaimedStageState { stages: Map<ClaimedBundleTicket, Stage>; used: WeakSet<ClaimedBundleTicket> }
const claimedStages = new WeakMap<CallAuthority, ClaimedStageState>();
const claimedOwners = new WeakMap<ClaimedBundleTicket, CallAuthority>();
const claimedGrants = new WeakMap<ClaimedBundleTicket, PersistedFetchGrant>();

/** Host code issues a command for one configured alias and one trusted run tuple. */
export function issueBundleStageResource(ctx: Ctx, alias: string, args: [string, string, string],
  maxBytes = MAX_BUNDLE, timeoutMs = 60_000): BundleStageResource {
  const host = loadStrategy(ctx).hosts[alias];
  if (!host || host.paused) deny("bundle host alias is unavailable");
  if (args.length !== 3 || !args[0] || args[0].length > 4096 || /[\u0000-\u001f\u007f]/.test(args[0]) ||
    !/^[a-f0-9]{40,64}$/.test(args[1]) || !/^pacer\/[A-Za-z0-9._/-]+$/.test(args[2]) ||
    args[2].includes("..") || args[2].includes("//") ||
    !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BUNDLE ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    deny("invalid host-owned bundle request");
  return { alias, hostFingerprint: JSON.stringify(host), args: [...args],
    argv: sshArgv(ctx, host, SCRIPTS.BUNDLE_OUT, args), timeoutMs, maxBytes };
}

function activeHost(authority: CallAuthority, resource: BundleStageResource): void {
  const host = loadStrategy(authority.ctx).hosts[resource.alias];
  if (!host || host.paused || JSON.stringify(host) !== resource.hostFingerprint ||
    JSON.stringify(sshArgv(authority.ctx, host, SCRIPTS.BUNDLE_OUT, resource.args)) !== JSON.stringify(resource.argv))
    deny("bundle host configuration changed");
}

/** Pin executable identity before any provider code receives this authority. */
export function prepareBundleStageAuthority(authority: CallAuthority): void {
  if (!authority.resources.bundleStages?.length) return;
  authority.assertGranted("process.spawn");
  if (states.has(authority)) return;
  const pins = (authority.resources.bundleStages ?? []).map(resource => {
    activeHost(authority, resource);
    if (resource.maxBytes < 1 || resource.maxBytes > MAX_BUNDLE || resource.timeoutMs < 1 || resource.timeoutMs > 60_000)
      deny("invalid issued bundle limit");
    const selected = authority.ctx.which("ssh");
    if (typeof selected !== "string" || !selected.startsWith("/"))
      throw new CoreError("capability_denied", "issued SSH executable is unavailable");
    const canonical = realpathSync(selected), link = lstatSync(selected), stat = statSync(canonical);
    if (!stat.isFile() || !(stat.mode & 0o111)) deny("issued SSH executable is not executable");
    const controlDirectory = controlDir(authority.ctx), controlEntry = lstatSync(controlDirectory);
    if (!controlEntry.isDirectory() || (controlEntry.mode & 0o077) !== 0 ||
      (process.getuid && controlEntry.uid !== process.getuid())) deny("SSH control directory is not private");
    return { resource, selected, canonical, link, stat, controlDirectory, controlEntry };
  });
  const state: State = { pins, used: new Set(), stages: new Map() };
  states.set(authority, state);
  authority.onRevoke(async () => {
    state.stop?.();
    await state.active?.catch(() => {});
    let cleanupFailure: unknown = state.cleanupFailure;
    for (const [handle, stage] of state.stages) {
      try { rmSync(stage.dir, { recursive: true, force: true }); state.stages.delete(handle); }
      catch (error) { cleanupFailure ??= error; }
    }
    if (cleanupFailure) throw cleanupFailure;
  });
}

function transferRoot(ctx: Ctx): string {
  const parent = lstatSync(ctx.pacerHome);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) !== 0 ||
    (process.getuid && parent.uid !== process.getuid())) deny("bundle home is not private and owned");
  const root = join(ctx.pacerHome, "transfers");
  try { mkdirSync(root, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const directory = lstatSync(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 ||
    (process.getuid && directory.uid !== process.getuid())) deny("bundle transfer directory is not private");
  return root;
}

function validPin(pin: Pin): void {
  try {
    if (realpathSync(pin.selected) !== pin.canonical || !same(lstatSync(pin.selected), pin.link) ||
      !same(statSync(pin.canonical), pin.stat)) deny("issued SSH executable changed");
    const control = lstatSync(pin.controlDirectory);
    if (!control.isDirectory() || control.dev !== pin.controlEntry.dev || control.ino !== pin.controlEntry.ino ||
      control.uid !== pin.controlEntry.uid || (control.mode & 0o7777) !== (pin.controlEntry.mode & 0o7777))
      deny("SSH control directory changed");
  } catch (error) {
    if (error instanceof CoreError) throw error;
    deny("issued SSH executable is unavailable");
  }
}

/** Plugin-facing operation: no destination path, no command expansion, one use. */
export async function stageBundle(authority: CallAuthority,
  request: { argv: readonly string[]; timeoutMs: number; maxBytes: number }): Promise<{ handle: string; bytes: number; sha256: string }> {
  authority.assertGranted("process.spawn");
  const state = states.get(authority) ?? deny("bundle command was not pinned at issuance");
  if (state.cleanupFailure) throw state.cleanupFailure;
  if (state.active) throw new CoreError("conflict", "bundle stage is already running");
  const index = state.pins.findIndex((pin, at) => !state.used.has(at) &&
    JSON.stringify(pin.resource.argv) === JSON.stringify(request.argv) &&
    Number.isSafeInteger(request.timeoutMs) && request.timeoutMs > 0 && request.timeoutMs <= pin.resource.timeoutMs &&
    Number.isSafeInteger(request.maxBytes) && request.maxBytes > 0 && request.maxBytes <= pin.resource.maxBytes);
  if (index < 0) deny("bundle operation is not issued for this call");
  const pin = state.pins[index]!;
  activeHost(authority, pin.resource); validPin(pin);
  state.used.add(index);
  const task = runStage(authority, state, pin, request.timeoutMs, request.maxBytes);
  state.active = task;
  try { return await task; }
  finally { if (state.active === task) state.active = undefined; }
}

async function runStage(authority: CallAuthority, state: State, pin: Pin, timeoutMs: number, maxBytes: number) {
  const root = transferRoot(authority.ctx), dir = mkdtempSync(join(root, ".bundle-stage-"));
  const partial = join(dir, "incoming.partial"), complete = join(dir, "incoming.bundle");
  let fd: number | undefined, child: ChildProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, watch: ReturnType<typeof setInterval> | undefined;
  let pipeTimer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  let published = false, size = 0, stderrSize = 0;
  const hash = createHash("sha256");
  let failure: CoreError | undefined, exited = false, closedPipe = false, terminationSignaled = false;
  let resetPipeTimer: (() => void) | undefined;
  try {
    const stageDir = lstatSync(dir);
    if (!stageDir.isDirectory() || stageDir.isSymbolicLink() || (stageDir.mode & 0o077) !== 0 ||
      (process.getuid && stageDir.uid !== process.getuid())) deny("bundle stage directory is not private");
    fd = openSync(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const file = fstatSync(fd);
    if (!file.isFile() || file.nlink !== 1 || (file.mode & 0o077) !== 0) deny("bundle stage file is not private");
    authority.assertActive(); activeHost(authority, pin.resource); validPin(pin);
    child = spawn(pin.canonical, pin.resource.argv.slice(1), {
      stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
      env: authority.ctx.env,
    });
    const retainedPipes = () => {
      if (closedPipe) return;
      const uncertain = new CoreError("plugin_unavailable", "bundle descendant retained output pipes; cleanup unverified");
      state.cleanupFailure ??= uncertain;
      failure ??= uncertain;
      child?.stdout?.destroy(); child?.stderr?.destroy();
    };
    const stop = () => {
      if (exited || child?.exitCode !== null || !child?.pid) { if (exited) retainedPipes(); return; }
      if (terminationSignaled) return;
      try {
        process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
        terminationSignaled = true;
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH" && !exited && child?.exitCode === null) {
          const uncertain = new CoreError("plugin_unavailable", "bundle termination failed; cleanup unverified");
          state.cleanupFailure ??= uncertain;
          failure ??= uncertain;
        }
      }
    };
    state.stop = stop;
    child.on("exit", () => {
      exited = true;
      resetPipeTimer?.();
    });
    abort = () => { failure ??= new CoreError("capability_denied", "bundle stage owner retired"); stop(); };
    authority.signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => { failure ??= new CoreError("plugin_timeout", "bundle stage timed out"); stop(); },
      Math.max(1, Math.min(timeoutMs, authority.deadlineMs - Date.now())));
    watch = setInterval(() => {
      try { activeHost(authority, pin.resource); validPin(pin); }
      catch { failure ??= new CoreError("capability_denied", "bundle stage host generation changed"); stop(); }
    }, 50);
    watch.unref();
    const stderr = new Promise<void>(resolve => {
      child!.stderr!.on("data", (chunk: Buffer) => {
        resetPipeTimer?.();
        stderrSize += chunk.length;
        if (stderrSize > MAX_STDERR) { failure ??= new CoreError("too_large", "bundle stderr exceeds 64 KiB"); stop(); }
      });
      child!.stderr!.on("end", resolve);
      child!.stderr!.on("close", resolve);
      child!.stderr!.on("error", () => { failure ??= new CoreError("plugin_unavailable", "bundle stderr failed"); stop(); resolve(); });
    });
    const closed = new Promise<number>(resolve => child!.on("close", code => {
      closedPipe = true;
      if (pipeTimer) clearTimeout(pipeTimer);
      resolve(code ?? 1);
    }));
    resetPipeTimer = () => {
      if (!exited || closedPipe) return;
      if (pipeTimer) clearTimeout(pipeTimer);
      // This is an idle bound after the leader exits; normal buffered output can keep draining.
      pipeTimer = setTimeout(retainedPipes, 250);
    };
    child.on("error", () => { failure ??= new CoreError("plugin_unavailable", "bundle SSH child could not start"); });
    let prefix = Buffer.alloc(0), framed = false, lineStart = true;
    const marker = Buffer.from("__PACER_BEGIN__\n");
    const writePayload = (bytes: Buffer) => {
      if (failure || authority.signal.aborted) return;
      size += bytes.length;
      if (size > maxBytes) { failure = new CoreError("too_large", "bundle exceeds issued byte limit"); stop(); return; }
      hash.update(bytes);
      let at = 0;
      while (at < bytes.length) {
        const written = writeSync(fd!, bytes, at, bytes.length - at);
        if (written <= 0) throw new CoreError("plugin_unavailable", "bundle stage write made no progress");
        at += written;
      }
    };
    const stdout = new Promise<void>(resolve => {
      child!.stdout!.on("data", (chunk: Buffer) => {
        resetPipeTimer?.();
        try {
          if (framed) { writePayload(chunk); return; }
          const bytes = Buffer.concat([prefix, chunk]);
          prefix = Buffer.alloc(0);
          for (let i = 0; i < bytes.length; i++) {
            if (lineStart && bytes[i] === marker[0]) {
              const remaining = bytes.subarray(i);
              if (remaining.length < marker.length && marker.subarray(0, remaining.length).equals(marker)) {
                prefix = remaining; break;
              }
              if (remaining.subarray(0, marker.length).equals(marker)) {
                framed = true; writePayload(remaining.subarray(marker.length)); break;
              }
            }
            lineStart = bytes[i] === 10;
          }
        } catch (error) {
          failure ??= error instanceof CoreError ? error : new CoreError("plugin_unavailable", "bundle output could not be staged");
          stop();
        }
      });
      child!.stdout!.on("end", () => { if (!framed) failure ??= new CoreError("plugin_refused", "bundle payload frame missing"); resolve(); });
      child!.stdout!.on("close", resolve);
      child!.stdout!.on("error", () => { failure ??= new CoreError("plugin_unavailable", "bundle stdout failed"); stop(); resolve(); });
    });
    const [code] = await Promise.all([closed, stderr, stdout]);
    if (failure) throw failure;
    authority.assertActive(); activeHost(authority, pin.resource);
    if (code !== 0) throw new CoreError("plugin_refused", "bundle SSH child failed");
    fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(partial, complete);
    const handle = randomUUID(), sha256 = hash.digest("hex");
    state.stages.set(handle, { root, rootEntry: lstatSync(root), dir, dirEntry: lstatSync(dir),
      path: complete, fileEntry: lstatSync(complete), bytes: size, sha256, resource: pin.resource });
    published = true;
    return { handle, bytes: size, sha256 };
  } finally {
    if (timer) clearTimeout(timer);
    if (watch) clearInterval(watch);
    if (pipeTimer) clearTimeout(pipeTimer);
    if (abort) authority.signal.removeEventListener("abort", abort);
    if (fd !== undefined) closeSync(fd);
    if (child && !exited && child.exitCode === null) state.stop?.();
    state.stop = undefined;
    if (!published) rmSync(dir, { recursive: true, force: true });
  }
}

function checkStageIdentity(stage: Stage): void {
  try {
    const root = lstatSync(stage.root), dir = lstatSync(stage.dir), file = lstatSync(stage.path);
    const stableDir = (now: Stats, issued: Stats) => now.isDirectory() && !now.isSymbolicLink() &&
      now.dev === issued.dev && now.ino === issued.ino && now.uid === issued.uid &&
      (now.mode & 0o7777) === (issued.mode & 0o7777);
    if (!stableDir(root, stage.rootEntry) || !stableDir(dir, stage.dirEntry) ||
      !file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || !same(file, stage.fileEntry) ||
      file.uid !== stage.fileEntry.uid || file.size !== stage.bytes)
      deny("bundle stage path changed after capture");
  } catch (error) {
    if (error instanceof CoreError) throw error;
    deny("bundle stage path is unavailable");
  }
}

/** Rehash at both ownership boundaries so a same-size rewrite cannot pass by metadata alone. */
function checkStageBytes(stage: Stage): void {
  checkStageIdentity(stage);
  let fd: number | undefined;
  try {
    fd = openSync(stage.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!same(fstatSync(fd), stage.fileEntry)) deny("bundle stage identity changed");
    const hash = createHash("sha256"), chunk = Buffer.allocUnsafe(65_536);
    let size = 0, count: number;
    while ((count = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      size += count;
      if (size > stage.bytes) deny("bundle stage size changed");
      hash.update(chunk.subarray(0, count));
    }
    if (size !== stage.bytes || hash.digest("hex") !== stage.sha256 ||
      !same(fstatSync(fd), stage.fileEntry)) deny("bundle stage content changed");
    checkStageIdentity(stage);
  } catch (error) {
    if (error instanceof CoreError) throw error;
    deny("bundle stage could not be verified");
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Host-only; a plugin never gets a filesystem path from its opaque handle. */
export function resolveStagedBundle(authority: CallAuthority, handle: string): Readonly<Stage> {
  authority.assertActive();
  const stage = states.get(authority)?.stages.get(handle) ?? deny("bundle handle is not owned by this call");
  checkStageIdentity(stage);
  return stage;
}

/** Host-only: move a staged bundle to one active caller without publishing a filename. */
export function transferStagedBundleOwnership(provider: CallAuthority, handle: string,
  caller: CallAuthority, grant?: PersistedFetchGrant): ClaimedBundleTicket {
  provider.assertGranted("process.spawn");
  caller.assertGranted("hosts");
  if (provider === caller || provider.ctx.pacerHome !== caller.ctx.pacerHome)
    deny("bundle transfer requires a distinct caller in the same host home");
  const source = states.get(provider)?.stages;
  const stage = source?.get(handle) ?? deny("bundle handle is not owned by this provider call");
  if (grant && JSON.stringify(stage.resource) !== JSON.stringify(grant.resource))
    deny("bundle stage does not match the persisted grant");
  checkStageBytes(stage);
  let destination = claimedStages.get(caller);
  if (!destination) {
    destination = { stages: new Map(), used: new WeakSet() };
    const owned = destination;
    caller.onRevoke(() => {
      let failure: unknown;
      for (const [ticket, current] of owned.stages) {
        try { rmSync(current.dir, { recursive: true, force: true }); owned.stages.delete(ticket); }
        catch (error) { failure ??= error; }
      }
      if (failure) throw new CoreError("plugin_unavailable", "transferred bundle cleanup failed; cleanup unverified");
    });
    claimedStages.set(caller, destination);
  }
  provider.assertActive(); caller.assertActive();
  const ticket: ClaimedBundleTicket = Object.freeze({ id: randomUUID() });
  claimedOwners.set(ticket, caller);
  if (grant) claimedGrants.set(ticket, grant);
  destination.stages.set(ticket, stage);
  source!.delete(handle);
  return ticket;
}

/** Host-only, one-use access while the bound caller remains active. */
export function resolveTransferredBundle(caller: CallAuthority, ticket: ClaimedBundleTicket):
  Readonly<{ path: string; bytes: number; sha256: string }> {
  caller.assertGranted("hosts");
  const owned = claimedStages.get(caller), stage = owned?.stages.get(ticket);
  if (!owned || !stage || owned.used.has(ticket))
    throw new CoreError("capability_denied", "bundle ticket is not owned by this caller or was used");
  owned.used.add(ticket);
  try {
    checkStageBytes(stage);
    caller.assertActive();
    return Object.freeze({ path: stage.path, bytes: stage.bytes, sha256: stage.sha256 });
  } catch (error) {
    try { rmSync(stage.dir, { recursive: true, force: true }); owned.stages.delete(ticket); }
    catch { throw new CoreError("plugin_unavailable", "transferred bundle cleanup failed; cleanup unverified"); }
    throw error;
  }
}

/** Host-only exact source binding for verification after provider authority revokes. */
export function assertTransferredBundleGrant(ticket: ClaimedBundleTicket, grant: PersistedFetchGrant): void {
  if (claimedGrants.get(ticket) !== grant) deny("bundle ticket was not issued for this persisted run");
}

/** Host-only cleanup for a broker result that was rejected after ownership transfer. */
export function discardTransferredBundle(caller: CallAuthority, ticket: ClaimedBundleTicket): void {
  if (claimedOwners.get(ticket) !== caller)
    throw new CoreError("capability_denied", "bundle ticket does not belong to this caller");
  const owned = claimedStages.get(caller), stage = owned?.stages.get(ticket);
  if (!stage) return;
  try { rmSync(stage.dir, { recursive: true, force: true }); owned!.stages.delete(ticket); }
  catch { throw new CoreError("plugin_unavailable", "transferred bundle cleanup failed; cleanup unverified"); }
}

export interface RelocatedBundle { readonly path: string; readonly name: string;
  /** Pinned parent; the host claimant must close it after finalization or rollback. */
  readonly directoryFd: number; readonly file: Stats }

/** Host-only terminal move. Verification happens in claimed-bundle before accepted publication. */
export function relocateTransferredBundle(caller: CallAuthority, ticket: ClaimedBundleTicket,
  taskId: string, quarantine: boolean): RelocatedBundle {
  caller.assertGranted("hosts");
  if (!/^t-\d{8}-\d{6}-[0-9a-f]{4}$/.test(taskId)) deny("invalid bundle task identity");
  const owned = claimedStages.get(caller), stage = owned?.stages.get(ticket);
  if (!owned || !stage || claimedOwners.get(ticket) !== caller || !owned.used.has(ticket))
    throw new CoreError("capability_denied", "bundle ticket is not verified for this caller");
  checkStageBytes(stage);
  const root = tasksDir(caller.ctx);
  const native = writeNative(), opened: number[] = [];
  const privateDir = (fd: number) => {
    const entry = fstatSync(fd);
    if (!entry.isDirectory() || (entry.mode & 0o077) !== 0 ||
      (process.getuid && entry.uid !== process.getuid())) deny("bundle destination is not private");
    return entry;
  };
  const openDirectory = (parent: number, name: string) => {
    try { native.mkdirAt(parent, name, 0o700); }
    catch (error) { if (!(error instanceof NativeWriteError && error.errno === 17)) throw error; }
    const fd = native.openAt(parent, name, WRITE_DIRECTORY);
    opened.push(fd); privateDir(fd);
    return fd;
  };
  const logical = (path: string, fd: number) => {
    const named = lstatSync(path), pinned = fstatSync(fd);
    if (!named.isDirectory() || named.isSymbolicLink() || named.dev !== pinned.dev ||
      named.ino !== pinned.ino || named.uid !== pinned.uid || (named.mode & 0o7777) !== (pinned.mode & 0o7777))
      deny("bundle destination path changed");
  };
  let destinationFd: number | undefined, sourceFd: number | undefined, linked = false, retainedFd = false;
  const name = `${taskId}.${randomUUID()}.bundle`;
  const quarantineRoot = join(root, "quarantine"), taskQuarantine = join(quarantineRoot, taskId);
  const destination = join(quarantine ? taskQuarantine : root, name);
  try {
    const homeFd = openSync(caller.ctx.pacerHome, WRITE_DIRECTORY); opened.push(homeFd);
    if (!fstatSync(homeFd).isDirectory()) deny("bundle home is unavailable");
    const rootFd = openDirectory(homeFd, "tasks"); logical(root, rootFd);
    const quarantineFd = openDirectory(rootFd, "quarantine"); logical(quarantineRoot, quarantineFd);
    const taskFd = openDirectory(quarantineFd, taskId); logical(taskQuarantine, taskFd);
    destinationFd = quarantine ? taskFd : rootFd;
    const retained = [...native.entries(rootFd)].filter(entry => {
      const value = entry.toString("utf8");
      return value.startsWith(`${taskId}.`) && value.endsWith(".bundle");
    }).length + [...native.entries(taskFd)].filter(entry => entry.toString("utf8").endsWith(".bundle")).length;
    if (retained >= 8) throw new CoreError("too_large", "too many retained bundles for this task");
    const sourceRootFd = openSync(stage.root, WRITE_DIRECTORY); opened.push(sourceRootFd);
    if (!sameDirectory(fstatSync(sourceRootFd), stage.rootEntry)) deny("bundle stage root changed");
    sourceFd = native.openAt(sourceRootFd, basename(stage.dir), WRITE_DIRECTORY); opened.push(sourceFd);
    if (!sameDirectory(fstatSync(sourceFd), stage.dirEntry)) deny("bundle stage directory changed");
    const sourceFile = native.openAt(sourceFd, "incoming.bundle", WRITE_OPEN);
    try { if (!same(fstatSync(sourceFile), stage.fileEntry)) deny("bundle stage source changed"); }
    finally { closeSync(sourceFile); }
    caller.assertActive();
    native.linkAt(sourceFd, "incoming.bundle", destinationFd, name); linked = true;
    const fd = native.openAt(destinationFd, name, WRITE_OPEN);
    let entry: Stats;
    try {
      entry = fstatSync(fd);
      if (!entry.isFile() || entry.dev !== stage.fileEntry.dev || entry.ino !== stage.fileEntry.ino ||
        entry.size !== stage.bytes || (entry.mode & 0o077) !== 0)
        deny("published bundle identity changed");
      const hash = createHash("sha256"), chunk = Buffer.allocUnsafe(65_536);
      let size = 0, count: number;
      while ((count = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
        size += count;
        if (size > stage.bytes) deny("published bundle size changed");
        hash.update(chunk.subarray(0, count));
      }
      if (size !== stage.bytes || hash.digest("hex") !== stage.sha256 ||
        fstatSync(fd).ino !== stage.fileEntry.ino) deny("published bundle content changed");
    } finally { closeSync(fd); }
    logical(root, rootFd); logical(quarantineRoot, quarantineFd); logical(taskQuarantine, taskFd);
    caller.assertActive();
    logical(stage.root, sourceRootFd); logical(stage.dir, sourceFd);
    native.unlinkAt(sourceFd, "incoming.bundle", false);
    native.unlinkAt(sourceRootFd, basename(stage.dir), true);
    owned.stages.delete(ticket);
    retainedFd = true;
    return { path: destination, name, directoryFd: destinationFd, file: entry! };
  } catch (error) {
    if (linked && destinationFd !== undefined) {
      try {
        const fd = native.openAt(destinationFd, name, WRITE_OPEN);
        try { if (!same(fstatSync(fd), stage.fileEntry)) deny("bundle publication rollback identity changed"); }
        finally { closeSync(fd); }
        native.unlinkAt(destinationFd, name, false);
      } catch { throw new CoreError("plugin_unavailable", "bundle publication rollback failed; cleanup unverified"); }
    }
    throw error;
  } finally {
    for (const fd of opened) if (!retainedFd || fd !== destinationFd) closeSync(fd);
  }
}

/** Host-only atomic publication. The caller later verifies and retains a failed forensic bundle. */
export function publishStagedBundle(authority: CallAuthority, handle: string): { name: string; bytes: number; sha256: string } {
  const stage = resolveStagedBundle(authority, handle), name = `${stage.sha256}.bundle`;
  const root = transferRoot(authority.ctx), destination = join(root, name);
  linkSync(stage.path, destination);
  unlinkSync(stage.path); rmdirSync(stage.dir);
  states.get(authority)!.stages.delete(handle);
  return { name, bytes: stage.bytes, sha256: stage.sha256 };
}
