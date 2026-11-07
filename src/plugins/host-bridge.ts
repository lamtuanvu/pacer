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
  logs: z.array(z.string()).default([]),
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
export type OwnerRequestHandler = (method: string, params: unknown) => Promise<unknown>;

function callbackError(error: unknown): { code: number; message: string; data: { code: string; hint?: string } } {
  if (error instanceof CoreError) return { code: -32000, message: error.message, data: { code: error.code, ...(error.hint ? { hint: error.hint } : {}) } };
  return { code: -32000, message: "capability request failed", data: { code: "capability_denied" } };
}

/** One call per connection; the connection closes after the final reply line. */
function exchange(socketPath: string, method: string, params: unknown, signal?: AbortSignal, onRequest?: OwnerRequestHandler): Promise<unknown> {
  const id = nextId++;
  const frame = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  if (frame.length > MAX_FRAME_BYTES) return Promise.reject(new CoreError("too_large", "plugin call exceeds the 1 MiB native owner bridge frame"));
  if (signal?.aborted) return Promise.reject(new CoreError("plugin_timeout", "plugin call was cancelled"));
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let chunks: Buffer[] = [];
    let size = 0, settled = false;
    const settle = (failure: CoreError | undefined, value?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (failure) reject(failure); else resolve(value);
    };
    const abort = () => settle(new CoreError("plugin_timeout", "plugin call was cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    const answer = (request: z.infer<typeof rpcReply>) => {
      const respond = (body: object) => {
        if (settled) return;
        const line = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...body }) + "\n");
        if (line.length > MAX_FRAME_BYTES) socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: callbackError(new CoreError("too_large", "capability reply exceeds the 1 MiB bridge frame")) }) + "\n");
        else socket.write(line);
      };
      if (!onRequest) return respond({ error: callbackError(new CoreError("capability_denied", `${request.method} is not served by Core for this call`)) });
      onRequest(request.method!, request.params ?? {}).then(result => respond({ result }), error => respond({ error: callbackError(error) }));
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
    socket.on("close", () => settle(new CoreError("plugin_unavailable", `native process owner socket ${socketPath} closed without a reply`)));
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
export async function callNativeOwner(socketPath: string, call: NativeOwnerCall, signal?: AbortSignal, onRequest?: OwnerRequestHandler): Promise<NativeOwnerReply> {
  const result = await exchange(socketPath, HOST_PLUGIN_CALL, call, signal, onRequest);
  if ((result as { activated?: unknown } | null)?.activated === false)
    throw new CoreError("plugin_unavailable", `native process owner at ${socketPath} has not activated plugin ownership`);
  const reply = nativeOwnerReply.safeParse(result);
  if (!reply.success) throw new CoreError("plugin_unavailable", `native process owner at ${socketPath} sent a malformed reply`);
  return reply.data;
}
