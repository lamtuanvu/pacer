import { sha256 } from "./helpers";

export interface PendingFile {
  path: string;
  before: string | null;
  after: string | null;
  mode?: number;
  beforeMode?: number;
}
export interface Journal { schema: 1; files: PendingFile[]; manifestHash: string }
/**
 * Private admitted IO. Caller must hold the host install lock through recovery
 * settlement. Paths in journal data confer no authority; the backend validates
 * every destination. No caller cancellation signal may abandon this protocol.
 */
export interface JournalIO {
  readJournal(): Promise<string | null>;
  writeJournal(text: string): Promise<void>;
  removeJournal(): Promise<void>;
  readManifest(): Promise<string | null>;
  writeManifest(text: string): Promise<void>;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, text: string, mode?: number): Promise<void>;
  removeFile(path: string): Promise<void>;
}
function invalid(): never { throw new Error("invalid installation recovery journal"); }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const modeValid = (value: unknown) => value === undefined || typeof value === "number"
  && Number.isSafeInteger(value) && value >= 0 && value <= 0o700 && (value & ~0o700) === 0;
function validate(value: unknown): Journal {
  if (!record(value) || value.schema !== 1 || !Array.isArray(value.files)
    || typeof value.manifestHash !== "string" || !/^[a-f0-9]{64}$/.test(value.manifestHash)
    || Object.keys(value).some(key => !["schema", "files", "manifestHash"].includes(key))) invalid();
  const seen = new Set<string>();
  const files: PendingFile[] = [];
  for (const file of value.files) {
    if (!record(file) || typeof file.path !== "string" || !file.path || file.path.includes("\0") || seen.has(file.path)
      || !(file.before === null || typeof file.before === "string")
      || !(file.after === null || typeof file.after === "string")
      || !modeValid(file.mode) || !modeValid(file.beforeMode)
      || Object.keys(file).some(key => !["path", "before", "after", "mode", "beforeMode"].includes(key))) invalid();
    seen.add(file.path);
    files.push({ path: file.path, before: file.before, after: file.after,
      ...(file.mode === undefined ? {} : { mode: file.mode as number }),
      ...(file.beforeMode === undefined ? {} : { beforeMode: file.beforeMode as number }),
    });
  }
  return { schema: 1, files, manifestHash: value.manifestHash };
}
function parse(text: string): Journal {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return invalid(); }
  return validate(value);
}

export async function recoverInstall(io: JournalIO): Promise<void> {
  const text = await io.readJournal();
  if (text === null) return;
  const journal = parse(text);
  const manifest = await io.readManifest();
  if (manifest !== null && sha256(manifest) === journal.manifestHash) {
    await io.removeJournal(); return;
  }
  // Complete preflight before the first rollback effect; a conflict retains the
  // journal and does not discard an intervening user edit elsewhere in the plan.
  for (const file of journal.files) {
    const value = await io.readFile(file.path);
    if (value !== file.before && value !== file.after) {
      throw new Error(`integration changed during recovery: ${file.path}; reconnect after resolving the conflict`);
    }
  }
  for (const file of [...journal.files].reverse()) {
    if (file.before === null) await io.removeFile(file.path);
    else await io.writeFile(file.path, file.before, file.beforeMode);
  }
  await io.removeJournal();
}

export async function commitInstall(io: JournalIO, files: readonly PendingFile[], manifest: string): Promise<void> {
  if (typeof manifest !== "string") invalid();
  // Snapshot metadata before awaiting backend code: later caller mutations are
  // not part of this admitted transaction. This is data validation, not grants.
  const journal = validate({ schema: 1, files, manifestHash: sha256(manifest) });
  for (const file of journal.files) {
    if (await io.readFile(file.path) !== file.before) throw new Error(`integration changed while planning: ${file.path}`);
  }
  await io.writeJournal(JSON.stringify(journal));
  try {
    for (const file of journal.files) {
      if (await io.readFile(file.path) !== file.before) throw new Error(`integration changed while applying: ${file.path}`);
      if (file.after === null) await io.removeFile(file.path);
      else await io.writeFile(file.path, file.after, file.mode);
    }
    await io.writeManifest(manifest);
    await io.removeJournal();
  } catch (error) {
    // Await recovery regardless of client lifetime. As in the host, a recovery
    // failure supersedes the original error and leaves durable evidence to retry.
    await recoverInstall(io);
    throw error;
  }
}
