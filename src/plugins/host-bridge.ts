/**
 * Reverse-bridge client for plugin calls under the native process owner.
 *
 * Flag-on serve exports `PACER_HOST_SOCKET` (`$PACER_HOME/run/host.sock`, 0600) and
 * owns plugin children in Rust. Core sends one line-delimited JSON-RPC request per
 * call and never spawns a plugin child itself. While the call is pending the owner
 * forwards the capability requests Core sealed in `coreMethods` on the same
 * connection; Core replies to each before the owner sends the final reply, and
 * never pipelines.
 */
import { createConnection } from "node:net";
import { z } from "zod";
import { CoreError, type CoreErrorCode } from "../core/errors";
import { pluginReplyError } from "./errors";

export const HOST_PLUGIN_CALL = "_host.plugin.call";

/** Matches `BRIDGE_MAX_LINE_BYTES` in `crates/plugin-runtime`. */
const MAX_FRAME_BYTES = 1024 * 1024;

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
  if (error.code === -32001) return new CoreError("plugin_unavailable", `native process owner at ${socketPath} refused this caller`);
  return new CoreError("plugin_unavailable", error.message);
}

/** Answers an owner request for a method Core sealed in `coreMethods`. */
export type OwnerRequestHandler = (method: string, params: unknown, request: number) => Promise<unknown>;

function callbackError(error: unknown): { code: number; message: string; data: { code: string; hint?: string } } {
  if (error instanceof CoreError) return { code: -32000, message: error.message, data: { code: error.code, ...(error.hint ? { hint: error.hint } : {}) } };
  return { code: -32000, message: "capability request failed", data: { code: "capability_denied" } };
}

/** One call per connection; the connection closes after the final reply line. */
function exchange(socketPath: string, method: string, params: unknown, signal?: AbortSignal, onRequest?: OwnerRequestHandler, revoked?: AbortSignal): Promise<unknown> {
  const id = nextId++;
  const frame = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  if (frame.length > MAX_FRAME_BYTES) return Promise.reject(new CoreError("too_large", "plugin call exceeds the 1 MiB native owner bridge frame"));
  if (signal?.aborted || revoked?.aborted) return Promise.reject(cancellation(signal, revoked));
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let chunks: Buffer[] = [];
    let size = 0, settled = false;
    const settle = (failure: CoreError | undefined, value?: unknown, flush = false) => {
      if (settled) return;
      settled = true;
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
    const abort = () => settle(cancellation(signal, revoked));
    signal?.addEventListener("abort", abort, { once: true });
    const answer = (request: z.infer<typeof rpcReply>) => {
      const respond = (body: object) => {
        if (settled) return;
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
      if (reply.method !== undefined && reply.id !== undefined && reply.id !== id) return answer(reply);
      if (reply.error) return settle(bridgeError(socketPath, reply.error));
      settle(undefined, reply.result);
    };
    socket.on("connect", () => socket.write(frame));
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

/** Call a plugin through the native owner; it starts, hellos and authorizes the child. */
export async function callNativeOwner(socketPath: string, call: NativeOwnerCall, signal?: AbortSignal, onRequest?: OwnerRequestHandler, revoked?: AbortSignal): Promise<NativeOwnerReply> {
  const result = await exchange(socketPath, HOST_PLUGIN_CALL, call, signal, onRequest, revoked);
  if ((result as { activated?: unknown } | null)?.activated === false)
    throw new CoreError("plugin_unavailable", `native process owner at ${socketPath} has not activated plugin ownership`);
  const reply = nativeOwnerReply.safeParse(result);
  if (!reply.success) throw new CoreError("plugin_unavailable", `native process owner at ${socketPath} sent a malformed reply`);
  return reply.data;
}
