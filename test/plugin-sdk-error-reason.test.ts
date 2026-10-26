import { expect, test } from "bun:test";
import { PluginError, serve } from "@pacer/plugin";

function channel() {
  const queue: string[] = [];
  let wake: (() => void) | undefined, closed = false;
  return {
    input: { async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (closed) return;
        await new Promise<void>(resolve => { wake = resolve; });
      }
    } },
    send(value: unknown) { queue.push(JSON.stringify(value)); wake?.(); },
    close() { closed = true; wake?.(); },
  };
}
const manifest = { id: "error-reason-fixture", version: "0.1.0", publisher: "fixture", host: "^1", contributes: { diagnostic: {} } };
async function roundtrip(handler: Parameters<typeof serve>[0]["handlers"], hostError?: unknown) {
  const ch = channel(), output: any[] = [];
  let settle!: () => void;
  const result = new Promise<void>(resolve => { settle = resolve; });
  const done = serve({ manifest, input: ch.input, handlers: handler, write(line) {
    const frame = JSON.parse(line);
    output.push(frame);
    if (frame.method === "capability.fixture") ch.send({ jsonrpc: "2.0", id: frame.id, error: hostError });
    if (frame.id === 2) settle();
  } });
  ch.send({ jsonrpc: "2.0", id: 1, method: "plugin.hello", params: { protocol: "1.3.0", pacer: "fixture", manifest, config: {}, grants: [] } });
  ch.send({ jsonrpc: "2.0", id: 2, method: "diagnostic.ping", params: {} });
  const timer = setTimeout(() => { ch.close(); settle(); }, 2000);
  try { await result; } finally { clearTimeout(timer); ch.close(); await done; }
  const terminal = output.find(frame => frame.id === 2);
  if (!terminal) throw Error("missing terminal response");
  return terminal;
}

test("actual serve host error roundtrip retains only the allowed classification", async () => {
  let captured: unknown;
  const terminal = await roundtrip({ "diagnostic.ping": async (_params, host) => {
    try { await host.call("capability.fixture"); }
    catch (error) { captured = error; throw error; }
  } }, { code: -32000, message: "safe refusal", data: { code: "capability_denied", hint: "safe hint", reason: "credential_reflection", secret: "must-not-copy", nested: { credential: "must-not-copy" } } });
  expect(captured).toBeInstanceOf(PluginError);
  expect((captured as PluginError).reason).toBe("credential_reflection");
  expect(Object.hasOwn(captured as object, "data")).toBe(false);
  expect(terminal.error).toEqual({ code: -32000, message: "safe refusal", data: { code: "capability_denied", hint: "safe hint", reason: "credential_reflection" } });
  expect(JSON.stringify(terminal)).not.toContain("must-not-copy");
});

for (const [name, code, reason] of [
  ["unknown", "capability_denied", "untrusted"],
  ["object", "capability_denied", { secret: "must-not-copy" }],
  ["wrong code", "invalid_input", "credential_reflection"],
  ["missing", "capability_denied", undefined],
] as const) test(`incoming ${name} error reason is discarded`, async () => {
  let captured: unknown;
  const terminal = await roundtrip({ "diagnostic.ping": async (_params, host) => {
    try { await host.call("capability.fixture"); }
    catch (error) { captured = error; throw error; }
  } }, { code: -32000, message: "safe refusal", data: { code, reason, secret: "must-not-copy" } });
  expect((captured as PluginError).reason).toBeUndefined();
  expect(terminal.error).toEqual({ code: -32000, message: "safe refusal", data: { code } });
});

test("outbound PluginError reason is allow-listed without generic attached data", async () => {
  const terminal = await roundtrip({ "diagnostic.ping": () => {
    const error = new PluginError("capability_denied", "safe refusal", undefined, "credential_reflection");
    Object.assign(error, { data: { secret: "must-not-copy" } });
    throw error;
  } });
  expect(terminal.error).toEqual({ code: -32000, message: "safe refusal", data: { code: "capability_denied", reason: "credential_reflection" } });
});
for (const [code, reason] of [["invalid_input", "credential_reflection"], ["capability_denied", "forged"], ["capability_denied", { secret: "must-not-copy" }]] as const) test(`outbound forged reason ${code}/${typeof reason} is discarded`, async () => {
  const terminal = await roundtrip({ "diagnostic.ping": () => {
    const error = new PluginError(code, "safe refusal", "safe hint");
    // Untrusted JS can bypass TypeScript readonly/type constraints.
    Object.assign(error, { reason, data: { secret: "must-not-copy" } });
    throw error;
  } });
  expect(terminal.error).toEqual({ code: -32000, message: "safe refusal", data: { code, hint: "safe hint" } });
});
test("legacy PluginError and ordinary errors keep their previous wire shapes", async () => {
  expect((await roundtrip({ "diagnostic.ping": () => { throw new PluginError("invalid_input", "legacy"); } })).error).toEqual({ code: -32000, message: "legacy", data: { code: "invalid_input" } });
  expect((await roundtrip({ "diagnostic.ping": () => { throw Object.assign(Error("ordinary"), { reason: "credential_reflection", code: "capability_denied", data: { secret: "must-not-copy" } }); } })).error).toEqual({ code: -32000, message: "ordinary", data: { code: "internal" } });
});
