import { expect, test } from "bun:test";
import { handlers } from "../plugins/pacer-ssh/index";
import { sessionPipeArgv } from "../plugins/pacer-ssh/probe";
import type { HostClient } from "@pacer/plugin";

const runDir = "/home/test/.pacer-remote/runs/t-20261027-010000-abcd/1";
const streamId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const handle = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const target = "example.invalid", controlPath = "/private/cm-%C";

async function opened() {
  const result = await handlers["hostRunner.open"]!({ alias: "box", sshTarget: target, controlPath }, {} as HostClient,
    new AbortController().signal) as { session: string };
  return result.session;
}

for (const code of [0, 7]) test(`bundled SESSION_PIPE verifies ${code === 0 ? "clean" : "failed"} SSH exit`, async () => {
  const session = await opened(), controller = new AbortController();
  const calls: { method: string; params: any }[] = [], output: string[] = [];
  const chunks = [Buffer.from("login chatter\n__PACER_BE"), Buffer.from("GIN__\nhello")];
  const host = {
    async call(method: string, params: any) {
      calls.push({ method, params });
      if (method === "capability.process.duplex.open") return { handle };
      if (method === "capability.process.duplex.read") {
        const bytes = chunks.shift();
        return bytes ? { base64: bytes.toString("base64"), eof: false } : { base64: "", eof: true };
      }
      if (method === "capability.process.duplex.close") return { ok: true, code, signal: null, terminated: false };
      throw Error(`unexpected ${method}`);
    },
    streamProgress: async (_stream: string, _seq: number, bytes: Uint8Array) => { output.push(Buffer.from(bytes).toString()); },
    streamInput: { next: () => new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(Error("owner ended")), { once: true });
    }) },
  } as unknown as HostClient;
  try {
    const call = handlers["hostRunner.stream"]!({ session, script: "SESSION_PIPE", args: [runDir],
      streamId, timeoutMs: 60_000, maxBytes: 65_536 }, host, controller.signal);
    if (code === 0) expect(await call).toEqual({ code: 0, bytes: 5 });
    else await expect(call).rejects.toMatchObject({ code: "plugin_unavailable" });
    expect(output).toEqual(["hello"]);
    expect(calls[0]).toEqual({ method: "capability.process.duplex.open",
      params: { argv: sessionPipeArgv(target, controlPath, [runDir]), timeoutMs: 60_000 } });
    expect(calls.filter(item => item.method === "capability.process.duplex.close"))
      .toEqual([{ method: "capability.process.duplex.close", params: { handle, graceful: true } }]);
  } finally {
    controller.abort();
    await handlers["hostRunner.close"]!({ session }, {} as HostClient, controller.signal);
  }
});

test("SESSION_PIPE keeps an idle viewer alive across bounded empty polls", async () => {
  const session = await opened(), controller = new AbortController();
  let polls = 0;
  const output: string[] = [];
  const host = {
    async call(method: string, params: any) {
      if (method === "capability.process.duplex.open") return { handle };
      if (method === "capability.process.duplex.read") {
        expect(params.pollMs).toBe(1000);
        if (++polls <= 65) return { base64: "", eof: false };
        if (polls === 66) return { base64: Buffer.from("__PACER_BEGIN__\nlate").toString("base64"), eof: false };
        return { base64: "", eof: true };
      }
      if (method === "capability.process.duplex.close") return { ok: true, code: 0, signal: null, terminated: false };
      throw Error(`unexpected ${method}`);
    },
    streamProgress: async (_stream: string, _seq: number, bytes: Uint8Array) => { output.push(Buffer.from(bytes).toString()); },
    streamInput: { next: () => new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(Error("owner ended")), { once: true });
    }) },
  } as unknown as HostClient;
  try {
    await expect(handlers["hostRunner.stream"]!({ session, script: "SESSION_PIPE", args: [runDir],
      streamId, timeoutMs: 60_000, maxBytes: 65_536 }, host, controller.signal))
      .resolves.toEqual({ code: 0, bytes: 4 });
    expect(polls).toBe(67);
    expect(output).toEqual(["late"]);
  } finally {
    controller.abort();
    await handlers["hostRunner.close"]!({ session }, {} as HostClient, controller.signal);
  }
});

test("SESSION_PIPE rejects a read deadline too short for its idle poll", async () => {
  const session = await opened(), controller = new AbortController();
  let brokerCalls = 0;
  const host = {
    async call() { brokerCalls++; throw Error("broker must not open"); },
    streamProgress: async () => {},
    streamInput: { next: async () => { throw Error("input must not start"); } },
  } as unknown as HostClient;
  try {
    await expect(handlers["hostRunner.stream"]!({ session, script: "SESSION_PIPE", args: [runDir],
      streamId, timeoutMs: 1000, maxBytes: 65_536 }, host, controller.signal))
      .rejects.toMatchObject({ code: "capability_denied" });
    expect(brokerCalls).toBe(0);
  } finally {
    controller.abort();
    await handlers["hostRunner.close"]!({ session }, {} as HostClient, controller.signal);
  }
});
