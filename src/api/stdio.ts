import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import { liveSnapshot, eventsSince } from "./events";
import { callOp, type OpDeps } from "./ops";
import { helloBody, rpcError } from "./protocol";

/** Concurrent, line-delimited JSON-RPC; EOF stops events and drains requests. */
export async function runStdio(
  ctx: Ctx | (() => Ctx), input: AsyncIterable<string>, write: (line: string) => void,
  o: { opDeps?: OpDeps; pollMs?: number } = {},
): Promise<void> {
  const getCtx = typeof ctx === "function" ? ctx : () => ctx;
  const send = (message: unknown) => write(`${JSON.stringify(message)}\n`);
  const pending = new Set<Promise<void>>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let last = 0;
  const poll = () => {
    const batch = eventsSince(getCtx(), last);
    for (const event of batch.events) send({ jsonrpc: "2.0", method: "event", params: event });
    last = batch.last;
  };
  const handle = async (line: string) => {
    let request: unknown;
    try { request = JSON.parse(line); }
    catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
      return;
    }
    const r = request as Record<string, unknown>;
    const hasId = Object.hasOwn(r, "id");
    if (r.jsonrpc !== "2.0" || typeof r.method !== "string" ||
        (hasId && r.id !== null && typeof r.id !== "string" && typeof r.id !== "number")) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
      return;
    }
    try {
      let result: unknown;
      switch (r.method) {
        case "hello":
          result = helloBody();
          break;
        case "snapshot": result = await liveSnapshot(getCtx()); break;
        case "subscribe": {
          const params = r.params ?? {};
          if (typeof params !== "object" || Array.isArray(params)) throw new CoreError("invalid_input", "subscribe params must be an object");
          const since = (params as Record<string, unknown>).since ?? 0;
          if (typeof since !== "number" || !Number.isSafeInteger(since) || since < 0) throw new CoreError("invalid_input", "since must be a non-negative integer");
          clearInterval(timer);
          last = since;
          result = { subscribed: true, last: eventsSince(getCtx(), last).last };
          timer = setInterval(poll, o.pollMs ?? 500);
          break;
        }
        default: result = await callOp(getCtx(), r.method, r.params ?? {}, o.opDeps);
      }
      if (hasId) send({ jsonrpc: "2.0", id: r.id, result });
    } catch (e) {
      if (hasId) send({ jsonrpc: "2.0", id: r.id, error: rpcError(e) });
    }
  };
  try {
    for await (const line of input) {
      const task = handle(line);
      pending.add(task);
      void task.finally(() => pending.delete(task));
    }
  } finally {
    clearInterval(timer);
    await Promise.all(pending);
  }
}
