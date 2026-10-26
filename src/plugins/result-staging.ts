import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdtemp, open, realpath, rmdir, statfs, unlink, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreError } from "../core/errors";
import type { CallAuthority } from "./authority";

const CHUNK = 262144, RESERVE = 8 * 1024 * 1024;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
type Identity = { device: number; inode: number };
const identity = (stat: Stats): Identity => ({ device: stat.dev, inode: stat.ino });
const matches = (stat: Stats, expected?: Identity) => !!expected && stat.dev === expected.device && stat.ino === expected.inode;
const conflict = (message: string): never => { throw new CoreError("conflict", message); };
const invalid = (message: string): never => { throw new CoreError("invalid_input", message); };
function ioError(error: unknown, message: string): CoreError {
  if (error instanceof CoreError) return error;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  // Preserve a useful errno without serializing host-private staging paths.
  return new CoreError("plugin_unavailable", message, undefined,
    typeof code === "string" && /^E[A-Z]+$/.test(code) ? { causeCode: code } : undefined);
}

/** Host-owned transfer; paths never come from plugin input and cleanup belongs to the call. */
export class ResultStaging {
  private directory?: string;
  private directoryIdentity?: Identity;
  private file?: FileHandle;
  private fileIdentity?: Identity;
  private bytes = 0;
  private busy = false;
  private finished = false;
  private readonly ready: Promise<void>;
  private pending: Promise<void> = Promise.resolve();
  private disposal?: Promise<void>;

  constructor(private readonly authority: CallAuthority) {
    authority.assertActive();
    // Register before any asynchronous creation. The deferred initializer is assigned
    // before revoke can observe it, including reentrant expiry from an activity check.
    authority.onRevoke(() => this.dispose());
    this.ready = Promise.resolve().then(() => this.initialize()).catch(error => { throw ioError(error, "result staging could not initialize"); });
    // Initialization may fail before a transport chunk arrives; preserve that rejection
    // for operations while avoiding an unhandled rejection on an abandoned request.
    void this.ready.catch(() => {});
  }

  private async initialize(): Promise<void> {
    this.authority.assertActive();
    const root = await realpath(tmpdir());
    this.authority.assertActive();
    this.directory = await mkdtemp(join(root, "pacer-plugin-result-"));
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) conflict("result staging directory changed during creation");
    this.directoryIdentity = identity(stat);
    this.authority.assertActive();
    await chmod(this.directory, 0o700);
    this.authority.assertActive();
    this.file = await open(join(this.directory, "result.json"), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    // Capture ownership even if cancellation happened during open, so cleanup can
    // close/remove the admitted resource before authority settlement completes.
    this.fileIdentity = identity(await this.file.stat());
    this.authority.assertActive();
  }

  private async checkDirectory(): Promise<void> {
    const directory = this.directory ?? conflict("result staging directory identity is unavailable");
    const expected = this.directoryIdentity ?? conflict("result staging directory identity is unavailable");
    try {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !matches(stat, expected)
        || await realpath(directory) !== directory) conflict("result staging directory identity changed");
    } catch (error) {
      if (error instanceof CoreError) throw error;
      conflict("result staging directory identity is unavailable");
    }
  }

  private async validate(): Promise<void> {
    this.authority.assertActive();
    await this.checkDirectory();
    const directory = await lstat(this.directory!);
    const stat = await this.file!.stat(), path = await lstat(join(this.directory!, "result.json"));
    if ((directory.mode & 0o777) !== 0o700 || (stat.mode & 0o777) !== 0o600
      || !stat.isFile() || !path.isFile() || path.isSymbolicLink() || !matches(stat, this.fileIdentity)
      || !matches(path, this.fileIdentity) || stat.size !== this.bytes || path.size !== this.bytes)
      conflict("result staging file identity or size changed");
    this.authority.assertActive();
  }

  private async operation<T>(action: () => Promise<T>): Promise<T> {
    this.authority.assertActive();
    if (this.busy) conflict("one result staging operation is already active");
    this.busy = true;
    const task = Promise.resolve().then(async () => {
      await this.ready;
      this.authority.assertActive();
      if (this.finished) conflict("result transfer is already complete");
      return action();
    }).catch(error => { throw ioError(error, "result staging operation failed"); });
    this.pending = task.then(() => {}, () => {});
    try { return await task; } finally { this.busy = false; }
  }

  stage(offset: number, base64: string): Promise<{ bytes: number }> {
    return this.operation(async () => {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset !== this.bytes) invalid("result chunk offset must be contiguous");
      if (typeof base64 !== "string" || !base64 || base64.length > 349528 || !BASE64.test(base64)) invalid("invalid result chunk encoding");
      const bytes = Buffer.from(base64, "base64");
      if (!bytes.length || bytes.length > CHUNK || !Number.isSafeInteger(this.bytes + bytes.length)) invalid("invalid result chunk size");
      await this.validate();
      const space = await statfs(this.directory!);
      this.authority.assertActive();
      if (space.bavail * space.bsize - bytes.length < RESERVE) throw new CoreError("plugin_unavailable", "insufficient disk reserve for result staging");
      await this.validate();
      let written = 0;
      while (written < bytes.length) {
        this.authority.assertActive();
        const next = await this.file!.write(bytes, written, bytes.length - written, this.bytes + written);
        if (!next.bytesWritten) throw new CoreError("plugin_unavailable", "result chunk could not be fully staged");
        written += next.bytesWritten;
      }
      this.bytes += written;
      await this.validate();
      return { bytes: this.bytes };
    });
  }

  finish(expectedBytes: number): Promise<unknown> {
    return this.operation(async () => {
      this.finished = true;
      if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes !== this.bytes) invalid("result completion length does not match staged bytes");
      await this.validate();
      const before = await this.file!.stat(), bytes = await this.file!.readFile(), after = await this.file!.stat();
      if (bytes.length !== expectedBytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
        conflict("result changed during assembly");
      await this.validate();
      let result: unknown;
      try { result = JSON.parse(bytes.toString("utf8")); }
      catch { return invalid("staged result is not complete valid JSON"); }
      this.authority.assertActive();
      return result;
    });
  }

  private dispose(): Promise<void> {
    if (!this.disposal) this.disposal = this.cleanup();
    return this.disposal;
  }
  private async cleanup(): Promise<void> {
    await this.ready.catch(() => {});
    await this.pending;
    let failure: unknown;
    try { await this.file?.close(); } catch (error) { failure = error; }
    if (this.directory) {
      try {
        await this.checkDirectory();
        if (this.fileIdentity) {
          const path = join(this.directory, "result.json"), stat = await lstat(path);
          if (!stat.isFile() || stat.isSymbolicLink() || !matches(stat, this.fileIdentity)) conflict("result cleanup refused a substituted file");
          await unlink(path);
        }
        // Never recursively remove a replacement or unexpected contents.
        await rmdir(this.directory);
      } catch (error) { failure ??= error; }
    }
    if (failure) throw ioError(failure, "result staging cleanup failed");
  }
}
