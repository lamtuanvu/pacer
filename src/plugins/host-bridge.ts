/**
 * Reverse-bridge client for plugin calls under the native process owner.
 *
 * Flag-on serve exports `PACER_HOST_SOCKET` (`$PACER_HOME/run/host.sock`, 0600) and
 * owns plugin children in Rust. Core sends one line-delimited JSON-RPC request per
 * call and never spawns a plugin child itself. While the call is pending the owner
 * forwards the capability requests Core sealed in `coreMethods` on the same
 * connection; Core replies to each before the owner sends the final reply, and
 * never pipelines.
 *
 * The owner accepts only callers that prove its per-start credential (#918, ADR
 * 0027). The owner hands it to its own Core child as `PACER_HOST_SOCKET_KEY`;
 * `takeOwnerKey` removes it from the environment before Core starts anything, so
 * no runner, executor or plugin child inherits it. Each connection opens with a
 * mutual HMAC-SHA256 challenge: Core checks the owner's proof before it sends
 * the call, so it never answers a forwarded capability request from an impostor.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createConnection } from "node:net";
import { z } from "zod";
import { CoreError, type CoreErrorCode } from "../core/errors";
import { pluginReplyError } from "./errors";

export const HOST_PLUGIN_CALL = "_host.plugin.call";
export const HOST_SOCKET_KEY_ENV = "PACER_HOST_SOCKET_KEY";
const HOST_AUTH = "_host.auth";
const OWNER_PROOF = "pacer-host-owner/v1";
const CORE_PROOF = "pacer-host-core/v1";
const HEX_KEY = /^[0-9a-f]{64}$/;

/** Matches `BRIDGE_MAX_LINE_BYTES` in `crates/plugin-runtime`. */
const MAX_FRAME_BYTES = 1024 * 1024;

let ownerKey: Buffer | undefined;

/** Take the owner's credential out of `env` (and the process environment) for this
 * process's bridge calls. Call once at startup, before anything spawns a child. */
export function takeOwnerKey(env: Record<string, string | undefined>): void {
  const text = env[HOST_SOCKET_KEY_ENV];
  delete env[HOST_SOCKET_KEY_ENV];
  delete process.env[HOST_SOCKET_KEY_ENV];
  if (text !== undefined) ownerKey = HEX_KEY.test(text) ? Buffer.from(text, "hex") : undefined;
}

/** The credential this Core holds, for its own in-process worker threads only. */
export function heldOwnerKey(): string | undefined {
  return ownerKey?.toString("hex");
}

function proof(key: Buffer, label: string, caller: string, owner: string): Buffer {
  return createHmac("sha256", key).update(`${label}\0${caller}\0${owner}`).digest();
}

function proves(key: Buffer, caller: string, owner: unknown, sent: unknown): boolean {
  if (typeof owner !== "string" || !HEX_KEY.test(owner) || typeof sent !== "string" || !HEX_KEY.test(sent)) return false;
  return timingSafeEqual(proof(key, OWNER_PROOF, caller, owner), Buffer.from(sent, "hex"));
}

/** The plugin error codes the local stdio transport keeps (`process.ts`). */
const CORE_CODES: ReadonlySet<string> = new Set<CoreErrorCode>([
  "unknown_op", "unknown_task", "invalid_input", "unknown_executor", "conflict", "not_allowed",
  "plugin_timeout", "plugin_unavailable", "plugin_refused", "capability_denied", "unknown_plugin", "not_found", "too_large",
]);

/** The error a caller sees when its call is aborted (R2): a mid-call revocation
 * of the call's Core authority reports the actual revocation reason when there is
 * a specific one, and otherwise matches flag-off's owning-plugin-call-ended
 * error (plugin stop, exit or observation/planner configuration change all revoke
 * the authority without a grant-specific reason). A CoreError abort reason is
 * kept, and anything else stays the generic cancellation. */
function cancellation(signal: AbortSignal | undefined, revoked: AbortSignal | undefined): CoreError {
  if (revoked?.aborted) {
    const reason = revoked.reason;
    // The default `revoke()` reason ("owning plugin call expired") just means the
    // owning call ended; report it the same way flag-off's `process.ts` abort()
    // does. A specific reason (for example a genuine grant revocation) wins.
    if (reason instanceof CoreError && !(reason.code === "capability_denied" && reason.message === "owning plugin call expired"))
      return reason;
    return new CoreError("plugin_unavailable", "owning plugin call ended");
  }
  if (signal?.reason instanceof CoreError) return signal.reason;
  return new CoreError("plugin_timeout", "plugin call was cancelled");
}

/** Core-sealed call: `spawn` is `nativeSpawnSpec`, `authority` is `nativeIssueCallAuthority`. */
export interface NativeOwnerCall {
  id: string;
  method: string;
  params: unknown;
  deadlineMs?: number;
  spawn: unknown;
  authority: unknown;
  scopeRoots: { home: string; pacerHome: string; accountHome: string | null };
  /** Core's minimal environment for issued commands without their own environment. */
  processEnv?: Record<string, string>;
  /** Capability methods the owner forwards to Core on this connection instead of answering them. */
  coreMethods?: string[];
  /** Hello features the child must have negotiated; otherwise the owner refuses before sending the method. */
  requireFeatures?: string[];
}

/** Whether a sealed call fits the bridge frame. */
export function nativeOwnerCallFits(call: NativeOwnerCall): boolean {
  return Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: Number.MAX_SAFE_INTEGER, method: HOST_PLUGIN_CALL, params: call })) + 1 <= MAX_FRAME_BYTES;
}

const nativeOwnerReply = z.object({
  value: z.unknown(),
  hello: z.object({ protocol: z.string(), served: z.array(z.string()) }).nullable(),
  // Call-scoped `capability.log` lines; a bare string is an older owner's line.
  logs: z.array(z.union([
    z.string(),
    z.object({ level: z.enum(["debug", "info", "warn", "error"]), message: z.string() }),
  ])).default([]),
});
export type NativeOwnerReply = z.infer<typeof nativeOwnerReply>;

const rpcReply = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({
    code: z.number(),
    message: z.string(),
    data: z.object({ code: z.string().optional(), hint: z.string().optional(), origin: z.string().optional() }).passthrough().optional(),
  }).optional(),
});

let nextId = 1;

/** An owner that cannot prove this Core's key: a restarted service drew a new one, or the socket is not this Core's owner. */
const UNPROVEN_HINT = "If the pacer service restarted, reconnect: each start issues a new credential. Otherwise this socket is not this connection's plugin owner.";

function unreachable(socketPath: string, detail: string): CoreError {
  return new CoreError("plugin_unavailable", `native process owner socket ${socketPath} is unreachable: ${detail}`,
    "Restart the pacer service.");
}

function bridgeError(socketPath: string, error: NonNullable<z.infer<typeof rpcReply>["error"]>): CoreError {
  // The owner tags a relayed child error reply; it is the plugin's failure, never pacer's own.
  if (error.data?.origin === "plugin") return pluginReplyError(error);
  const sealed = error.data?.code;
  if (sealed && CORE_CODES.has(sealed)) return new CoreError(sealed as CoreErrorCode, error.message, error.data?.hint);
  if (error.code === -32600 || error.code === -32602) return new CoreError("invalid_input", error.message);
  if (error.code === -32601) return new CoreError("plugin_unavailable", `native process owner at ${socketPath} does not serve ${HOST_PLUGIN_CALL}`);
  if (error.code === -32001) return new CoreError("plugin_unavailable", `native process owner at ${socketPath} refused this caller`,
    "Reconnect after the pacer service restarts; each owner start issues a new credential.");
  return new CoreError("plugin_unavailable", error.message);
}

/** Answers an owner request for a method Core sealed in `coreMethods`. */
export type OwnerRequestHandler = (method: string, params: unknown, request: number) => Promise<unknown>;

function callbackError(error: unknown): { code: number; message: string; data: { code: string; hint?: string } } {
  if (error instanceof CoreError) return { code: -32000, message: error.message, data: { code: error.code, ...(error.hint ? { hint: error.hint } : {}) } };
  return { code: -32000, message: "capability request failed", data: { code: "capability_denied" } };
}

/** How long an aborted call waits for the owner's final reply, which carries the call's logs. */
const DRAIN_MS = 1000;

/**
 * One call per connection; the connection closes after the final reply line.
 * The first line answers Core's challenge; the call is sent only after the owner proves the key.
 * `onFailed` sees the final reply of a call that fails, an aborted one's included.
 */
function exchange(socketPath: string, method: string, params: unknown, signal?: AbortSignal, onRequest?: OwnerRequestHandler, revoked?: AbortSignal,
  onFailed?: (reply: z.infer<typeof rpcReply>) => void): Promise<unknown> {
  const id = nextId++;
  const frame = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  if (frame.length > MAX_FRAME_BYTES) return Promise.reject(new CoreError("too_large", "plugin call exceeds the 1 MiB native owner bridge frame"));
  if (signal?.aborted || revoked?.aborted) return Promise.reject(cancellation(signal, revoked));
  const key = ownerKey;
  if (!key) return Promise.reject(new CoreError("plugin_unavailable", "native process owner credential is missing", "Restart the pacer service."));
  const nonce = randomBytes(32).toString("hex");
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let chunks: Buffer[] = [];
    let size = 0, settled = false, authenticated = false;
    // Set once the call is aborted: it fails with this whatever the owner answers.
    let aborted: CoreError | undefined;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const settle = (failure: CoreError | undefined, value?: unknown, flush = false) => {
      if (settled) return;
      settled = true;
      if (aborted) failure = aborted;
      clearTimeout(drain);
      signal?.removeEventListener("abort", abort);
      // Flush the chunk error answer, then close even if the peer keeps reading.
      if (flush) {
        const timer = setTimeout(() => socket.destroy(), 1000);
        timer.unref();
        socket.once("close", () => clearTimeout(timer));
        socket.end(() => socket.destroy());
      } else socket.destroy();
      if (failure) reject(failure); else resolve(value);
    };
    // Shutting down the write side cancels the call on the owner, which still sends its final reply.
    // Before the handshake ends no call was sent, so there is no reply to wait for.
    const abort = () => {
      if (settled || aborted) return;
      aborted = cancellation(signal, revoked);
      if (!authenticated || !onFailed) return settle(aborted);
      drain = setTimeout(() => settle(aborted), DRAIN_MS);
      socket.end();
    };
    signal?.addEventListener("abort", abort, { once: true });
    const answer = (request: z.infer<typeof rpcReply>) => {
      const respond = (body: object) => {
        if (settled || aborted) return;
        const line = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...body }) + "\n");
        if (line.length > MAX_FRAME_BYTES) socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: callbackError(new CoreError("too_large", "capability reply exceeds the 1 MiB bridge frame")) }) + "\n");
        else socket.write(line);
      };
      const chunkRequest = (request.params as { request?: unknown })?.request;
      const staleChunk = request.method === "$/resultChunk" && typeof chunkRequest === "number" && chunkRequest !== id;
      if (staleChunk) {
        respond({ error: callbackError(new CoreError("capability_denied", "result chunk does not belong to an active negotiated request")) });
        return;
      }
      if (!onRequest) {
        const error = new CoreError("capability_denied", `${request.method} is not served by Core for this call`);
        respond({ error: callbackError(error) });
        if (request.method === "$/resultChunk") settle(error, undefined, true);
        return;
      }
      onRequest(request.method!, request.params ?? {}, id).then(result => respond({ result }), error => {
        respond({ error: callbackError(error) });
        if (request.method === "$/resultChunk") settle(error instanceof CoreError ? error : new CoreError("plugin_refused", "result chunk transfer failed"), undefined, true);
      });
    };
    const line = (bytes: Buffer) => {
      let reply: z.infer<typeof rpcReply>;
      try {
        const parsed = rpcReply.safeParse(JSON.parse(bytes.toString("utf8")));
        if (!parsed.success) throw new Error("malformed");
        reply = parsed.data;
      } catch {
        return settle(new CoreError("plugin_unavailable", `native process owner at ${socketPath} sent a malformed reply`));
      }
      if (!authenticated) {
        if (reply.error) return settle(bridgeError(socketPath, reply.error));
        const challenge = reply.result as { nonce?: unknown; proof?: unknown } | undefined;
        if (reply.id !== "auth" || !proves(key, nonce, challenge?.nonce, challenge?.proof))
          return settle(new CoreError("plugin_unavailable", `native process owner at ${socketPath} failed authentication`, UNPROVEN_HINT));
        authenticated = true;
        const coreProof = proof(key, CORE_PROOF, nonce, challenge!.nonce as string).toString("hex");
        socket.write(JSON.stringify({ jsonrpc: "2.0", method: HOST_AUTH, params: { proof: coreProof } }) + "\n");
        socket.write(frame);
        return;
      }
      if (reply.method !== undefined && reply.id !== undefined && reply.id !== id) return aborted ? undefined : answer(reply);
      if (reply.error || aborted) onFailed?.(reply);
      if (reply.error) return settle(bridgeError(socketPath, reply.error));
      settle(undefined, reply.result);
    };
    socket.on("connect", () => socket.write(JSON.stringify({ jsonrpc: "2.0", id: "auth", method: HOST_AUTH, params: { nonce } }) + "\n"));
    socket.on("error", (error: NodeJS.ErrnoException) => settle(unreachable(socketPath, error.code ?? error.message)));
    socket.on("close", () => settle(new CoreError("plugin_unavailable", `native process owner socket ${socketPath} closed without a reply`, "Restart the pacer service.")));
    socket.on("data", (data: Buffer) => {
      while (!settled) {
        const cut = data.indexOf(0x0a);
        size += cut < 0 ? data.length : cut;
        if (size > MAX_FRAME_BYTES) return settle(new CoreError("too_large", "native owner reply exceeds the 1 MiB bridge frame"));
        if (cut < 0) { chunks.push(data); return; }
        chunks.push(data.subarray(0, cut));
        const bytes = Buffer.concat(chunks);
        chunks = []; size = 0; data = data.subarray(cut + 1);
        line(bytes);
      }
    });
  });
}

/**
 * Call a plugin through the native owner; it starts, hellos and authorizes the child.
 * `onFailedLogs` gets the `capability.log` lines of a call that fails after the owner answered.
 */
export async function callNativeOwner(socketPath: string, call: NativeOwnerCall, signal?: AbortSignal, onRequest?: OwnerRequestHandler, revoked?: AbortSignal,
  onFailedLogs?: (logs: NativeOwnerReply["logs"]) => void): Promise<NativeOwnerReply> {
  const result = await exchange(socketPath, HOST_PLUGIN_CALL, call, signal, onRequest, revoked, onFailedLogs && (reply => {
    const logs = nativeOwnerReply.shape.logs.safeParse(reply.error ? reply.error.data?.logs : (reply.result as { logs?: unknown } | null)?.logs);
    if (logs.success && logs.data.length) onFailedLogs(logs.data);
  }));
  if ((result as { activated?: unknown } | null)?.activated === false)
    throw new CoreError("plugin_unavailable", `native process owner at ${socketPath} has not activated plugin ownership`);
  const reply = nativeOwnerReply.safeParse(result);
  if (!reply.success) throw new CoreError("plugin_unavailable", `native process owner at ${socketPath} sent a malformed reply`);
  return reply.data;
}
