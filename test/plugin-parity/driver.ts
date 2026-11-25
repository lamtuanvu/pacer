/**
 * Parity driver: run the same scripted host traffic against the TypeScript and the
 * Rust front door for a bundled plugin, and compare transcripts (M3 C0a). Shared
 * by every C1–C12b port PR.
 *
 * The driver acts as the real host over stdio: it sends `plugin.hello`, sends
 * the scripted `Step`s as JSON-RPC requests (each carrying an owning-call token),
 * and answers the plugin's requests (`capability.*`, `$/resultChunk`) from the
 * per-test `answers`. A method with no answer is denied exactly as the Rust
 * harness denies it (`capability_denied`). `$/resultChunk` gets a default
 * answer that reassembles the chunks so large results compare as their
 * un-chunked value.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { BUNDLED } from "../../src/plugins/bundled";

export interface HelloOptions {
  config?: Record<string, unknown>;
  grants?: string[];
  features?: string[];
  protocol?: string;
}
export interface Step {
  method: string;
  params: unknown;
  /** send `$/cancel` this many ms after the request */
  cancelAfterMs?: number;
  /** omit `_meta.capabilityCall` (an unowned call) */
  unowned?: boolean;
}
export interface HostErrorData {
  hint?: string;
  reason?: string;
}
export class HostError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data: HostErrorData = {},
  ) {
    super(message);
    this.name = "HostError";
  }
}
/**
 * Answer one plugin→host request; return the result, or throw `HostError` for
 * an error reply. The `send` argument lets a streaming answer push a JSON-RPC
 * message back to the plugin over stdio (e.g. `$/streamInput` frames), so the
 * driver can pump input into an owned full-session stream.
 */
export type Answer = (
  params: any,
  call: { method: string; meta: unknown },
  send: (message: Record<string, unknown>) => void,
) => unknown | Promise<unknown>;
export interface CallRecord {
  method: string;
  params: unknown;
  owned: boolean;
}
export interface StepRecord {
  result?: unknown;
  error?: { code: number; message: string; data: unknown };
}
export interface Transcript {
  hello: unknown;
  steps: StepRecord[];
  calls: CallRecord[];
  notifications: { method: string; params: unknown }[];
  exit: number | null;
  stderr: string;
}

const repo = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
const runner = join(repo, "examples", "plugins", "run.ts");

/** The six features the registry offers every plugin (src/plugins/registry.ts, hello). */
export const REGISTRY_FEATURES = [
  "chunkedResults",
  "httpBodyChunks",
  "fileWriteChunks",
  "plannerInstallTransactions",
  "policyObservations",
  "policyRedactionMetadata",
] as const;

/** Mirror the TS `requires_capability_call` list in crates/plugin-sdk/src/testing.rs:74-91. */
export function owned(method: string): boolean {
  return (
    method === "capability.fs.read" ||
    method === "capability.fs.write" ||
    method === "capability.process.spawn" ||
    method === "capability.usage.state" ||
    method === "capability.net.http" ||
    method === "capability.secrets.check" ||
    method === "capability.hosts" ||
    method === "capability.worktree" ||
    method === "capability.orca" ||
    method === "capability.assistant.tool" ||
    method.startsWith("capability.fs.") ||
    method.startsWith("capability.process.") ||
    method.startsWith("capability.hosts.") ||
    method.startsWith("capability.worktree.") ||
    method.startsWith("capability.orca.")
  );
}

export function tsArgv(id: string): string[] {
  return [process.execPath, runner, id];
}

/** `[PACER_TEST_FRONT_DOOR, plugin, run, id]`; null when unset; throws when parity is required. */
export function rustArgv(id: string): string[] | null {
  const door = process.env.PACER_TEST_FRONT_DOOR;
  if (!door || door === "") {
    if (process.env.PACER_REQUIRE_PARITY === "1") {
      throw new Error("PACER_TEST_FRONT_DOOR must be set when PACER_REQUIRE_PARITY=1");
    }
    return null;
  }
  return [door, "plugin", "run", id];
}

interface Pending {
  method: string;
  resolve: (r: StepRecord) => void;
  timer: ReturnType<typeof setTimeout>;
}

class Session {
  private child!: ChildProcessWithoutNullStreams;
  private buf = "";
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private readonly chunks = new Map<string, Buffer[]>();
  private currentToken: string | null = null;
  hello: unknown = null;
  readonly steps: StepRecord[] = [];
  readonly calls: CallRecord[] = [];
  readonly notifications: { method: string; params: unknown }[] = [];
  readonly stderr: string[] = [];
  exit: number | null = null;

  constructor(
    private readonly argv: string[],
    private readonly id: string,
    private readonly answers: Record<string, Answer>,
    private readonly helloOpts: HelloOptions,
    private readonly env: Record<string, string>,
  ) {}

  async start(): Promise<void> {
    this.child = spawn(this.argv[0]!, this.argv.slice(1), {
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buf += chunk;
      let i: number;
      while ((i = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        this.receive(line);
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (c: string) => this.stderr.push(c));
    // Capture `exit` without blocking start(): the child stays alive until we
    // close stdin in finish(), so we must begin driving over stdin first.
    this.child.on("exit", (code) => {
      this.exit = code as number | null;
      if (this.exit !== null) this.flushPending();
    });
  }

  /** Resolve every still-pending request (the child exited before answering). */
  private flushPending(): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.resolve({
        error: { code: -32001, message: "parity: child exited before reply", data: {} },
      });
    }
  }

  async run(
    steps: Step[],
    bind?: (step: Step, results: StepRecord[]) => Step,
  ): Promise<Transcript> {
    this.hello = await this.request("plugin.hello", {
      protocol: this.helloOpts.protocol ?? "1.11.0",
      features: this.helloOpts.features ?? [...REGISTRY_FEATURES],
      pacer: "0.0.0-parity",
      manifest: BUNDLED.find((r) => r.manifest.id === this.id)?.manifest,
      config: this.helloOpts.config ?? {},
      grants: this.helloOpts.grants ?? [],
    });
    for (const step of steps) {
      const bound = bind ? bind(step, this.steps) : step;
      const token = bound.unowned ? undefined : `parity-${this.nextId}`;
      this.currentToken = bound.unowned ? null : token ?? null;
      const record = this.send(bound.method, bound.params, token);
      if (bound.cancelAfterMs) {
        const target = this.nextId - 1;
        setTimeout(() => this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "$/cancel", params: { id: target } })}\n`), bound.cancelAfterMs);
      }
      this.steps.push(await record);
      this.currentToken = null;
    }
    return this.finish();
  }

  private send(method: string, params: unknown, meta?: string): Promise<StepRecord> {
    const idNum = this.nextId++;
    const id = idNum.toString();
    const body: Record<string, unknown> = { jsonrpc: "2.0", id: idNum, method, params };
    if (meta) body["_meta"] = { capabilityCall: meta };
    this.child.stdin.write(`${JSON.stringify(body)}\n`);
    return new Promise<StepRecord>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: { code: -32000, message: `parity: no reply for ${method}`, data: {} } });
      }, 5000);
      this.pending.set(id, { method, resolve, timer });
    });
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const record = await this.send(method, params);
    if (record.error) return { error: record.error };
    if (method === "plugin.hello") this.hello = record.result;
    return record.result;
  }

  private receive(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg.method === "string") {
      if ("id" in msg) {
        this.handlePluginRequest(String(msg.id), msg.method, msg.params as any, (msg["_meta"] as Record<string, unknown>) ?? {});
      } else {
        this.notifications.push({ method: msg.method, params: msg.params });
      }
      return;
    }
    if ("result" in msg || "error" in msg) this.handleResponse(msg);
  }

  private handleResponse(msg: Record<string, unknown>): void {
    const id = String(msg.id ?? "");
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (msg.error) {
      const e = msg.error as { code?: number; message?: string; data?: unknown };
      pending.resolve({
        error: {
          code: typeof e.code === "number" ? e.code : -32000,
          message: String(e.message ?? "host error"),
          data: e.data ?? msg.error,
        },
      });
      return;
    }
    if (pending.method !== "plugin.hello") {
      const result = this.reassemble(id);
      if (result !== undefined) {
        pending.resolve({ result });
        return;
      }
    }
    pending.resolve({ result: msg.result });
  }

  /** Where `$/resultChunk` gathered bytes, return the reassembled value; else undefined. */
  private reassemble(id: string): unknown | undefined {
    const chunks = this.chunks.get(id);
    if (!chunks) return undefined;
    this.chunks.delete(id);
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return undefined;
    }
  }

  private handlePluginRequest(id: string, method: string, params: any, meta: Record<string, unknown>): void {
    this.calls.push({ method, params, owned: owned(method) });
    if (method === "$/resultChunk") {
      const request = String((params as { request?: unknown }).request ?? "");
      const b64 = (params as { base64?: string }).base64 ?? "";
      const bytes = Buffer.from(b64, "base64");
      const prior = this.chunks.get(request) ?? [];
      this.chunks.set(request, [...prior, bytes]);
      this.reply(id, { bytes: prior.reduce((n, b) => n + b.length, 0) + bytes.length });
      return;
    }
    if (
      owned(method) &&
      (this.currentToken === null || (meta as { capabilityCall?: string }).capabilityCall !== this.currentToken)
    ) {
      this.replyError(id, "capability_denied", "scoped capability requires an active owning call");
      return;
    }
    const answer = this.answers[method];
    if (!answer) {
      this.replyError(id, "capability_denied", `no parity answer for ${method}`);
      return;
    }
    Promise.resolve(answer(params, { method, meta }, (message) => {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    })).then(
      (result) => this.reply(id, result),
      (error) => {
        if (error instanceof HostError) this.replyError(id, error.code, error.message, error.data);
        else this.replyError(id, "internal", String(error));
      },
    );
  }

  private reply(id: string, result: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }
  private replyError(id: string, code: string, message: string, data: HostErrorData = {}): void {
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message, data: { code, ...data } } })}\n`,
    );
  }

  private async finish(): Promise<Transcript> {
    this.child.stdin.end();
    if (this.exit === null) this.exit = await new Promise((r) => this.child.once("exit", (c) => r(c as number | null)));
    return {
      hello: this.hello,
      steps: this.steps,
      calls: this.calls,
      notifications: this.notifications,
      exit: this.exit,
      stderr: this.stderr.join(""),
    };
  }
}

/** A fresh sandboxed environment for one drive, so the plugin child is isolated. */
function childEnv(env: Record<string, string | undefined>): Record<string, string> {
  const base = mkdtempSync(join(tmpdir(), "pacer-parity-home-"));
  return {
    ...env,
    HOME: base,
    PACER_HOME: join(base, ".pacer"),
    PATH: env.PATH ?? "",
    PACER_NO_UPDATE_CHECK: "1",
    TZ: "Asia/Ho_Chi_Minh",
  };
}

export async function drive(
  argv: string[],
  id: string,
  steps: Step[],
  answers: Record<string, Answer>,
  hello: HelloOptions = {},
  _normalize?: (t: Transcript) => Transcript,
  bind?: (step: Step, results: StepRecord[]) => Step,
): Promise<Transcript> {
  const session = new Session(argv, id, answers, hello, childEnv(process.env));
  await session.start();
  return session.run(steps, bind);
}

/**
 * Run the same scenario through the TypeScript CLI and, when a front door is
 * configured, through the Rust door. Without a front door the Rust side is the
 * TypeScript transcript, which the caller skips via `test.skipIf(!rustArgv(id))`.
 */
export async function parity(
  id: string,
  steps: Step[],
  answers: Record<string, Answer>,
  hello: HelloOptions = {},
  normalize: (t: Transcript) => Transcript = (t) => t,
  bind?: (step: Step, results: StepRecord[]) => Step,
): Promise<{ ts: Transcript; rust: Transcript }> {
  const ts = await drive(tsArgv(id), id, steps, answers, hello, undefined, bind);
  const door = rustArgv(id);
  const rust = door ? await drive(door, id, steps, answers, hello, undefined, bind) : ts;
  return { ts: normalize(ts), rust: normalize(rust) };
}
