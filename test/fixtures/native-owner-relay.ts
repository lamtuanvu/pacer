import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type Socket } from "node:net";
import type { Readable } from "node:stream";

type Frame = { id?: string | number; method?: string; params?: any; result?: any; error?: any };

/** What the relay saw: sealed calls and the child's replies, requests it forwarded to Core or refused, and dropped notifications. */
export interface Relay {
  calls: any[];
  replies: unknown[];
  forwarded: string[];
  refused: string[];
  dropped: string[];
  close(): Promise<void>;
}

function lines(stream: Readable | Socket, onFrame: (frame: Frame) => void) {
  let text = "";
  stream.on("data", (data: Buffer) => {
    text += data.toString("utf8");
    for (let cut = text.indexOf("\n"); cut >= 0; cut = text.indexOf("\n")) {
      const line = text.slice(0, cut);
      text = text.slice(cut + 1);
      if (line.trim()) onFrame(JSON.parse(line));
    }
  });
}

/**
 * A stand-in for the Rust process owner on `host.sock`: it runs the Core-sealed spawn spec as a real
 * plugin child, hellos it, sends the call, forwards the child's `coreMethods` requests back to Core on
 * the same connection, refuses every other capability request, and drops child notifications.
 */
export async function relayOwner(path: string): Promise<Relay> {
  const relay = { calls: [] as any[], replies: [] as unknown[], forwarded: [] as string[], refused: [] as string[], dropped: [] as string[] };
  const children = new Set<ChildProcess>();
  const server = createServer(socket => {
    socket.on("error", () => {});
    const send = (frame: Frame) => { if (!socket.destroyed) socket.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n"); };
    const core = new Map<string, (reply: Frame) => void>();
    let next = 0, child: ChildProcess | undefined;
    socket.on("close", () => child?.kill());
    lines(socket, frame => {
      if (frame.method !== "_host.plugin.call") { core.get(String(frame.id))?.(frame); core.delete(String(frame.id)); return; }
      const call = frame.params;
      relay.calls.push(call);
      let finished = false;
      const finish = (body: Frame) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        child?.kill();
        send({ id: frame.id, ...body });
      };
      const timer = setTimeout(() => finish({ error: { code: -32002, message: "plugin call passed its absolute deadline", data: { code: "plugin_timeout" } } }),
        call.deadlineMs ?? 30_000);
      const [file, ...args] = call.spawn.argv as string[];
      child = spawn(file!, args, { cwd: call.spawn.cwd, env: call.spawn.env, stdio: ["pipe", "pipe", "ignore"] });
      children.add(child);
      child.once("exit", () => { children.delete(child!); finish({ error: { code: -32002, message: "stdout closed", data: { code: "plugin_unavailable" } } }); });
      const toChild = (body: Frame) => { if (!finished) child!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", ...body }) + "\n"); };
      let hello: { protocol: string; served: string[] } | undefined;
      lines(child.stdout!, async message => {
        if (message.method !== undefined && message.id === undefined) { relay.dropped.push(message.method); return; }
        if (message.method !== undefined) {
          if (!call.coreMethods?.includes(message.method)) {
            relay.refused.push(message.method);
            toChild({ id: message.id, error: { code: -32000, message: `${message.method} was not issued for this call`, data: { code: "capability_denied" } } });
            return;
          }
          relay.forwarded.push(message.method);
          const id = `core-${++next}`;
          const reply = await new Promise<Frame>(done => { core.set(id, done); send({ id, method: message.method, params: message.params }); });
          toChild({ id: message.id, ...(reply.error ? { error: reply.error } : { result: reply.result }) });
          return;
        }
        if (message.id === 1) {
          if (message.error) return finish({ error: { ...message.error, data: { code: "plugin_refused" } } });
          hello = { protocol: message.result.protocol, served: message.result.contributes ?? [] };
          toChild({ id: 2, method: call.method, params: call.params,
            ...(call.spawn.hello.manifest.reentrant ? { _meta: { capabilityCall: "relay-call" } } : {}) });
          return;
        }
        if (message.id !== 2) return;
        relay.replies.push(message.error ?? message.result);
        finish(message.error ? { error: { ...message.error, data: { ...message.error.data, origin: "plugin" } } }
          : { result: { value: message.result, hello, logs: [] } });
      });
      toChild({ id: 1, method: "plugin.hello", params: call.spawn.hello });
    });
  });
  await new Promise<void>(done => server.listen(path, done));
  return { ...relay, close: async () => {
    for (const child of children) child.kill();
    await new Promise(done => server.close(done));
  } };
}
