import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, statSync, type Stats } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
import { CoreError } from "../core/errors";
import type { CallAuthority } from "./authority";

const MAX_OUTPUT = 1048576, MAX_CHUNK = 262144;
interface Pin { argv: readonly string[]; timeoutMs: number; selected: string | null; canonical?: string; stat?: Stats; link?: Stats }
interface State { pins: Pin[]; busy: boolean; output: Map<string, Buffer>; cleanupFailure?: Error }
const states = new WeakMap<CallAuthority, State>();
const deny = (message: string): never => { throw new CoreError("capability_denied", message); };
const invalid = (message: string): never => { throw new CoreError("invalid_input", message); };
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.mode === b.mode;

/** Issuance-time snapshot, before untrusted plugin execution; never pin on first RPC. */
export function prepareSpawnAuthority(authority: CallAuthority): void {
  authority.assertActive();
  if (states.has(authority)) return;
  const pins = authority.resources.commands.map(command => {
    const selected = authority.ctx.which(command.argv[0]!);
    const pin: Pin = { argv: command.argv, timeoutMs: command.timeoutMs, selected };
    if (selected) {
      if (!isAbsolute(selected)) deny("provider executable must be absolute");
      pin.canonical = realpathSync(selected); pin.link = lstatSync(selected); pin.stat = statSync(pin.canonical);
      if (!pin.stat.isFile() || !(pin.stat.mode & 0o111)) deny("provider executable is not executable");
    }
    return pin;
  });
  const state: State = { pins, busy: false, output: new Map() };
  states.set(authority, state);
  authority.onRevoke(() => { state.output.clear(); });
}

function stateOf(authority: CallAuthority): State {
  authority.assertGranted("process.spawn");
  return states.get(authority) ?? deny("provider executable was not pinned at call issuance");
}
export async function readSpawnOutput(authority: CallAuthority, params: Record<string, unknown>): Promise<{ base64: string }> {
  const state = stateOf(authority), { handle, offset, length } = params;
  if (typeof handle !== "string" || !Number.isSafeInteger(offset) || (offset as number) < 0 || !Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > MAX_CHUNK) invalid("invalid output range");
  const bytes = state.output.get(handle as string) ?? deny("output handle does not belong to this call");
  if ((offset as number) > bytes.length) invalid("output offset exceeds size");
  return { base64: bytes.subarray(offset as number, (offset as number) + (length as number)).toString("base64") };
}

export async function answerSpawn(authority: CallAuthority, declaredScopes: readonly string[], params: Record<string, unknown>): Promise<unknown> {
  const state = stateOf(authority);
  if (state.cleanupFailure) throw state.cleanupFailure;
  if (Object.keys(params).some(key => key !== "argv" && key !== "timeoutMs")) invalid("provider env, cwd and stdin overrides are unavailable");
  const { argv, timeoutMs } = params;
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 32 || argv.some(arg => typeof arg !== "string" || arg.length > 4096 || arg.includes("\0")) || !Number.isSafeInteger(timeoutMs) || (timeoutMs as number) <= 0) invalid("invalid provider command");
  const args = argv as string[];
  if (!declaredScopes.includes(args[0]!) || args[0] === "*" || isAbsolute(args[0]!)) deny("provider command is not declared");
  const pin = state.pins.find(pin => JSON.stringify(pin.argv) === JSON.stringify(argv)) ?? deny("provider command is not owned by this call");
  if ((timeoutMs as number) > pin.timeoutMs) deny("provider timeout exceeds owning call");
  if (state.busy) deny("owning call already has a provider child");
  // Only the latest invocation's two outputs survive, bounding retained output per call.
  state.output.clear();
  if (!pin.selected) return { code: 127, stdout: "", stderr: `${args[0]} not found`, timedOut: false };
  try {
    if (realpathSync(pin.selected) !== pin.canonical || !same(lstatSync(pin.selected), pin.link!) || !same(statSync(pin.canonical!), pin.stat!)) deny("provider executable changed since call issuance");
  } catch (error) {
    if (error instanceof CoreError) throw error;
    deny("provider executable is no longer available");
  }
  authority.assertActive(); state.busy = true;
  try {
    return await run(authority, state, pin, argv as string[], timeoutMs as number);
  } finally { state.busy = false; }
}

async function run(authority: CallAuthority, state: State, pin: Pin, argv: string[], timeoutMs: number): Promise<unknown> {
  // These host-owned trusted provider commands retain existing host env/cwd semantics.
  // argv is a vector; no shell, plugin-provided environment, cwd or stdin is accepted.
  let child: ChildProcess;
  const parts: Buffer[][] = [[], []], sizes = [0, 0];
  let failure: Error | undefined, cleanupFailure: Error | undefined, terminationFailure: Error | undefined, timedOut = false, exited = false, closed = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined, pipeTimer: ReturnType<typeof setTimeout> | undefined;
  let settle!: () => void;
  const settled = new Promise<void>(resolve => { settle = resolve; });
  const signalChild = (signal: NodeJS.Signals) => {
    // Never signal a PID/process group after its leader has exited: PID reuse is possible.
    if (exited || !child?.pid) return;
    try { process.kill(process.platform === "win32" ? child.pid : -child.pid, signal); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        terminationFailure ??= new CoreError("plugin_unavailable", "provider termination failed; cleanup unverified");
      }
    }
  };
  const stop = () => { signalChild("SIGTERM"); killTimer ??= setTimeout(() => signalChild("SIGKILL"), 100); };
  const detach = authority.onRevoke(async () => { stop(); await settled; if (cleanupFailure) throw cleanupFailure; });
  try {
    authority.assertActive();
    child = spawn(pin.canonical!, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  } catch (error) { settle(); detach(); throw error; }
  const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, Math.min(timeoutMs, authority.deadlineMs - Date.now())));
  for (const [index, stream] of [child.stdout, child.stderr].entries()) {
    stream!.on("error", () => { failure ??= new CoreError("plugin_unavailable", "provider output could not be read"); stop(); });
    stream!.on("data", (chunk: Buffer) => {
      if (failure || authority.signal.aborted) return;
      sizes[index]! += chunk.length;
      if (sizes[index]! > MAX_OUTPUT) { failure = new CoreError("too_large", "provider output exceeds per-stream limit"); stop(); return; }
      parts[index]!.push(Buffer.from(chunk));
    });
  }
  child.on("error", () => { failure ??= new CoreError("plugin_unavailable", "provider could not be started"); });
  child.on("exit", () => {
    exited = true;
    if (killTimer) clearTimeout(killTimer);
    // An inherited pipe held by a descendant is not evidence of descendant cleanup.
    pipeTimer = setTimeout(() => {
      if (!closed) {
        cleanupFailure ??= new CoreError("plugin_unavailable", "provider descendant retained output pipes; cleanup unverified");
        failure ??= cleanupFailure;
        child.stdout?.destroy(); child.stderr?.destroy();
      }
    }, 100);
  });
  const code = await new Promise<number>(resolve => child.on("close", code => { closed = true; resolve(code ?? 1); }));
  clearTimeout(timer); if (killTimer) clearTimeout(killTimer); if (pipeTimer) clearTimeout(pipeTimer);
  // A transient signal failure is discharged only by observed owned-child exit/close.
  // Until settlement cleanup remains pending; pipe-retaining descendants stay uncertain.
  if (terminationFailure && !exited) { cleanupFailure ??= terminationFailure; failure ??= terminationFailure; }
  settle();
  // Preserve uncertain cleanup as a revoke failure even if a plugin suppresses the RPC error.
  if (!cleanupFailure) detach();
  else state.cleanupFailure = cleanupFailure;
  if (failure) throw failure;
  authority.assertActive();
  const stdout = Buffer.concat(parts[0]!), stderr = Buffer.concat(parts[1]!);
  const inline = { code, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), timedOut };
  const inlineFits = Buffer.byteLength(JSON.stringify(inline)) <= 768 * 1024;
  authority.assertActive();
  if (inlineFits) return inline;
  const out = randomUUID(), err = randomUUID(); state.output.set(out, stdout); state.output.set(err, stderr);
  return { code, output: { stdout: out, stderr: err }, timedOut };
}
