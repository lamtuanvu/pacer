import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { CoreError } from "../core/errors";
import type { CallAuthority } from "./authority";
import { claimSessionDuplexPin } from "./capability-spawn";
import { readDuplexChunk } from "./duplex-read";

interface Connection {
  handle: string;
  child: ChildProcessWithoutNullStreams;
  exited: Promise<void>;
  release: () => void;
  detach: () => void;
  onExit: () => void;
  reading: boolean;
  writing: boolean;
  closed: boolean;
  exitedAlready: boolean;
  fullyClosed: boolean;
  exitCode: number | null;
  exitSignal: string | null;
  terminated: boolean;
  closing?: Promise<{ ok: true; code: number | null; signal: string | null; terminated: boolean }>;
}
const connections = new WeakMap<CallAuthority, Connection>();
interface IssuedInput { seq: number; bytes: Buffer; accepted: boolean }
const issuedInputs = new WeakMap<CallAuthority, IssuedInput>();
const deny = (): never => { throw new CoreError("capability_denied", "SSH duplex handle is not owned by this call"); };

/** One host-origin frame. The plugin cannot choose stdin bytes or replay a write. */
export function armDuplexInput(authority: CallAuthority, seq: number, bytes: Buffer): void {
  authority.assertActive();
  if (issuedInputs.has(authority) || !Number.isSafeInteger(seq) || seq < 0 ||
    !Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 65_536) return deny();
  issuedInputs.set(authority, { seq, bytes: Buffer.from(bytes), accepted: false });
}

export function clearDuplexInput(authority: CallAuthority, seq: number): void {
  if (issuedInputs.get(authority)?.seq === seq) issuedInputs.delete(authority);
}

export function consumeDuplexInputReceipt(authority: CallAuthority, seq: number): void {
  authority.assertActive();
  const issued = issuedInputs.get(authority);
  if (!issued || issued.seq !== seq || !issued.accepted) return deny();
  issuedInputs.delete(authority);
}

// Child exit resumes stdio without a readable listener, discarding output the plugin has not read yet.
const retainOutput = () => {};

function terminate(connection: Connection): void {
  const child = connection.child;
  if (connection.fullyClosed || !child.pid) return;
  try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM"); }
  catch { if (!connection.exitedAlready) try { child.kill("SIGTERM"); } catch {} }
}

function close(authority: CallAuthority, connection: Connection, graceful = false): Promise<{ ok: true; code: number | null; signal: string | null; terminated: boolean }> {
  if (connection.closing) return connection.closing;
  connection.closed = true;
  // No read follows close; discard retained output so stdout can end and the child can close.
  connection.child.stdout.off("readable", retainOutput).resume();
  connection.closing = (async () => {
    if (graceful && !connection.fullyClosed) {
      let wait: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([connection.exited, new Promise<void>(resolve => {
        wait = setTimeout(resolve, 1000); wait.unref();
      })]);
      if (wait) clearTimeout(wait);
    }
    if (!connection.fullyClosed) { connection.terminated = true; terminate(connection); }
    const killer = setTimeout(() => {
      if (!connection.fullyClosed && connection.child.pid) {
        connection.terminated = true;
        try { process.kill(process.platform === "win32" ? connection.child.pid : -connection.child.pid, "SIGKILL"); }
        catch { if (!connection.exitedAlready) try { connection.child.kill("SIGKILL"); } catch {} }
      }
    }, 500);
    killer.unref();
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        connection.exited.then(() => { settled = true; }),
        new Promise<void>(resolve => { deadline = setTimeout(resolve, 2000); deadline.unref(); }),
      ]);
      if (!settled) throw new CoreError("plugin_unavailable", "SSH duplex child cleanup is unverified");
    }
    finally {
      clearTimeout(killer);
      if (deadline) clearTimeout(deadline);
      process.off("exit", connection.onExit);
      connection.detach();
      connection.release();
      issuedInputs.delete(authority);
      if (connections.get(authority) === connection) connections.delete(authority);
    }
    return { ok: true, code: connection.exitCode, signal: connection.exitSignal,
      terminated: connection.terminated };
  })();
  return connection.closing;
}

function owned(authority: CallAuthority, handle: unknown): Connection {
  authority.assertActive();
  const connection = connections.get(authority);
  if (!connection || connection.handle !== handle || connection.closed) return deny();
  return connection;
}

async function bounded<T>(authority: CallAuthority, connection: Connection, timeoutMs: number,
  action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const stop = () => controller.abort(authority.signal.reason);
  authority.signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(() => controller.abort(new CoreError("plugin_timeout", "SSH duplex I/O timed out")), timeoutMs);
  timer.unref();
  if (authority.signal.aborted) stop();
  try { return await action(controller.signal); }
  catch (error) {
    if (controller.signal.aborted) {
      await close(authority, connection);
      throw controller.signal.reason instanceof CoreError ? controller.signal.reason :
        new CoreError("plugin_unavailable", "SSH duplex owner ended");
    }
    throw error;
  } finally { clearTimeout(timer); authority.signal.removeEventListener("abort", stop); }
}

async function read(authority: CallAuthority, connection: Connection, length: number, timeoutMs: number, pollMs?: number) {
  if (connection.reading) throw new CoreError("conflict", "SSH duplex read is already pending");
  connection.reading = true;
  try {
    return await bounded(authority, connection, timeoutMs, signal =>
      readDuplexChunk(connection.child.stdout, length, signal, pollMs, () => connection.closed));
  } catch (error) {
    await close(authority, connection);
    throw error instanceof CoreError ? error : new CoreError("plugin_unavailable", "SSH duplex output failed");
  } finally { connection.reading = false; }
}

async function write(authority: CallAuthority, connection: Connection, base64: string, timeoutMs: number) {
  if (connection.writing) throw new CoreError("conflict", "SSH duplex write is already pending");
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length || bytes.length > 65_536 || bytes.toString("base64") !== base64)
    throw new CoreError("invalid_input", "SSH duplex input exceeds the bounded frame");
  const issued = issuedInputs.get(authority);
  if (!issued || issued.accepted || !issued.bytes.equals(bytes)) return deny();
  connection.writing = true;
  try {
    const result = await bounded(authority, connection, timeoutMs, signal => new Promise<{ bytes: number }>((resolve, reject) => {
      const stream = connection.child.stdin;
      const cleanup = () => { stream.off("error", failed); signal.removeEventListener("abort", cancelled); };
      const failed = () => { cleanup(); reject(new CoreError("plugin_unavailable", "SSH duplex input failed")); };
      const cancelled = () => { cleanup(); reject(signal.reason); };
      stream.once("error", failed); signal.addEventListener("abort", cancelled, { once: true });
      if (signal.aborted) { cancelled(); return; }
      if (stream.destroyed || connection.closed) { failed(); return; }
      stream.write(bytes, error => {
        cleanup();
        if (error) reject(new CoreError("plugin_unavailable", "SSH duplex input failed"));
        else resolve({ bytes: bytes.length });
      });
    }));
    authority.assertActive();
    issued.accepted = true;
    return result;
  } catch (error) {
    await close(authority, connection);
    throw error instanceof CoreError ? error : new CoreError("plugin_unavailable", "SSH duplex input failed");
  } finally { connection.writing = false; }
}

/** Private broker process lane: one pinned SSH child and one read/write each. */
export async function answerDuplex(authority: CallAuthority, declaredScopes: readonly string[],
  method: string, params: Record<string, unknown>): Promise<unknown> {
  if (method === "capability.process.duplex.open") {
    if (connections.has(authority)) return deny();
    const argv = params.argv as string[], timeoutMs = params.timeoutMs as number;
    const pin = claimSessionDuplexPin(authority, declaredScopes, argv, timeoutMs);
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(pin.executable, argv.slice(1), { env: pin.env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] }); }
    catch (error) { pin.release(); throw error; }
    child.stderr.resume(); // Never retain session or SSH diagnostic bytes.
    child.stdout.on("readable", retainOutput);
    child.stdin.on("error", () => {}); // The write callback reports failure; keep late EPIPE contained.
    const connection: Connection = { handle: randomUUID(), child, exited: Promise.resolve(), release: pin.release,
      detach: () => {}, onExit: () => {}, reading: false, writing: false, closed: false,
      exitedAlready: false, fullyClosed: false, exitCode: null, exitSignal: null, terminated: false };
    connection.exited = new Promise<void>(resolve => {
      child.once("exit", (code, signal) => { connection.exitedAlready = true;
        connection.exitCode = code; connection.exitSignal = signal; });
      child.once("close", () => { connection.exitedAlready = true; connection.fullyClosed = true; resolve(); });
      // An error can report a failed signal or pipe operation; only `close`
      // proves the child and its stdio handles have actually terminated.
      child.on("error", () => {});
    });
    connection.onExit = () => terminate(connection);
    process.once("exit", connection.onExit);
    connections.set(authority, connection);
    connection.detach = authority.onRevoke(async () => { await close(authority, connection); });
    return { handle: connection.handle };
  }
  const connection = owned(authority, params.handle);
  if (method === "capability.process.duplex.read") return read(authority, connection, params.length as number, params.timeoutMs as number, params.pollMs as number | undefined);
  if (method === "capability.process.duplex.write") return write(authority, connection, params.base64 as string, params.timeoutMs as number);
  if (method === "capability.process.duplex.close") return close(authority, connection, params.graceful === true);
  throw new CoreError("unknown_op", "unknown SSH duplex method");
}
