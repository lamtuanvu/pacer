import { callV2Op, v2Hello } from "./v2-compat";
import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import { liveSnapshot, liveV2Snapshot, eventsSince } from "./events";
import { callOp, type OpDeps } from "./ops";
import { connectClient } from "./client";
import { helloBody, rpcError } from "./protocol";

/** Concurrent, line-delimited JSON-RPC; EOF stops events and drains requests. */
export async function runStdio(
  ctx: Ctx | (() => Ctx), input: AsyncIterable<string>, write: (line: string) => void,
  o: { opDeps?: OpDeps; pollMs?: number; nativeConfigKey?: string } = {},
): Promise<void> {
  const getCtx = typeof ctx === "function" ? ctx : () => ctx;
  const send = (message: unknown) => write(`${JSON.stringify(message)}\n`);
  const pending = new Set<Promise<void>>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let last = 0;
  let protocol:2|3=2;
  const poll = () => {
    const batch = eventsSince(getCtx(), last,protocol);
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
        case "_internal.native-config.finish": {
          const key = o.nativeConfigKey;
          if (!key || !r.params || typeof r.params !== "object" || (r.params as {key?: unknown}).key !== key || getCtx().env.PACER_WORK_GRANT) {
            throw new CoreError("unknown_op", "unknown operation");
          }
          const {finishNativeConfigEdit} = await import("../core/accounts");
          await finishNativeConfigEdit(getCtx(), (r.params as {op?: unknown}).op);
          result = null;
          break;
        }
        case "_internal.status-broker.parts": {
          const key = o.nativeConfigKey;
          if (!key || !r.params || typeof r.params !== "object" || (r.params as { key?: unknown }).key !== key || getCtx().env.PACER_WORK_GRANT) {
            throw new CoreError("unknown_op", "unknown operation");
          }
          const { computeStatus } = await import("../engine/status");
          const { loadStrategy } = await import("../config/strategy");
          const ctx = getCtx();
          const status = await computeStatus(ctx, loadStrategy(ctx));
          result = { accounts: status.accounts, providers: status.providers };
          break;
        }
        case "_internal.session-probe.parts": {
          const key = o.nativeConfigKey;
          if (!key || !r.params || typeof r.params !== "object" || (r.params as { key?: unknown }).key !== key || getCtx().env.PACER_WORK_GRANT) {
            throw new CoreError("unknown_op", "unknown operation");
          }
          const { sessionProbeParts } = await import("./session-probe-bridge");
          result = sessionProbeParts(getCtx());
          break;
        }
        case "_internal.config-host.parts": {
          const key = o.nativeConfigKey;
          if (!key || !r.params || typeof r.params !== "object" || (r.params as { key?: unknown }).key !== key || getCtx().env.PACER_WORK_GRANT) {
            throw new CoreError("unknown_op", "unknown operation");
          }
          const { configHostParts } = await import("./config-host-bridge");
          result = configHostParts(getCtx());
          break;
        }
        case "_internal.host-read.parts": {
          const key = o.nativeConfigKey;
          if (!key || !r.params || typeof r.params !== "object" || (r.params as { key?: unknown }).key !== key || getCtx().env.PACER_WORK_GRANT) {
            throw new CoreError("unknown_op", "unknown operation");
          }
          const alias = (r.params as { alias?: unknown }).alias;
          const { hostReadParts, hostReadDetailParts } = await import("./host-read-bridge");
          if (typeof alias === "string" && alias) {
            result = await hostReadDetailParts(getCtx(), alias);
          } else {
            result = hostReadParts(getCtx());
          }
          break;
        }
        case "_internal.task-read.parts": {
          const key = o.nativeConfigKey;
          if (!key || !r.params || typeof r.params !== "object" || (r.params as { key?: unknown }).key !== key || getCtx().env.PACER_WORK_GRANT) {
            throw new CoreError("unknown_op", "unknown operation");
          }
          const id = (r.params as { id?: unknown }).id;
          if (typeof id !== "string" || !id) throw new CoreError("invalid_input", "id required");
          const { taskReadParts } = await import("./task-read-bridge");
          result = await taskReadParts(getCtx(), id);
          break;
        }
        case "_internal.snapshot-probe.parts": {
          const key = o.nativeConfigKey;
          if (!key || !r.params || typeof r.params !== "object" || (r.params as { key?: unknown }).key !== key || getCtx().env.PACER_WORK_GRANT) {
            throw new CoreError("unknown_op", "unknown operation");
          }
          const { snapshotProbeParts } = await import("./snapshot-probe-bridge");
          result = await snapshotProbeParts(getCtx());
          break;
        }
        case "_internal.task-wait.probe": {
          const key = o.nativeConfigKey;
          if (!key || !r.params || typeof r.params !== "object" || (r.params as { key?: unknown }).key !== key || getCtx().env.PACER_WORK_GRANT) {
            throw new CoreError("unknown_op", "unknown operation");
          }
          const id = (r.params as { id?: unknown }).id;
          if (typeof id !== "string" || !id) throw new CoreError("invalid_input", "id required");
          const { taskWaitProbe } = await import("./task-wait-bridge");
          result = taskWaitProbe(getCtx(), id);
          break;
        }
        case "_internal.task-stop.probe": {
          const key = o.nativeConfigKey;
          if (!key || !r.params || typeof r.params !== "object" || (r.params as { key?: unknown }).key !== key || getCtx().env.PACER_WORK_GRANT) {
            throw new CoreError("unknown_op", "unknown operation");
          }
          const id = (r.params as { id?: unknown }).id;
          if (typeof id !== "string" || !id) throw new CoreError("invalid_input", "id required");
          const { taskStopProbe } = await import("./task-stop-bridge");
          result = taskStopProbe(getCtx(), id);
          break;
        }
        case "_internal.task-stop.effects": {
          const key = o.nativeConfigKey;
          if (!key || !r.params || typeof r.params !== "object" || (r.params as { key?: unknown }).key !== key || getCtx().env.PACER_WORK_GRANT) {
            throw new CoreError("unknown_op", "unknown operation");
          }
          const id = (r.params as { id?: unknown }).id;
          const beforeState = (r.params as { beforeState?: unknown }).beforeState;
          if (typeof id !== "string" || !id) throw new CoreError("invalid_input", "id required");
          const { taskStopAfterStore } = await import("./task-stop-bridge");
          result = await taskStopAfterStore(getCtx(), id, typeof beforeState === "string" ? beforeState : null);
          break;
        }
        case "_internal.task-review.probe": {
          const key = o.nativeConfigKey;
          if (!key || !r.params || typeof r.params !== "object" || (r.params as { key?: unknown }).key !== key || getCtx().env.PACER_WORK_GRANT) {
            throw new CoreError("unknown_op", "unknown operation");
          }
          const probeParams = (r.params as { params?: unknown }).params;
          if (!probeParams || typeof probeParams !== "object" || Array.isArray(probeParams)) {
            throw new CoreError("invalid_input", "params required");
          }
          const id = (probeParams as { id?: unknown }).id;
          if (typeof id !== "string" || !id) throw new CoreError("invalid_input", "id required");
          const { taskReviewProbe } = await import("./task-review-bridge");
          result = taskReviewProbe(getCtx(), id, probeParams as { verdict?: unknown; expect_state?: unknown });
          break;
        }
        case "_internal.task-review.effects": {
          const key = o.nativeConfigKey;
          if (!key || !r.params || typeof r.params !== "object" || (r.params as { key?: unknown }).key !== key || getCtx().env.PACER_WORK_GRANT) {
            throw new CoreError("unknown_op", "unknown operation");
          }
          const id = (r.params as { id?: unknown }).id;
          const verdict = (r.params as { verdict?: unknown }).verdict;
          const kind = (r.params as { kind?: unknown }).kind;
          const note = (r.params as { note?: unknown }).note;
          if (typeof id !== "string" || !id) throw new CoreError("invalid_input", "id required");
          if (verdict !== "accept" && verdict !== "reject") throw new CoreError("invalid_input", "verdict required");
          const { taskReviewAfterStore } = await import("./task-review-bridge");
          result = await taskReviewAfterStore(
            getCtx(),
            id,
            verdict,
            typeof kind === "string" ? kind : undefined,
            typeof note === "string" ? note : undefined,
          );
          break;
        }
        case "_internal.task-auto-clean": {
          const key = o.nativeConfigKey;
          if (!key || !r.params || typeof r.params !== "object" || (r.params as { key?: unknown }).key !== key || getCtx().env.PACER_WORK_GRANT) {
            throw new CoreError("unknown_op", "unknown operation");
          }
          const ids = (r.params as { ids?: unknown }).ids;
          if (!Array.isArray(ids) || ids.some(id => typeof id !== "string")) throw new CoreError("invalid_input", "ids required");
          const { taskAutoCleanBridge } = await import("./task-clean-bridge");
          result = await taskAutoCleanBridge(getCtx(), ids);
          break;
        }
        case "_internal.msg.effects": {
          const key = o.nativeConfigKey;
          if (!key || !r.params || typeof r.params !== "object" || (r.params as { key?: unknown }).key !== key || getCtx().env.PACER_WORK_GRANT) {
            throw new CoreError("unknown_op", "unknown operation");
          }
          const { msgEffectsBridge } = await import("./msg-bridge");
          result = await msgEffectsBridge(getCtx(), (r.params as { request?: unknown }).request, o.opDeps?.spawnRunner);
          break;
        }
        case "_internal.task-send": {
          const key = o.nativeConfigKey;
          if (!key || !r.params || typeof r.params !== "object" || (r.params as { key?: unknown }).key !== key || getCtx().env.PACER_WORK_GRANT) {
            throw new CoreError("unknown_op", "unknown operation");
          }
          const { taskSendBridge } = await import("./task-send-bridge");
          result = await taskSendBridge(getCtx(), (r.params as { request?: unknown }).request);
          break;
        }
        case "_internal.setup.effects": {
          const key = o.nativeConfigKey;
          if (!key || !r.params || typeof r.params !== "object" || (r.params as { key?: unknown }).key !== key || getCtx().env.PACER_WORK_GRANT) {
            throw new CoreError("unknown_op", "unknown operation");
          }
          const { setupEffectsBridge } = await import("./setup-bridge");
          result = await setupEffectsBridge(getCtx(), (r.params as { request?: unknown }).request, o.opDeps);
          break;
        }
        case "_internal.setup.check": {
          const key = o.nativeConfigKey;
          if (!key || !r.params || typeof r.params !== "object" || (r.params as { key?: unknown }).key !== key || getCtx().env.PACER_WORK_GRANT) {
            throw new CoreError("unknown_op", "unknown operation");
          }
          const snapshotProbe = (r.params as { snapshotProbe?: unknown }).snapshotProbe;
          const { setupCheckBridge } = await import("./setup-check-bridge");
          result = await setupCheckBridge(getCtx(), typeof snapshotProbe === "boolean" ? snapshotProbe : false);
          break;
        }
        case "hello": {
          const params=r.params??{};
          if(!params||typeof params!=="object"||Array.isArray(params))throw new CoreError("invalid_input","hello params must be an object");
          const version=(params as Record<string,unknown>).protocol??2;
          if(version!==2&&version!==3)throw new CoreError("invalid_input","protocol must be 2 or 3");
          if(protocol!==version){clearInterval(timer);timer=undefined;last=0;}
          protocol=version;
          result = protocol===3?helloBody():v2Hello();
          break;
        }
        case "snapshot": {
          if (getCtx().env.PACER_WORK_GRANT) throw new CoreError("not_allowed", "Work grants cannot read a global snapshot");
          result = await (protocol===3?liveSnapshot:liveV2Snapshot)(getCtx()); break;
        }
        case "subscribe": {
          if (getCtx().env.PACER_WORK_GRANT) throw new CoreError("not_allowed", "Work grants cannot subscribe to global events");
          const params = r.params ?? {};
          if (typeof params !== "object" || Array.isArray(params)) throw new CoreError("invalid_input", "subscribe params must be an object");
          const since = (params as Record<string, unknown>).since ?? 0;
          if (typeof since !== "number" || !Number.isSafeInteger(since) || since < 0) throw new CoreError("invalid_input", "since must be a non-negative integer");
          clearInterval(timer);
          last = since;
          result = { subscribed: true, last: eventsSince(getCtx(), last,protocol).last };
          timer = setInterval(poll, o.pollMs ?? 500);
          break;
        }
        default: {
          if (getCtx().env.PACER_WORK_GRANT) {
            if (protocol !== 3) throw new CoreError("not_allowed", "Work grants require protocol 3");
            const client = await connectClient(getCtx(), { protocol: 3 });
            try { result = await client.call(r.method, r.params ?? {}); } finally { client.close(); }
          } else result = await (protocol===3?callOp:callV2Op)(getCtx(), r.method, r.params ?? {}, o.opDeps);
        }
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
