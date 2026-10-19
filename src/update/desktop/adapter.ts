import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { CoreError } from "../../core/errors";
import { isVersion } from "../version";
import type { Candidate, Installation } from "./types";

export const MAX_FRAME_BYTES = 256 * 1024;
export type HandoffState = "none" | "uncertain" | "acknowledged";
export type AdapterFailure = "unavailable" | "protocol" | "closed" | "cancelled" | "timeout" | "remote";
const messages: Record<AdapterFailure, string> = {
  unavailable: "Verified desktop update adapter is unavailable",
  protocol: "Desktop update adapter protocol was rejected",
  closed: "Desktop update adapter closed before successful completion",
  cancelled: "Desktop update adapter operation was cancelled",
  timeout: "Desktop update adapter operation timed out",
  remote: "Desktop update adapter could not complete the operation",
};
/** Private handoff classification MUST survive core error handling; uncertainty never permits releasing admission. */
export class AdapterError extends CoreError {
  constructor(public readonly reason: AdapterFailure, public readonly handoff: HandoffState = "none") {
    super("not_allowed", messages[reason], handoff === "none"
      ? "Reconnect the verified desktop and retry."
      : "Retain the reservation and reconcile the private transaction journal before retrying.");
    this.name = "AdapterError";
  }
}
const invalid = () => new AdapterError("protocol");
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.string().refine(isVersion);
const arch = z.enum(["aarch64", "x86_64"]);
const candidate = z.object({
  version, arch, sha256: hash, signature: z.string().min(1).max(8192),
  url: z.string().url().max(2048).refine(value => /^https:\/\//.test(value)),
  protocolMajors: z.array(z.number().int().positive()).min(1).max(32),
  rollbackCompatible: z.boolean(), notes: z.string().max(32768),
}).strict();
const absolutePath = z.string().min(1).max(4096).refine(value => value.startsWith("/") && !value.includes("\0"));
const installation = z.object({
  id: identifier, appPath: absolutePath, bundleId: z.literal("dev.pacer.desktop"), ownerUid: integer,
  arch, pacerHome: absolutePath, port: z.number().int().min(1).max(65535), serviceLabel: z.string().min(1).max(128),
  ownership: z.enum(["managed", "attached"]), version,
}).strict();
const binding = {
  schema: z.literal(1), commandId: identifier, installationId: identifier,
  transactionId: identifier.nullable(), revision: integer, nonce: hash,
};
const commandSchema = z.discriminatedUnion("command", [
  z.object({ ...binding, command: z.literal("check"), transactionId: z.null() }).strict(),
  z.object({ ...binding, command: z.literal("download"), transactionId: z.null(), candidate }).strict(),
  z.object({ ...binding, command: z.literal("install"), transactionId: identifier, candidate, target: installation }).strict(),
  z.object({ ...binding, command: z.literal("recover"), transactionId: identifier }).strict(),
]);
const preparation = { reservationId: identifier, journalSha256: hash };
const response = { ...binding, sequence: integer };
const frameSchema = z.discriminatedUnion("kind", [
  z.object({ ...response, kind: z.literal("hello"), version, bundleId: z.literal("dev.pacer.desktop"), arch }).strict(),
  z.object({ ...response, kind: z.literal("progress"), downloadedBytes: integer, totalBytes: integer.nullable() }).strict(),
  z.object({ ...response, kind: z.literal("checked"), candidate: candidate.nullable() }).strict(),
  z.object({ ...response, kind: z.literal("downloaded"), candidate, downloadedBytes: integer, totalBytes: integer }).strict(),
  z.object({ ...response, kind: z.literal("prepared"), ...preparation }).strict(),
  z.object({ ...response, kind: z.literal("authorized"), ...preparation }).strict(),
  z.object({ ...response, kind: z.literal("outcome"), outcome: z.enum(["committed", "restored", "recovery-failed"]) }).strict(),
  z.object({ ...response, kind: z.literal("error"), code: z.enum(["network", "signature", "compatibility", "disk", "permission", "verification", "recovery"]) }).strict(),
]);
const authorizationSchema = z.object({ ...binding, transactionId: identifier, kind: z.literal("authorize-install"), ...preparation }).strict();
export type AdapterCommand = z.infer<typeof commandSchema>;
export type AdapterRequest = { installationId: string; revision: number } & (
  | { command: "check"; transactionId: null }
  | { command: "download"; transactionId: null; candidate: Candidate }
  | { command: "install"; transactionId: string; candidate: Candidate; target: Installation }
  | { command: "recover"; transactionId: string }
);
export type AdapterFrame = z.infer<typeof frameSchema>;
export type InstallAuthorization = z.infer<typeof authorizationSchema>;
export type PreparedFrame = Extract<AdapterFrame, { kind: "prepared" }>;
export type AdapterResult = Extract<AdapterFrame, { kind: "checked" | "downloaded" | "outcome" }>;

export function parseAdapterCommand(value: unknown): AdapterCommand {
  const parsed = commandSchema.safeParse(value);
  if (!parsed.success) throw invalid();
  const command = parsed.data;
  if (command.command === "install" && (command.target.id !== command.installationId ||
      command.target.arch !== command.candidate.arch || !command.candidate.rollbackCompatible)) throw invalid();
  return command;
}
export function parseAdapterFrame(value: unknown): AdapterFrame {
  const parsed = frameSchema.safeParse(value);
  if (!parsed.success) throw invalid();
  return parsed.data;
}
export function parseInstallAuthorization(value: unknown): InstallAuthorization {
  const parsed = authorizationSchema.safeParse(value);
  if (!parsed.success || parsed.data.reservationId !== parsed.data.transactionId) throw invalid();
  return parsed.data;
}

/** Bounded length-prefixed JSON; framing is independent of native message validation. */
export function encodeFrame(value: unknown): Uint8Array {
  let json: string;
  try { json = JSON.stringify(value); } catch { throw invalid(); }
  if (typeof json !== "string" || json.length > MAX_FRAME_BYTES) throw invalid();
  const payload = new TextEncoder().encode(json);
  if (!payload.length || payload.length > MAX_FRAME_BYTES) throw invalid();
  const bytes = new Uint8Array(payload.length + 4);
  new DataView(bytes.buffer).setUint32(0, payload.length, false);
  bytes.set(payload, 4);
  return bytes;
}
export class FrameDecoder {
  private header = new Uint8Array(4);
  private headerAt = 0;
  private payload: Uint8Array | null = null;
  private payloadAt = 0;
  private failed = false;
  push(chunk: Uint8Array): unknown[] {
    if (this.failed) throw invalid();
    try {
      // Also bound a pathological single transport chunk / resulting message batch.
      if (chunk.byteLength > MAX_FRAME_BYTES * 4) throw invalid();
      const values: unknown[] = [];
      let at = 0;
      while (at < chunk.length) {
        if (!this.payload) {
          const take = Math.min(4 - this.headerAt, chunk.length - at);
          this.header.set(chunk.subarray(at, at + take), this.headerAt); at += take; this.headerAt += take;
          if (this.headerAt !== 4) continue;
          const length = new DataView(this.header.buffer).getUint32(0, false);
          if (!length || length > MAX_FRAME_BYTES) throw invalid();
          this.payload = new Uint8Array(length); this.payloadAt = 0;
        }
        const take = Math.min(this.payload.length - this.payloadAt, chunk.length - at);
        this.payload.set(chunk.subarray(at, at + take), this.payloadAt); at += take; this.payloadAt += take;
        if (this.payloadAt === this.payload.length) {
          values.push(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.payload)));
          this.payload = null; this.headerAt = 0; this.payloadAt = 0;
        }
      }
      return values;
    } catch { this.failed = true; throw invalid(); }
  }
  finish(): void {
    if (this.failed || this.headerAt || this.payload) { this.failed = true; throw invalid(); }
  }
}

/** Only a trusted composition-root provider may implement this factory. No production spawn implementation exists here. */
export interface VerifiedPipeFactory {
  readonly capabilities: ReadonlySet<AdapterCommand["command"]>;
  /** Verify OS identity/signature before returning. Signal covers acquisition only; detach listeners on return. Never use operation/env paths. */
  open(installationId: string, signal: AbortSignal): Promise<VerifiedPipe>;
}
export interface VerifiedPipe {
  /** Expected identity from local verification, NOT copied from the helper's hello. */
  readonly identity: { version: string; bundleId: string; arch: "aarch64" | "x86_64" };
  stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  /** Pre-handoff cleanup only. Must address the verified process, never a reused PID. */
  abort(): void | Promise<void>;
}
export interface AdapterOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  noProgressTimeoutMs?: number;
  onProgress?: (frame: Extract<AdapterFrame, { kind: "progress" }>) => void;
  /** Recheck live native session and durable reservation/journal; false revokes authorization. */
  authorizeInstall?: (frame: PreparedFrame, signal: AbortSignal) => Promise<boolean>;
  onAuthorized?: (frame: Extract<AdapterFrame, { kind: "authorized" }>) => void;
}

/** Returns private frames. Callers must project public status explicitly, never serialize this result wholesale. */
export async function runAdapterCommand(factory: VerifiedPipeFactory | undefined, request: AdapterRequest, options: AdapterOptions = {}): Promise<AdapterResult> {
  if (!factory || !factory.capabilities.has(request.command)) throw new AdapterError("unavailable");
  if (request.command === "install" && !options.authorizeInstall) throw new AdapterError("unavailable");
  if (options.signal?.aborted) throw new AdapterError("cancelled");
  const command = parseAdapterCommand({ ...request, schema: 1, commandId: randomUUID(), nonce: randomBytes(32).toString("hex") });
  const timeoutMs = options.timeoutMs ?? (command.command === "check" ? 30_000 : command.command === "download" ? 1_800_000 : 600_000);
  const noProgressMs = options.noProgressTimeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_800_000 ||
      !Number.isSafeInteger(noProgressMs) || noProgressMs < 1 || noProgressMs > 1_800_000) throw invalid();
  const controller = new AbortController(), acquisition = new AbortController();
  let pipe: VerifiedPipe | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let handoff: HandoffState = "none", stopped = false, hello = false, sequence = 0;
  let phase: "initial" | "prepared" | "authorizing" | "authorized" = "initial";
  let prepared: PreparedFrame | undefined, terminal: AdapterResult | undefined;
  let eof = false, exitCode: number | undefined, downloadedBytes = 0, totalBytes: number | null = null;
  let timeout: ReturnType<typeof setTimeout> | undefined, stall: ReturnType<typeof setTimeout> | undefined;
  let resolve!: (result: AdapterResult) => void, reject!: (error: AdapterError) => void;
  const completion = new Promise<AdapterResult>((yes, no) => { resolve = yes; reject = no; });
  const cleanup = () => {
    clearTimeout(timeout); clearTimeout(stall); options.signal?.removeEventListener("abort", cancel);
    controller.abort();
    if (!pipe) acquisition.abort();
    void reader?.cancel().catch(() => {});
    void writer?.close().catch(() => {});
  };
  const fail = (reason: AdapterFailure) => {
    if (stopped) return;
    stopped = true;
    // A partial authorization write may have reached the helper. Only recovery can resolve that uncertainty.
    if (handoff === "none" && pipe) void Promise.resolve().then(() => pipe!.abort()).catch(() => {});
    cleanup(); reject(new AdapterError(reason, handoff));
  };
  const cancel = () => fail("cancelled");
  const finish = () => {
    if (stopped || !eof || exitCode === undefined) return;
    if (!terminal || exitCode !== 0) { fail("closed"); return; }
    stopped = true; cleanup(); resolve(terminal);
  };
  const progressDeadline = () => {
    clearTimeout(stall);
    if (command.command === "download") stall = setTimeout(() => fail("timeout"), noProgressMs);
  };
  const bound = (frame: AdapterFrame) => frame.schema === command.schema && frame.commandId === command.commandId &&
    frame.installationId === command.installationId && frame.transactionId === command.transactionId &&
    frame.revision === command.revision && frame.nonce === command.nonce;
  const authorize = async (frame: PreparedFrame) => {
    try {
      const allowed = await options.authorizeInstall!(structuredClone(frame), controller.signal);
      if (stopped || controller.signal.aborted) return;
      if (!allowed) { fail("cancelled"); return; }
      const continuation = parseInstallAuthorization({ schema: command.schema, commandId: command.commandId,
        installationId: command.installationId, transactionId: command.transactionId, revision: command.revision,
        nonce: command.nonce, kind: "authorize-install", reservationId: frame.reservationId, journalSha256: frame.journalSha256 });
      const bytes = encodeFrame(continuation);
      // No await between checking cancellation and marking the possible mutation boundary.
      handoff = "uncertain"; phase = "authorizing";
      await writer!.write(bytes);
    } catch { fail("closed"); }
  };
  const accept = (value: unknown) => {
    const frame = parseAdapterFrame(value);
    if (!bound(frame) || frame.sequence !== sequence++ || terminal) throw invalid();
    if (!hello) {
      if (frame.kind !== "hello" || frame.version !== pipe!.identity.version || frame.arch !== pipe!.identity.arch || frame.bundleId !== pipe!.identity.bundleId) throw invalid();
      hello = true; return;
    }
    if (frame.kind === "hello") throw invalid();
    if (frame.kind === "error") { fail("remote"); return; }
    if (frame.kind === "checked") {
      if (command.command !== "check") throw invalid();
      terminal = frame; return;
    }
    if (frame.kind === "progress" || frame.kind === "downloaded") {
      if (command.command !== "download" || frame.downloadedBytes < downloadedBytes ||
          (frame.totalBytes !== null && frame.downloadedBytes > frame.totalBytes) ||
          (totalBytes !== null && frame.totalBytes !== totalBytes)) throw invalid();
      if (frame.downloadedBytes > downloadedBytes) progressDeadline();
      downloadedBytes = frame.downloadedBytes; totalBytes = frame.totalBytes;
      if (frame.kind === "progress") { options.onProgress?.(structuredClone(frame)); return; }
      if (!frame.totalBytes || frame.downloadedBytes !== frame.totalBytes || JSON.stringify(frame.candidate) !== JSON.stringify(command.candidate)) throw invalid();
      terminal = frame; clearTimeout(stall); return;
    }
    if (frame.kind === "prepared") {
      if (command.command !== "install" || phase !== "initial" || frame.reservationId !== command.transactionId) throw invalid();
      phase = "prepared"; prepared = frame; void authorize(frame); return;
    }
    if (frame.kind === "authorized") {
      if (command.command !== "install" || phase !== "authorizing" || frame.reservationId !== prepared?.reservationId || frame.journalSha256 !== prepared?.journalSha256) throw invalid();
      handoff = "acknowledged"; phase = "authorized"; options.onAuthorized?.(structuredClone(frame)); return;
    }
    if (frame.kind === "outcome") {
      if (command.command !== "recover" && (command.command !== "install" || phase !== "authorized")) throw invalid();
      terminal = frame; return;
    }
    throw invalid();
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  timeout = setTimeout(() => fail("timeout"), timeoutMs);
  void (async () => {
    try {
      pipe = await factory.open(command.installationId, acquisition.signal);
      if (stopped) { await pipe.abort(); return; }
      reader = pipe.stdout.getReader(); writer = pipe.stdin.getWriter();
      void pipe.exited.then(code => { exitCode = code; if (code !== 0) fail("closed"); else finish(); }, () => fail("closed"));
      const decoder = new FrameDecoder();
      const read = async () => {
        try {
          while (!stopped) {
            const next = await reader!.read();
            if (stopped) return;
            if (next.done) {
              decoder.finish(); eof = true;
              if (!terminal) fail("closed"); else finish();
              return;
            }
            for (const frame of decoder.push(next.value)) { if (stopped) return; accept(frame); }
          }
        } catch { fail("protocol"); }
      };
      void read();
      const bytes = encodeFrame(command);
      // Recovery is authorized only by the helper's private recorded journal; sending this command may resume mutation.
      if (command.command === "recover") handoff = "uncertain";
      await writer.write(bytes);
      if (!stopped) progressDeadline();
    } catch { fail("closed"); }
  })();
  return completion;
}
