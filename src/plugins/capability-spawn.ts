import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync, statSync, type Stats } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
import { CoreError } from "../core/errors";
import type { CallAuthority } from "./authority";
import { resolveBoundCredential } from "./credential-bindings";
import { secretReference } from "./http-protocol";

const MAX_OUTPUT = 1048576, MAX_CHUNK = 262144;
const CODEX_LIVE_ARGV = ["codex", "-s", "read-only", "-a", "never", "app-server"];
const CODEX_LIVE_REQUEST = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "pacer", version: "1" }, capabilities: {} } },
  { jsonrpc: "2.0", method: "initialized", params: {} },
  { jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} },
].map(value => JSON.stringify(value)).join("\n") + "\n";
interface Pin {
  argv: readonly string[];
  timeoutMs: number;
  mode?: "codex-live" | "prepare-bundle";
  input?: Uint8Array;
  selected: string | null;
  canonical?: string;
  stat?: Stats;
  link?: Stats;
  context?: {
    cwd?: string;
    canonicalCwd?: string;
    cwdLink?: Stats;
    cwdStat?: Stats;
    env: Readonly<Record<string, string>>;
    secretEnv: Readonly<Record<string, string>>;
  };
}
interface State { pins: Pin[]; busy: boolean; liveUsed: boolean; prepareUsed: boolean; output: Map<string, Buffer>; cleanupFailure?: Error }
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
    const pin: Pin = { argv: command.argv, timeoutMs: command.timeoutMs, selected, mode: command.mode };
    if (command.mode === "prepare-bundle") {
      if (!(command.input instanceof Uint8Array) || command.input.length > 50 * 1024 * 1024 ||
        command.inputSha256 !== createHash("sha256").update(command.input).digest("hex") ||
        command.argv[0] !== "ssh" || command.cwd !== undefined || command.env !== undefined ||
        command.secretEnv !== undefined || command.timeoutMs > 60_000)
        deny("remote prepare input was not issued by the host");
      pin.input = Uint8Array.from(command.input!);
    } else if (command.input !== undefined || command.inputSha256 !== undefined) {
      deny("provider input requires host-issued remote prepare");
    }
    if (command.mode === "codex-live" &&
      (JSON.stringify(command.argv) !== JSON.stringify(CODEX_LIVE_ARGV) ||
        !authority.accountHome || !isAbsolute(authority.accountHome) ||
        command.env?.CODEX_HOME !== authority.accountHome || command.cwd !== undefined ||
        command.secretEnv !== undefined || command.timeoutMs > 15_000))
      deny("Codex live command was not issued for this account");
    if (command.cwd !== undefined || command.env !== undefined || command.secretEnv !== undefined) {
      const env = command.env ?? {}, secretEnv = command.secretEnv ?? {};
      for (const [key, value] of Object.entries(env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0")) invalid("invalid issued provider environment");
      }
      for (const [key, ref] of Object.entries(secretEnv)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || Object.hasOwn(env, key) || !secretReference.safeParse(ref).success) invalid("invalid issued provider secret environment");
      }
      pin.context = { env, secretEnv };
      if (command.cwd !== undefined) {
        if (!isAbsolute(command.cwd)) invalid("issued provider cwd must be absolute");
        pin.context.cwd = command.cwd;
        pin.context.canonicalCwd = realpathSync(command.cwd);
        pin.context.cwdLink = lstatSync(command.cwd);
        pin.context.cwdStat = statSync(pin.context.canonicalCwd);
        if (!pin.context.cwdStat.isDirectory()) invalid("issued provider cwd must be a directory");
      }
    }
    if (selected) {
      if (!isAbsolute(selected)) deny("provider executable must be absolute");
      pin.canonical = realpathSync(selected); pin.link = lstatSync(selected); pin.stat = statSync(pin.canonical);
      if (!pin.stat.isFile() || !(pin.stat.mode & 0o111)) deny("provider executable is not executable");
    }
    return pin;
  });
  const state: State = { pins, busy: false, liveUsed: false, prepareUsed: false, output: new Map() };
  states.set(authority, state);
  authority.onRevoke(() => { state.output.clear(); });
}

function stateOf(authority: CallAuthority): State {
  authority.assertGranted("process.spawn");
  return states.get(authority) ?? deny("provider executable was not pinned at call issuance");
}
/** Private owner cleanup: retiring output never grants or renews process authority. */
export function discardSpawnOutput(authority: CallAuthority): void {
  states.get(authority)?.output.clear();
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
  if (Object.keys(params).some(key => !["argv", "timeoutMs", "env", "cwd"].includes(key))) invalid("provider stdin and other overrides are unavailable");
  const { argv, timeoutMs } = params;
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 32 || argv.some(arg => typeof arg !== "string" || arg.length > 4096 || arg.includes("\0")) || !Number.isSafeInteger(timeoutMs) || (timeoutMs as number) <= 0) invalid("invalid provider command");
  const args = argv as string[];
  if (!declaredScopes.includes(args[0]!) || args[0] === "*" || isAbsolute(args[0]!)) deny("provider command is not declared");
  const candidates = state.pins.filter(pin => JSON.stringify(pin.argv) === JSON.stringify(argv));
  if (!candidates.length) deny("provider command is not owned by this call");
  if (candidates.every(pin => !pin.context) && (Object.hasOwn(params, "env") || Object.hasOwn(params, "cwd"))) invalid("provider env and cwd overrides are unavailable");
  const pin = candidates.find(candidate => (candidate.mode === "codex-live"
    ? !Object.hasOwn(params, "env") && !Object.hasOwn(params, "cwd")
    : contextMatches(candidate, params)) && (timeoutMs as number) <= candidate.timeoutMs)
    ?? deny("provider command context or timeout is not owned by this call");
  if (pin.mode === "codex-live") {
    if (state.liveUsed) deny("Codex live command already used by this call");
    state.liveUsed = true;
  }
  if (pin.mode === "prepare-bundle") {
    if (state.prepareUsed) deny("remote prepare command already used by this call");
    state.prepareUsed = true;
  }
  if (Object.keys(pin.context?.secretEnv ?? {}).length) authority.assertGranted("secrets.resolve");
  if ((timeoutMs as number) > pin.timeoutMs) deny("provider timeout exceeds owning call");
  if (state.busy) deny("owning call already has a provider child");
  // Only the latest invocation's two outputs survive, bounding retained output per call.
  state.output.clear();
  if (!pin.selected) return { code: 127, stdout: "", stderr: `${args[0]} not found`, timedOut: false };
  validatePin(pin);
  authority.assertActive(); state.busy = true;
  try {
    const env: Record<string, string> | undefined = pin.context ? Object.assign(Object.create(null), pin.context.env) : undefined;
    const secrets: string[] = [];
    for (const [name, ref] of Object.entries(pin.context?.secretEnv ?? {})) {
      const resolved = await resolveBoundCredential(authority, ref);
      const value = resolved.bound ? resolved.value : null;
      if (!value || value.includes("\0")) deny("provider credential is unavailable");
      env![name] = value!;
      secrets.push(value!);
    }
    authority.assertActive();
    validatePin(pin);
    return await run(authority, state, pin, argv as string[], timeoutMs as number, env, secrets);
  } finally { state.busy = false; }
}

function contextMatches(pin: Pin, params: Record<string, unknown>): boolean {
  if (!pin.context) return !Object.hasOwn(params, "env") && !Object.hasOwn(params, "cwd");
  if (params.cwd !== pin.context.cwd) return false;
  const supplied = params.env;
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) return false;
  const expected = {
    ...pin.context.env,
    ...Object.fromEntries(Object.entries(pin.context.secretEnv).map(([key, secretRef]) => [key, { secretRef }])),
  };
  const record = supplied as Record<string, unknown>;
  if (Object.keys(record).length !== Object.keys(expected).length) return false;
  return Object.entries(expected).every(([key, value]) => {
    if (!Object.hasOwn(record, key)) return false;
    const actual = record[key];
    if (typeof value === "string") return actual === value;
    return !!actual && typeof actual === "object" && !Array.isArray(actual)
      && Object.keys(actual).length === 1 && Object.hasOwn(actual, "secretRef")
      && (actual as { secretRef: unknown }).secretRef === value.secretRef;
  });
}

function validatePin(pin: Pin): void {
  try {
    if (realpathSync(pin.selected!) !== pin.canonical || !same(lstatSync(pin.selected!), pin.link!) || !same(statSync(pin.canonical!), pin.stat!)) deny("provider executable changed since call issuance");
    const context = pin.context;
    if (context?.cwd) {
      const link = lstatSync(context.cwd), target = statSync(context.canonicalCwd!);
      const identity = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
      if (realpathSync(context.cwd) !== context.canonicalCwd || !identity(link, context.cwdLink!) || !identity(target, context.cwdStat!)) deny("provider cwd changed since call issuance");
    }
  } catch (error) {
    if (error instanceof CoreError) throw error;
    deny("provider executable or cwd is unavailable");
  }
}

async function run(authority: CallAuthority, state: State, pin: Pin, argv: string[], timeoutMs: number, env?: Record<string, string>, secrets: string[] = []): Promise<unknown> {
  // Legacy commands retain their env/cwd semantics. Contextual commands receive
  // only host-issued exact env/cwd, with bound secrets resolved after admission.
  let child: ChildProcess;
  const parts: Buffer[][] = [[], []], sizes = [0, 0];
  let failure: Error | undefined, cleanupFailure: Error | undefined, terminationFailure: Error | undefined, timedOut = false, exited = false, closed = false;
  let responseBuffer = "", responseSeen = false;
  const responseDecoder = new TextDecoder();
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
    validatePin(pin);
    child = spawn(pin.canonical!, argv.slice(1), {
      stdio: [pin.mode === "codex-live" || pin.mode === "prepare-bundle" ? "pipe" : "ignore", "pipe", "pipe"], detached: process.platform !== "win32",
      ...(pin.mode === "prepare-bundle" ? { env: authority.ctx.env } : env === undefined ? {} : { env }),
      ...(pin.context?.cwd ? { cwd: pin.context.canonicalCwd } : {}),
    });
    if (pin.mode === "codex-live") {
      child.stdin?.on("error", () => { failure ??= new CoreError("plugin_unavailable", "Codex usage request input failed"); stop(); });
      child.stdin?.write(CODEX_LIVE_REQUEST);
    }
    if (pin.mode === "prepare-bundle") {
      child.stdin?.on("error", () => { failure ??= new CoreError("plugin_unavailable", "remote prepare input failed"); stop(); });
      // A bounded host-owned buffer is streamed in chunks to honor pipe backpressure.
      void (async () => {
        const input = pin.input!;
        for (let offset = 0; offset < input.length; offset += 64 * 1024) {
          if (failure || child.stdin?.destroyed) return;
          if (!child.stdin!.write(input.subarray(offset, offset + 64 * 1024))) {
            await new Promise<void>(resolve => {
              const stream = child.stdin!;
              const done = () => { stream.off("drain", done); stream.off("close", done); resolve(); };
              stream.once("drain", done); stream.once("close", done);
            });
          }
        }
        child.stdin?.end();
      })().catch(() => { failure ??= new CoreError("plugin_unavailable", "remote prepare input failed"); stop(); });
    }
  } catch (error) {
    settle(); detach();
    if (error instanceof CoreError) throw error;
    throw new CoreError("plugin_unavailable", "provider could not be started");
  }
  const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, Math.min(timeoutMs, authority.deadlineMs - Date.now())));
  for (const [index, stream] of [child.stdout, child.stderr].entries()) {
    stream!.on("error", () => { failure ??= new CoreError("plugin_unavailable", "provider output could not be read"); stop(); });
    stream!.on("data", (chunk: Buffer) => {
      if (failure || authority.signal.aborted) return;
      sizes[index]! += chunk.length;
      if (sizes[index]! > (pin.mode === "codex-live" && index === 0 ? 64_000 : MAX_OUTPUT)) {
        failure = new CoreError("too_large", "provider output exceeds per-stream limit"); stop(); return;
      }
      parts[index]!.push(Buffer.from(chunk));
      if (pin.mode === "codex-live" && index === 0 && !responseSeen) {
        responseBuffer += responseDecoder.decode(chunk, { stream: true });
        for (;;) {
          const end = responseBuffer.indexOf("\n");
          if (end < 0) break;
          const line = responseBuffer.slice(0, end); responseBuffer = responseBuffer.slice(end + 1);
          try { if (JSON.parse(line)?.id === 2) { responseSeen = true; child.stdin?.end(); break; } }
          catch { /* Diagnostics and notifications are not response id 2. */ }
        }
        if (responseBuffer.length > 64_000) responseBuffer = responseBuffer.slice(-64_000);
      }
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
  if (secrets.some(secret => stdout.includes(Buffer.from(secret)) || stderr.includes(Buffer.from(secret)))) {
    throw new CoreError("capability_denied", "provider output exposed an injected credential", undefined, { reason: "credential_reflection" });
  }
  const inline = { code, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), timedOut };
  const inlineFits = Buffer.byteLength(JSON.stringify(inline)) <= 768 * 1024;
  authority.assertActive();
  if (inlineFits) return inline;
  const out = randomUUID(), err = randomUUID(); state.output.set(out, stdout); state.output.set(err, stderr);
  return { code, output: { stdout: out, stderr: err }, timedOut };
}
