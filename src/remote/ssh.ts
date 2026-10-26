import { beginWorkSync, finishWorkSync } from "../update/desktop/admission";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, rmdirSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { HostCfg } from "../config/hosts";
import { shq } from "../install/fsx";
import type { Ctx, RunResult } from "../types";
import { killTree } from "../exec/process";
import { SCRIPTS } from "./scripts";

/** Private directory for pacer's own OpenSSH multiplexing sockets. */
export function controlDir(ctx: Ctx): string {
  const homeDir = join(ctx.pacerHome, "ssh");
  // OpenSSH expands %C to 40 hex bytes; macOS rejects socket paths >= 104 bytes.
  const tooLong = Buffer.byteLength(join(homeDir, `cm-${"f".repeat(40)}`)) >= 104;
  const short = tooLong && process.platform !== "win32";
  const dir = short
    ? join("/tmp", `pacer-ssh-${process.getuid!()}-${createHash("sha256").update(ctx.pacerHome).digest("hex").slice(0, 16)}`)
    : homeDir;
  if (short) {
    try { mkdirSync(dir, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const entry = lstatSync(dir);
    if (!entry.isDirectory() || entry.uid !== process.getuid!() || (entry.mode & 0o077) !== 0) {
      throw new Error("SSH control directory is not private and owned by this user");
    }
  } else {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  return dir;
}

export function sshArgv(ctx: Ctx, host: HostCfg, script: string, args: string[], completionNonce?: string): string[] {
  if (!Object.values<string>(SCRIPTS).includes(script)) throw new Error("unknown remote script");
  if (completionNonce && !/^[a-f0-9-]{36}$/.test(completionNonce)) throw new Error("invalid remote completion nonce");
  const program = completionNonce
    ? `printf '__PACER_BEGIN__\\n'; ( ${script}\n); pacer_result=$?; printf '\\n__PACER_DONE__=${completionNonce}\\n'; exit "$pacer_result"`
    : `printf '__PACER_BEGIN__\\n'; ${script}`;
  return [
    "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2",
    "-o", "ControlMaster=auto", "-o", `ControlPath=${join(controlDir(ctx), "cm-%C")}`,
    "-o", "ControlPersist=60", "--", host.ssh,
    `bash -lc ${shq(program)} pacer${args.map((arg) => ` ${shq(arg)}`).join("")}`,
  ];
}

export async function runRemote(ctx: Ctx, host: HostCfg, script: string, args: string[], o: { stdin?: string; timeoutMs?: number } = {}): Promise<RunResult> {
  const mutation = ([SCRIPTS.PREPARE, SCRIPTS.CLEAN, SCRIPTS.SET_IDENTITY] as readonly string[]).includes(script)
    || (script === SCRIPTS.CHECK_REPO && args[1] === "clone")
    || (script === SCRIPTS.BINARY && args[1] !== "check");
  const lease = mutation ? beginWorkSync(ctx, { kind: "operation", id: randomUUID(), label: `Remote operation on ${host.alias}` }) : undefined;
  let sent = false;
  try {
    const argv = sshArgv(ctx, host, script, args, lease);
    sent = true;
    const result = await ctx.run(argv, o.timeoutMs ?? 60_000, { stdin: o.stdin });
    let stdout = payload(result.stdout);
    if (lease) {
      const completion = `\n__PACER_DONE__=${lease}\n`;
      if (!result.timedOut && result.code !== 255 && stdout.endsWith(completion)) {
        stdout = stdout.slice(0, -completion.length);
        finishWorkSync(ctx, lease);
      }
      // Private completion capabilities never enter command/API output, even
      // when a transport failure makes an otherwise complete receipt ambiguous.
      stdout = stdout.replaceAll(`__PACER_DONE__=${lease}`, "");
    }
    return { ...result, stdout };
  } catch (error) {
    if (lease && !sent) finishWorkSync(ctx, lease);
    throw error;
  }
}

const SENTINEL = "__PACER_BEGIN__\n";

/** Only the fixed script's framed output is a protocol payload. */
export function payload(stdout: string): string {
  const at = stdout.search(/^__PACER_BEGIN__\n/m);
  return at >= 0 ? stdout.slice(at + SENTINEL.length) : "";
}

/** Discard login-shell chatter without decoding any bundle bytes or retaining it. */
export async function* payloadStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const marker = Buffer.from(SENTINEL);
  let prefix = Buffer.alloc(0), framed = false, lineStart = true;
  for await (const chunk of stream) {
    if (framed) { yield chunk; continue; }
    const bytes = Buffer.concat([prefix, chunk]);
    prefix = Buffer.alloc(0);
    for (let i = 0; i < bytes.length; i++) {
      if (lineStart && bytes[i] === marker[0]) {
        const remaining = bytes.subarray(i);
        if (remaining.length < marker.length && marker.subarray(0, remaining.length).equals(remaining)) {
          prefix = remaining; break;
        }
        if (remaining.subarray(0, marker.length).equals(marker)) {
          framed = true;
          yield remaining.subarray(marker.length);
          break;
        }
      }
      lineStart = bytes[i] === 10;
    }
  }
  if (!framed) throw new Error("remote payload sentinel missing");
}

async function boundedStderr(stream: ReadableStream<Uint8Array>, overflow: () => void): Promise<{ text: string; overflow: boolean }> {
  const limit = 64 * 1024;
  const chunks: Buffer[] = [];
  let size = 0, exceeded = false;
  for await (const chunk of stream) {
    const remaining = limit - size;
    if (remaining > 0) {
      const part = Buffer.from(chunk.subarray(0, remaining));
      chunks.push(part);
      size += part.length;
    }
    if (chunk.length > remaining && !exceeded) {
      exceeded = true;
      overflow();
    }
  }
  return { text: Buffer.concat(chunks).toString("utf8"), overflow: exceeded };
}

export async function bundleToFile(ctx: Ctx, host: HostCfg, args: string[], path: string, maxBytes: number, timeoutMs = 60_000): Promise<RunResult & { stdoutOverflow?: boolean; stderrOverflow?: boolean; published?: true }> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 50 * 1024 * 1024) throw new Error("invalid remote bundle limit");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("invalid remote bundle timeout");
  const homeInfo = lstatSync(ctx.pacerHome);
  if (!homeInfo.isDirectory() || homeInfo.isSymbolicLink() ||
    (process.getuid && homeInfo.uid !== process.getuid()) || (homeInfo.mode & 0o022) !== 0) {
    throw new Error("remote bundle home is writable by another user or not owned by this user");
  }
  const taskDir = resolve(ctx.pacerHome, "tasks");
  if (dirname(resolve(path)) !== taskDir || !basename(path).endsWith(".bundle")) throw new Error("remote bundle destination is outside tasks");
  const destination = lstatSync(taskDir);
  if (!destination.isDirectory() || destination.isSymbolicLink() ||
    (process.getuid && destination.uid !== process.getuid()) || (destination.mode & 0o022) !== 0) {
    throw new Error("remote bundle task directory is writable by another user or not owned by this user");
  }
  try { lstatSync(path); throw new Error("remote bundle destination already exists"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const stage = mkdtempSync(join(taskDir, ".bundle-stage-"));
  const file = join(stage, "incoming.bundle");
  let fd: number | undefined;
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let stderrPromise: Promise<{ text: string; overflow: boolean }> | undefined;
  try {
    const stageInfo = lstatSync(stage);
    if (!stageInfo.isDirectory() || stageInfo.isSymbolicLink() ||
      (process.getuid && stageInfo.uid !== process.getuid()) || (stageInfo.mode & 0o077) !== 0) {
      throw new Error("remote bundle stage is not private and owned by this user");
    }
    fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 ||
      (process.getuid && opened.uid !== process.getuid()) || (opened.mode & 0o077) !== 0) {
      throw new Error("remote bundle stage is not a private regular file");
    }
    if (ctx.operation?.signal.aborted) throw new Error("remote bundle transfer cancelled");
    proc = Bun.spawn(sshArgv(ctx, host, SCRIPTS.BUNDLE_OUT, args), {
      env: ctx.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true,
    });
    const child = proc;
    stderrPromise = boundedStderr(child.stderr, () => killTree(child.pid, "SIGKILL"));
    let timedOut = false, cancelled = false, size = 0, overflow = false;
    const abort = () => { cancelled = true; killTree(child.pid, "SIGKILL"); };
    ctx.operation?.signal.addEventListener("abort", abort, { once: true });
    if (ctx.operation?.signal.aborted) abort();
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid, "SIGKILL"); }, timeoutMs);
    try {
      let streamError: unknown;
      try {
        for await (const bytes of payloadStream(child.stdout)) {
          if (cancelled || timedOut) break;
          size += bytes.length;
          if (size > maxBytes) { overflow = true; killTree(child.pid, "SIGKILL"); break; }
          let at = 0;
          while (at < bytes.length) {
            const written = writeSync(fd, bytes, at, bytes.length - at);
            if (written < 1) throw new Error("remote bundle stage write made no progress");
            at += written;
          }
        }
      } catch (error) {
        streamError = error;
        if (child.exitCode === null) killTree(child.pid, "SIGKILL");
      }
      const [code, stderrResult] = await Promise.all([child.exited, stderrPromise]);
      const stderr = stderrResult.text;
      if (cancelled || ctx.operation?.signal.aborted) throw new Error("remote bundle transfer cancelled");
      if (timedOut) return { code, stderr, stdout: "", timedOut: true };
      if (overflow) return { code, stderr, stdout: "", stdoutOverflow: true };
      if (stderrResult.overflow) return { code, stderr, stdout: "", stderrOverflow: true };
      if (streamError) throw streamError;
      if (code !== 0) return { code, stderr, stdout: "" };
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      // Hard-link publication is atomic and refuses an existing path or symlink.
      // Both paths are under the same private PACER_HOME filesystem.
      linkSync(file, path);
      unlinkSync(file);
      rmdirSync(stage);
      return { code, stderr, stdout: "", published: true };
    } finally {
      clearTimeout(timer);
      ctx.operation?.signal.removeEventListener("abort", abort);
    }
  } finally {
    let closeFailure: unknown;
    if (fd !== undefined) try { closeSync(fd); } catch (error) { closeFailure = error; }
    if (proc && proc.exitCode === null) { killTree(proc.pid, "SIGKILL"); await proc.exited; }
    if (stderrPromise) await stderrPromise.catch(() => "");
    rmSync(stage, { recursive: true, force: true });
    if (closeFailure) throw closeFailure;
  }
}
