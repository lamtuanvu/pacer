import { appendFileSync, chmodSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, closeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pluginRegistry } from "../plugins";
import { issueConfiguredHostReadFrom } from "../plugins/host-read-from-issuer";
import { issueConfiguredHostSessionFiles } from "../plugins/host-session-files-issuer";
import { readTask } from "../tasks/store";
import type { HostCfg } from "../config/hosts";
import type { Ctx } from "../types";

const NAMES = ["session.ckpt", "session.log.1", "session.log", "session.state"] as const;
type Name = typeof NAMES[number];
const RECORDINGS = ["session.ckpt", "session.log.1", "session.log"] as const;
type RecordingName = typeof RECORDINGS[number];
type Entry = { bytes: number | null; sum: string };
export type SessionFilesSnapshot = Record<Name, Entry>;
const marker = ".session-files-rollback.json", backup = ".session-files-rollback";
const maxFileBytes = 512 * 1024 * 1024;
const maxStageBytes = 1024 * 1024 * 1024;
const maxStageAgeMs = 60 * 60 * 1000;
const maxPollBytes = 4 * 1024 * 1024;
const maxPollMs = 30_000;
const stageName = ".session-files-paging";
interface StageManifest {
  binding: string;
  createdAt: number;
  snapshot: SessionFilesSnapshot;
  changed: RecordingName[];
  offsets: Partial<Record<RecordingName, number>>;
}

function parseMetadata(stdout: string, remoteDir: string): SessionFilesSnapshot {
  const facts = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const at = line.indexOf("=");
    if (at < 1 || facts.has(line.slice(0, at))) throw Error("invalid remote session metadata");
    facts.set(line.slice(0, at), line.slice(at + 1));
  }
  if (facts.size !== NAMES.length * 2) throw Error("incomplete remote session metadata");
  const snapshot = {} as SessionFilesSnapshot;
  for (const name of NAMES) {
    const rawBytes = facts.get(`${name}.bytes`), sum = facts.get(`${name}.sum`);
    if (rawBytes === undefined || sum === undefined) throw Error("incomplete remote session metadata");
    if (rawBytes === "" && sum === "") { snapshot[name] = { bytes: null, sum }; continue; }
    if (!/^(?:0|[1-9][0-9]*)$/.test(rawBytes) || !Number.isSafeInteger(Number(rawBytes)) ||
      Number(rawBytes) > maxFileBytes) throw Error("invalid remote session file length");
    const bytes = Number(rawBytes);
    if (name === "session.log") {
      if (!/^[1-9][0-9]*$/.test(sum)) throw Error("invalid remote session log inode");
    } else {
      const match = /^(\d+) (\d+) (.*)$/.exec(sum);
      if (!match || Number(match[2]) !== bytes || match[3] !== join(remoteDir, name))
        throw Error("invalid remote session checksum");
    }
    snapshot[name] = { bytes, sum };
  }
  return snapshot;
}

function compatible(before: SessionFilesSnapshot, after: SessionFilesSnapshot): boolean {
  for (const name of RECORDINGS) {
    if (name === "session.log") {
      const old = before[name], next = after[name];
      if (old.bytes === null ? next.bytes !== null : next.sum !== old.sum || next.bytes === null || next.bytes < old.bytes) return false;
    } else if (before[name].bytes !== after[name].bytes || before[name].sum !== after[name].sum) return false;
  }
  return true;
}

function runBinding(ctx: Ctx, host: HostCfg, remoteDir: string, localDir: string): string {
  const taskId = /^.+\/\.pacer-remote\/runs\/(t-\d{8}-\d{6}-[0-9a-f]{4})\/[1-9][0-9]*$/.exec(remoteDir)?.[1];
  const task = taskId ? readTask(ctx, taskId) : null;
  if (!task?.run || task.run.remoteDir !== remoteDir || task.run.dir !== localDir || task.run.host !== host.alias)
    throw Error("remote session run changed");
  return JSON.stringify([ctx.pacerHome, remoteDir, localDir, task.run, host]);
}

function saveStage(stage: string, manifest: StageManifest): void {
  const file = join(stage, "manifest.json"), temporary = `${file}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporary, JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
    flush(temporary); renameSync(temporary, file); flush(stage);
  } finally { rmSync(temporary, { force: true }); }
}

function loadStage(stage: string, binding: string, current: SessionFilesSnapshot): StageManifest | null {
  try {
    const info = lstatSync(stage);
    if (!info.isDirectory() || (info.mode & 0o077) !== 0 ||
      (globalThis.process.getuid && info.uid !== globalThis.process.getuid())) return null;
    const manifest = JSON.parse(readFileSync(join(stage, "manifest.json"), "utf8")) as StageManifest;
    if (manifest.binding !== binding || !Number.isSafeInteger(manifest.createdAt) ||
      manifest.createdAt > Date.now() + 1000 || Date.now() - manifest.createdAt > maxStageAgeMs ||
      !compatible(manifest.snapshot, current) ||
      !Array.isArray(manifest.changed) || manifest.changed.some(name => !RECORDINGS.includes(name)) ||
      new Set(manifest.changed).size !== manifest.changed.length) return null;
    let total = 0;
    for (const name of manifest.changed) {
      const length = manifest.snapshot[name].bytes, offset = manifest.offsets[name];
      if (length === null) { if (offset !== undefined) return null; continue; }
      if (!Number.isSafeInteger(offset) || offset! < 0 || offset! > length ||
        !lstatSync(join(stage, name)).isFile() || statSync(join(stage, name)).size !== offset) return null;
      total += length;
    }
    if (total > maxStageBytes) return null;
    for (const name of readdirSync(stage)) if (name.startsWith("manifest.json.tmp-"))
      rmSync(join(stage, name), { force: true });
    return manifest;
  } catch { return null; }
}

function flush(file: string): void {
  const fd = openSync(file, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Finish an interrupted publication before the next recording observation. */
export function recoverSessionFiles(localDir: string): void {
  const journal = join(localDir, marker), previous = join(localDir, backup);
  if (!existsSync(journal)) {
    rmSync(`${journal}.tmp`, { force: true });
    rmSync(previous, { recursive: true, force: true });
    return;
  }
  const parsed: unknown = JSON.parse(readFileSync(journal, "utf8"));
  if (!Array.isArray(parsed) || parsed.some(item => !NAMES.includes(item?.name) || typeof item.present !== "boolean") ||
    new Set(parsed.map(item => item.name)).size !== parsed.length) throw Error("invalid session recording rollback journal");
  for (const item of parsed as { name: Name; present: boolean }[]) {
    const target = join(localDir, item.name);
    if (item.present) {
      const source = join(previous, item.name), restore = join(localDir, `.restore-${item.name}`);
      if (!lstatSync(source).isFile()) throw Error("missing session recording rollback source");
      copyFileSync(source, restore); chmodSync(restore, 0o600); renameSync(restore, target);
    } else rmSync(target, { force: true });
  }
  rmSync(journal, { force: true });
  rmSync(previous, { recursive: true, force: true });
}

export function publishSessionFiles(localDir: string, stage: string, changed: Name[], snapshot: SessionFilesSnapshot,
  replace: typeof renameSync = renameSync): void {
  if (!changed.length) return;
  const previous = join(localDir, backup), journal = join(localDir, marker);
  mkdirSync(previous, { mode: 0o700 });
  const old = changed.map(name => ({ name, present: existsSync(join(localDir, name)) }));
  try {
    for (const { name, present } of old) if (present) {
      const source = join(localDir, name);
      if (!lstatSync(source).isFile()) throw Error("session recording target is not a regular file");
      copyFileSync(source, join(previous, name)); chmodSync(join(previous, name), 0o600); flush(join(previous, name));
    }
    writeFileSync(`${journal}.tmp`, JSON.stringify(old), { mode: 0o600, flag: "wx" });
    flush(`${journal}.tmp`); renameSync(`${journal}.tmp`, journal);
    flush(localDir);
    for (const name of changed) {
      if (snapshot[name].bytes === null) rmSync(join(localDir, name), { force: true });
      else replace(join(stage, name), join(localDir, name));
    }
    flush(localDir);
    rmSync(journal, { force: true });
    // Once the marker is removed, all replacements are published. Cleanup is
    // retried on the next observation if it cannot finish now.
    try { flush(localDir); rmSync(previous, { recursive: true, force: true }); } catch { /* stale backup is safe */ }
  } catch (error) {
    if (existsSync(journal)) recoverSessionFiles(localDir);
    else { rmSync(`${journal}.tmp`, { force: true }); rmSync(previous, { recursive: true, force: true }); }
    throw error;
  }
}

/** Mirror one stable recording generation through bounded, one-use plugin reads. */
export async function mirrorSessionFiles(ctx: Ctx, host: HostCfg, remoteDir: string, localDir: string,
  previous?: SessionFilesSnapshot): Promise<{ snapshot?: SessionFilesSnapshot; pending: boolean }> {
  recoverSessionFiles(localDir);
  const registry = pluginRegistry(ctx), deadline = Date.now() + maxPollMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const metadata = async () => {
    const grant = issueConfiguredHostSessionFiles(ctx, host.alias, remoteDir, localDir);
    const result = await registry.sessionFilesConfiguredHost(ctx, grant, AbortSignal.timeout(remaining()));
    if (result.code !== 0 || result.timedOut) throw Error(result.stderr || "remote session metadata unavailable");
    return parseMetadata(result.stdout, remoteDir);
  };
  const current = await metadata(), binding = runBinding(ctx, host, remoteDir, localDir);
  const stage = join(localDir, stageName);
  let manifest = existsSync(stage) ? loadStage(stage, binding, current) : null;
  if (!manifest) {
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { mode: 0o700 });
    const changed: RecordingName[] = [], offsets: StageManifest["offsets"] = {};
    let total = 0;
    for (const name of RECORDINGS) {
      const entry = current[name], target = join(localDir, name), prior = previous?.[name];
      if (entry.bytes === null) {
        if (existsSync(target)) changed.push(name);
        continue;
      }
      const localBytes = existsSync(target) ? statSync(target).size : 0;
      if (prior?.sum === entry.sum && prior.bytes === entry.bytes && localBytes === entry.bytes && existsSync(target)) continue;
      changed.push(name); total += entry.bytes;
      if (total > maxStageBytes) throw Error("remote session stage exceeds retained byte limit");
      const append = name === "session.log" && prior?.sum === entry.sum && prior.bytes !== null &&
        existsSync(target) && localBytes === prior.bytes && localBytes <= entry.bytes;
      if (append) { copyFileSync(target, join(stage, name)); chmodSync(join(stage, name), 0o600); offsets[name] = localBytes; }
      else { writeFileSync(join(stage, name), "", { mode: 0o600 }); offsets[name] = 0; }
    }
    manifest = { binding, createdAt: Date.now(), snapshot: current, changed, offsets };
    saveStage(stage, manifest);
  }
  const before = manifest.snapshot;
  let budget = maxPollBytes;
  for (const name of manifest.changed) {
    const length = before[name].bytes;
    if (length === null) continue;
    let at = manifest.offsets[name] ?? 0;
    while (at < length && budget > 0 && Date.now() < deadline) {
      const count = Math.min(262_144, length - at, budget);
      const grant = issueConfiguredHostReadFrom(ctx, host.alias, remoteDir, localDir, name, at, count);
      const result = await registry.readFromConfiguredHost(ctx, grant, AbortSignal.timeout(remaining()));
      if (result.code !== 0 || result.timedOut || !/^(?:[a-f0-9]{2})*$/.test(result.stdout))
        throw Error("remote session range unavailable");
      const bytes = Buffer.from(result.stdout, "hex");
      if (bytes.length !== count) throw Error("short remote session range");
      appendFileSync(join(stage, name), bytes);
      at += count; budget -= count; manifest.offsets[name] = at;
      saveStage(stage, manifest);
    }
    if (at < length) return { snapshot: previous, pending: true };
    flush(join(stage, name));
  }
  const changed: Name[] = [...manifest.changed];
  const state = before["session.state"], oldState = previous?.["session.state"];
  if (state.bytes === null) {
    if (existsSync(join(localDir, "session.state"))) changed.push("session.state");
  } else if (state.bytes <= Math.min(262_144, budget) && Date.now() < deadline &&
    !(oldState?.sum === state.sum && existsSync(join(localDir, "session.state")) && statSync(join(localDir, "session.state")).size === state.bytes)) {
    try {
      const count = Math.max(1, state.bytes);
      if (count > budget) throw Error("remote session poll budget exhausted");
      budget -= count;
      const grant = issueConfiguredHostReadFrom(ctx, host.alias, remoteDir, localDir, "session.state", 0, count);
      const result = await registry.readFromConfiguredHost(ctx, grant, AbortSignal.timeout(remaining()));
      if (result.code === 0 && !result.timedOut && /^(?:[a-f0-9]{2})*$/.test(result.stdout) &&
        Buffer.byteLength(result.stdout) === state.bytes * 2) {
        writeFileSync(join(stage, "session.state"), Buffer.from(result.stdout, "hex"), { mode: 0o600 });
        changed.push("session.state");
      }
    } catch { /* active session state is optional */ }
  }
  const after = await metadata();
  if (!compatible(before, after)) {
    rmSync(stage, { recursive: true, force: true });
    throw Error("remote session files changed while reading");
  }
  if (before["session.state"].sum !== after["session.state"].sum ||
    before["session.state"].bytes !== after["session.state"].bytes) {
    const at = changed.indexOf("session.state");
    if (at >= 0) changed.splice(at, 1);
  }
  publishSessionFiles(localDir, stage, changed, before);
  rmSync(stage, { recursive: true, force: true });
  return { snapshot: { ...before, "session.state": changed.includes("session.state") ||
    (oldState?.sum === before["session.state"].sum && oldState?.bytes === before["session.state"].bytes)
    ? before["session.state"] : oldState ?? { bytes: null, sum: "" } }, pending: false };
}
