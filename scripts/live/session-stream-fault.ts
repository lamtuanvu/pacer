import { randomUUID } from "node:crypto";
import { constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync, closeSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Writable, Readable } from "node:stream";
import { MAX_LINE_BYTES } from "../../src/plugins/lines";
import { atomicWrite, pacerArgv, sandboxEnv, type Session } from "./core";

export type StreamFaultMode = "lost-input-ack" | "read-response-timeout";
interface Instruction { id: string; mode: StreamFaultMode }
interface Active extends Instruction {
  streamId: string;
  request: number;
  token: string;
  taskId: string;
  inputSeq?: number;
  writeId?: string;
  readId?: string;
  written: boolean;
  consumed: boolean;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const taskId = /^t-\d{8}-\d{6}-[a-f0-9]{4}$/;
const directory = (root: string) => join(root, "faults");
const instructionPath = (root: string) => join(directory(root), "session-stream.json");
const consumedPath = (root: string, id: string) => join(directory(root), `${id}.consumed.json`);
type Frame = { id?: unknown; method?: unknown; params?: any; result?: any; error?: unknown; _meta?: any };

/** Arm exactly one future SSH stream fault inside a disposable live sandbox. */
export function armSessionStreamFault(root: string, mode: StreamFaultMode): Instruction {
  if (!["lost-input-ack", "read-response-timeout"].includes(mode)) throw Error("unsupported session stream fault");
  mkdirSync(directory(root), { recursive: true, mode: 0o700 });
  privateDirectory(root);
  const previous = loadInstruction(root);
  if (previous && !existsSync(consumedPath(root, previous.id)))
    throw Error("previous session stream fault is still armed");
  const next = { id: randomUUID(), mode };
  atomicWrite(instructionPath(root), JSON.stringify(next) + "\n");
  return next;
}

function privateDirectory(root: string): void {
  const stat = lstatSync(directory(root));
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())) throw Error("live fault directory is not private");
}

function loadInstruction(root: string): Instruction | undefined {
  const path = instructionPath(root);
  if (!existsSync(path)) return undefined;
  privateDirectory(root);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let value: Partial<Instruction>;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 512 ||
      (process.getuid && stat.uid !== process.getuid())) throw Error("live fault instruction is not private");
    value = JSON.parse(readFileSync(fd, "utf8")) as Partial<Instruction>;
  } finally { closeSync(fd); }
  if (typeof value.id !== "string" || !uuid.test(value.id) ||
    (value.mode !== "lost-input-ack" && value.mode !== "read-response-timeout") ||
    Object.keys(value).sort().join(",") !== "id,mode")
    throw Error("invalid live fault instruction");
  return value as Instruction;
}

function claimed(root: string, id: string): boolean {
  try {
    const fd = openSync(join(directory(root), `${id}.claim`), "wx", 0o600);
    closeSync(fd);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** Frame filter used only by the live pacer-ssh stdio proxy. No frame contents are logged. */
export class SessionStreamFaultFilter {
  private active?: Active;
  constructor(private root: string) {}

  line(direction: "host-to-plugin" | "plugin-to-host", line: string): string | null {
    if (Buffer.byteLength(line) > 1024 * 1024) throw Error("live plugin frame exceeds protocol bound");
    let frame: Frame;
    try { frame = JSON.parse(line) as Frame; }
    catch { return line; }
    if (direction === "host-to-plugin" && frame.method === "hostRunner.stream" && !this.active) {
      const params = frame.params, token = frame._meta?.capabilityCall;
      const remote = params?.args?.[0], match = typeof remote === "string"
        ? /\/\.pacer-remote\/runs\/(t-\d{8}-\d{6}-[a-f0-9]{4})\/[1-9][0-9]*$/.exec(remote) : null;
      if (typeof frame.id === "number" && Number.isSafeInteger(frame.id) &&
        params?.script === "SESSION_PIPE" && typeof params?.streamId === "string" &&
        uuid.test(params.streamId) && typeof token === "string" && token.length > 0 &&
        match && taskId.test(match[1]!)) {
        const instruction = loadInstruction(this.root);
        if (instruction && claimed(this.root, instruction.id))
          this.active = { ...instruction, streamId: params.streamId, request: frame.id,
            token, taskId: match[1]!, written: false, consumed: false };
      }
    }
    const active = this.active;
    if (!active || active.consumed) return line;
    if (direction === "host-to-plugin") {
      if (frame.method === "$/streamInput" && frame.params?.streamId === active.streamId &&
        frame.params?.request === active.request && Number.isSafeInteger(frame.params?.seq)) {
        active.inputSeq = frame.params.seq;
        active.writeId = undefined;
        active.written = false;
      }
      if (active.writeId !== undefined && frame.id !== undefined && String(frame.id) === active.writeId &&
        frame.result?.bytes > 0 && frame.error === undefined) active.written = true;
      if (active.mode === "read-response-timeout" && active.readId !== undefined &&
        frame.id !== undefined && String(frame.id) === active.readId && frame.result !== undefined) {
        this.consume(active);
        return null;
      }
    } else if (frame._meta?.capabilityCall === active.token) {
      if (frame.method === "capability.process.duplex.write" && frame.id !== undefined)
        active.writeId = String(frame.id);
      if (frame.method === "capability.process.duplex.read" && frame.id !== undefined)
        active.readId = String(frame.id);
      if (active.mode === "lost-input-ack" && frame.method === "$/streamInputAck" &&
        active.written && frame.params?.streamId === active.streamId &&
        frame.params?.request === active.request && frame.params?.seq === active.inputSeq) {
        this.consume(active);
        return null;
      }
    }
    return line;
  }

  private consume(active: Active): void {
    active.consumed = true;
    const path = consumedPath(this.root, active.id);
    writeFileSync(path, JSON.stringify({ mode: active.mode, taskId: active.taskId,
      streamId: active.streamId, at: new Date().toISOString() }) + "\n", { flag: "wx", mode: 0o600 });
  }
}

/** Retain at most one protocol-sized line while respecting readable backpressure. */
export async function* boundedPluginLines(input: Readable): AsyncGenerator<string> {
  let parts: Buffer[] = [], length = 0;
  for await (const raw of input) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      if (length + part.length > MAX_LINE_BYTES) throw Error("live plugin frame exceeds protocol bound");
      if (part.length) { parts.push(Buffer.from(part)); length += part.length; }
      if (newline < 0) break;
      const line = Buffer.concat(parts, length);
      yield line.subarray(0, line.at(-1) === 13 ? -1 : undefined).toString("utf8");
      parts = []; length = 0; offset = newline + 1;
    }
  }
  if (length) yield Buffer.concat(parts, length).toString("utf8");
}

/** Live-only pass-through for the exact pacer-ssh plugin child. */
export async function runSessionStreamFaultProxy(session: Session, args: string[]): Promise<number> {
  const child = spawn(pacerArgv(session)[0]!, [...pacerArgv(session).slice(1), ...args], {
    cwd: join(session.root, "repo"), env: sandboxEnv(session),
    stdio: ["pipe", "pipe", "inherit"],
  });
  const filter = new SessionStreamFaultFilter(session.root);
  const pump = async (input: Readable, output: Writable, direction: "host-to-plugin" | "plugin-to-host") => {
    for await (const line of boundedPluginLines(input)) {
      const next = filter.line(direction, line);
      if (next !== null && !output.write(next + "\n")) await once(output, "drain");
    }
  };
  void pump(process.stdin, child.stdin, "host-to-plugin").then(() => child.stdin.end()).catch(() => child.kill("SIGTERM"));
  const output = pump(child.stdout, process.stdout, "plugin-to-host").catch(() => child.kill("SIGTERM"));
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => child.kill(signal));
  const exit = await new Promise<number>(resolve => {
    child.once("error", () => resolve(1));
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  await output;
  return exit;
}
