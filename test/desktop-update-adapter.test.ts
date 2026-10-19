import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AdapterError, FrameDecoder, encodeFrame, parseAdapterCommand, parseAdapterFrame, parseInstallAuthorization,
  runAdapterCommand, type AdapterCommand, type AdapterFrame, type AdapterRequest,
  type VerifiedPipeFactory,
} from "../src/update/desktop/adapter";
import type { Candidate, Installation } from "../src/update/desktop/types";

const identity = { version: "1.0.0", bundleId: "dev.pacer.desktop", arch: "aarch64" as const };
const candidate: Candidate = { version: "1.1.0", arch: "aarch64", sha256: "a".repeat(64), signature: "test-signature", url: "https://example.invalid/1.1.0.tar.gz", protocolMajors: [3], rollbackCompatible: true, notes: "Release" };
const target: Installation = { id: "fixture", appPath: "/tmp/pacer-ota-fixture/pacer.app", bundleId: identity.bundleId, ownerUid: 501, arch: "aarch64", pacerHome: "/tmp/pacer-ota-fixture/state", port: 7433, serviceLabel: "com.pacer.serve", ownership: "managed", version: "1.0.0" };
const check: AdapterRequest = { command: "check", installationId: "fixture", revision: 2, transactionId: null };
const install: AdapterRequest = { command: "install", installationId: "fixture", revision: 2, transactionId: "tx-1", candidate, target };
const preparation = { reservationId: "tx-1", journalSha256: "b".repeat(64) };
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function harness() {
  const opened = deferred<AdapterCommand>(), exited = deferred<number>();
  let output!: ReadableStreamDefaultController<Uint8Array>, aborts = 0;
  const writes: unknown[] = [], decoder = new FrameDecoder();
  const factory: VerifiedPipeFactory = {
    capabilities: new Set(["check", "download", "install", "recover"]),
    async open() {
      return {
        identity,
        stdout: new ReadableStream<Uint8Array>({ start(controller) { output = controller; } }),
        stdin: new WritableStream<Uint8Array>({ write(bytes) {
          const frames = decoder.push(bytes); writes.push(...frames);
          if (writes.length === 1) opened.resolve(parseAdapterCommand(frames[0]));
        } }),
        exited: exited.promise,
        abort() { aborts++; },
      };
    },
  };
  const send = (command: AdapterCommand, value: Record<string, unknown>, sequence: number) => {
    const { schema, commandId, installationId, transactionId, revision, nonce } = command;
    output.enqueue(encodeFrame({ schema, commandId, installationId, transactionId, revision, nonce, sequence, ...value }));
  };
  return { factory, opened: opened.promise, writes, send, raw: (bytes: Uint8Array) => output.enqueue(bytes),
    end: (code = 0) => { output.close(); exited.resolve(code); }, aborts: () => aborts };
}
const hello = (h: ReturnType<typeof harness>, command: AdapterCommand) => h.send(command, { kind: "hello", ...identity }, 0);

async function fails(promise: Promise<unknown>, reason: AdapterError["reason"], handoff: AdapterError["handoff"] = "none") {
  try { await promise; throw Error("expected adapter failure"); }
  catch (error) { expect(error).toBeInstanceOf(AdapterError); expect(error).toMatchObject({ reason, handoff }); }
}

test("frames support split headers, bodies and coalesced messages and reject truncated data", () => {
  const a = encodeFrame({ a: "hello 🌍" }), b = encodeFrame({ b: 2 });
  const decoder = new FrameDecoder(), values: unknown[] = [];
  const bytes = new Uint8Array([...a, ...b]);
  for (const byte of bytes) values.push(...decoder.push(new Uint8Array([byte])));
  decoder.finish(); expect(values).toEqual([{ a: "hello 🌍" }, { b: 2 }]);
  const partial = new FrameDecoder(); partial.push(a.slice(0, -1)); expect(() => partial.finish()).toThrow(AdapterError);
  expect(() => new FrameDecoder().push(new Uint8Array([0, 0, 0, 0]))).toThrow(AdapterError);
  expect(() => new FrameDecoder().push(new Uint8Array([0, 4, 0, 1]))).toThrow(AdapterError);
  expect(() => new FrameDecoder().push(new Uint8Array([0, 0, 0, 1, 255]))).toThrow(AdapterError);
});

test("shared private wire fixture parses and rejects unknown variants and extra authority", () => {
  const fixture = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/desktop-update/adapter-wire.json"), "utf8"));
  for (const command of fixture.commands) expect(parseAdapterCommand(command)).toEqual(command);
  for (const frame of fixture.frames) expect(parseAdapterFrame(frame)).toEqual(frame);
  for (const continuation of fixture.continuations) expect(parseInstallAuthorization(continuation)).toEqual(continuation);
  expect(() => parseAdapterCommand({ ...fixture.commands[0], command: "execute-shell" })).toThrow(AdapterError);
  expect(() => parseAdapterCommand({ ...fixture.commands[0], executable: "/tmp/untrusted" })).toThrow(AdapterError);
  expect(() => parseAdapterFrame({ ...fixture.frames[0], schema: 2 })).toThrow(AdapterError);
});

test("default adapter cannot spawn and preaborted requests never open a pipe", async () => {
  await fails(runAdapterCommand(undefined, check), "unavailable");
  const controller = new AbortController(); controller.abort();
  let opens = 0;
  const factory: VerifiedPipeFactory = { capabilities: new Set(["check"]), open: async () => { opens++; throw Error("secret"); } };
  await fails(runAdapterCommand(factory, check, { signal: controller.signal }), "cancelled");
  expect(opens).toBe(0);
});

test("check binds the verified helper, returns only a terminal result after clean EOF and exit", async () => {
  const h = harness(), result = runAdapterCommand(h.factory, check);
  const command = await h.opened;
  expect(command.nonce).toMatch(/^[a-f0-9]{64}$/); expect(command.commandId).toBeTruthy();
  hello(h, command); h.send(command, { kind: "checked", candidate }, 1); h.end();
  expect(await result).toMatchObject({ kind: "checked", candidate }); expect(h.aborts()).toBe(0);
});

test("invalid binding, version, sequence and ordering fail without leaking diagnostic payloads", async () => {
  for (const change of [{ nonce: "c".repeat(64) }, { commandId: "wrong-command" }, { installationId: "another" }, { revision: 3 }, { transactionId: "foreign" }, { version: "9.0.0" }, { sequence: 1 }, { kind: "checked", candidate }]) {
    const h = harness(), promise = runAdapterCommand(h.factory, check);
    const command = await h.opened;
    h.send(command, { kind: "hello", ...identity, ...change }, 0);
    await fails(promise, "protocol"); expect(h.aborts()).toBe(1);
  }
  const h = harness(), promise = runAdapterCommand(h.factory, check); const command = await h.opened;
  hello(h, command); h.send(command, { kind: "error", code: "secret-token-should-not-leak" }, 1);
  try { await promise; } catch (error) { expect(String(error)).not.toContain("secret-token"); }
});

test("download progress is monotonic and completion must match every selected candidate field", async () => {
  for (const mode of ["valid", "decrease", "exceeds", "changed-total", "candidate", "partial"]) {
    const h = harness(), progress: number[] = [];
    const promise = runAdapterCommand(h.factory, { ...check, command: "download", candidate }, { onProgress: frame => progress.push(frame.downloadedBytes) });
    const command = await h.opened; hello(h, command);
    h.send(command, { kind: "progress", downloadedBytes: 5, totalBytes: 10 }, 1);
    if (mode === "decrease") h.send(command, { kind: "progress", downloadedBytes: 4, totalBytes: 10 }, 2);
    else if (mode === "exceeds") h.send(command, { kind: "progress", downloadedBytes: 11, totalBytes: 10 }, 2);
    else if (mode === "changed-total") h.send(command, { kind: "progress", downloadedBytes: 6, totalBytes: 12 }, 2);
    else h.send(command, { kind: "downloaded", candidate: mode === "candidate" ? { ...candidate, signature: "swapped" } : candidate, downloadedBytes: mode === "partial" ? 9 : 10, totalBytes: 10 }, 2);
    h.end();
    if (mode === "valid") { expect(await promise).toMatchObject({ kind: "downloaded" }); expect(progress).toEqual([5]); }
    else await fails(promise, "protocol");
  }
});

test("install requires durable preparation, explicit authorization and matching acknowledgment", async () => {
  const h = harness(), approval = deferred<boolean>(), prepared = deferred<void>(), acknowledged = deferred<void>();
  const promise = runAdapterCommand(h.factory, install, {
    authorizeInstall: async frame => { expect(frame).toMatchObject(preparation); prepared.resolve(); return approval.promise; },
    onAuthorized: () => acknowledged.resolve(),
  });
  const command = await h.opened; hello(h, command); h.send(command, { kind: "prepared", ...preparation }, 1);
  await prepared.promise; expect(h.writes).toHaveLength(1); approval.resolve(true);
  // Await the actual parent continuation, without a timed sleep.
  for (let i = 0; h.writes.length < 2 && i < 20; i++) await Promise.resolve();
  expect(h.writes[1]).toMatchObject({ kind: "authorize-install", commandId: command.commandId, nonce: command.nonce, ...preparation });
  h.send(command, { kind: "authorized", ...preparation }, 2); await acknowledged.promise;
  h.send(command, { kind: "outcome", outcome: "committed" }, 3); h.end();
  expect(await promise).toMatchObject({ kind: "outcome", outcome: "committed" }); expect(h.aborts()).toBe(0);
});

test("EOF or cancellation during prepared callback never sends authorization", async () => {
  for (const mode of ["eof", "cancel", "denied"]) {
    const h = harness(), controller = new AbortController(), approval = deferred<boolean>(), prepared = deferred<void>();
    const promise = runAdapterCommand(h.factory, install, { signal: controller.signal, authorizeInstall: async () => { prepared.resolve(); return approval.promise; } });
    const command = await h.opened; hello(h, command); h.send(command, { kind: "prepared", ...preparation }, 1); await prepared.promise;
    if (mode === "eof") h.end(); else if (mode === "cancel") controller.abort(); else approval.resolve(false);
    await fails(promise, mode === "eof" ? "closed" : "cancelled");
    approval.resolve(true); await Promise.resolve(); expect(h.writes).toHaveLength(1); expect(h.aborts()).toBe(1);
  }
});

test("decode continues during approval and refuses a premature native acknowledgment", async () => {
  const h = harness(), approval = deferred<boolean>(), prepared = deferred<void>();
  const promise = runAdapterCommand(h.factory, install, { authorizeInstall: async () => { prepared.resolve(); return approval.promise; } });
  const command = await h.opened; hello(h, command); h.send(command, { kind: "prepared", ...preparation }, 1); await prepared.promise;
  h.send(command, { kind: "authorized", ...preparation }, 2);
  await fails(promise, "protocol"); approval.resolve(true); expect(h.writes).toHaveLength(1);
});

test("lost transport after authorization is typed uncertain and never aborts the helper", async () => {
  const h = harness(), sent = deferred<void>();
  const original = h.factory.open;
  h.factory.open = async (...args) => {
    const pipe = await original(...args), writer = pipe.stdin.getWriter();
    pipe.stdin = new WritableStream({ async write(bytes) { await writer.write(bytes); if (h.writes.length === 2) sent.resolve(); } });
    return pipe;
  };
  const promise = runAdapterCommand(h.factory, install, { authorizeInstall: async () => true });
  const command = await h.opened; hello(h, command); h.send(command, { kind: "prepared", ...preparation }, 1); await sent.promise; h.end();
  await fails(promise, "closed", "uncertain"); expect(h.aborts()).toBe(0);
});

test("terminal extras, early process exit and deadlines are failures, not successful verification", async () => {
  const extra = harness(), first = runAdapterCommand(extra.factory, check); const command = await extra.opened;
  hello(extra, command); extra.send(command, { kind: "checked", candidate }, 1); extra.send(command, { kind: "checked", candidate }, 2); extra.end();
  await fails(first, "protocol");
  const early = harness(), second = runAdapterCommand(early.factory, check); await early.opened; early.end(1); await fails(second, "closed");
  const timeout = harness(), third = runAdapterCommand(timeout.factory, check, { timeoutMs: 5 }); await timeout.opened; await fails(third, "timeout"); expect(timeout.aborts()).toBe(1);
});

test("handoff uncertainty never aborts the factory acquisition signal after a pipe was returned", async () => {
  const h = harness(), sent = deferred<void>(); let signalled = 0;
  const open = h.factory.open;
  h.factory.open = async (id, signal) => {
    signal.addEventListener("abort", () => signalled++);
    const pipe = await open(id, signal), writer = pipe.stdin.getWriter();
    pipe.stdin = new WritableStream({ async write(bytes) { await writer.write(bytes); if (h.writes.length === 2) sent.resolve(); } });
    return pipe;
  };
  const promise = runAdapterCommand(h.factory, install, { authorizeInstall: async () => true });
  const command = await h.opened; hello(h, command); h.send(command, { kind: "prepared", ...preparation }, 1);
  await sent.promise; h.end(); await fails(promise, "closed", "uncertain");
  expect(signalled).toBe(0); expect(h.aborts()).toBe(0);
});

test("cancellation after the durable authorization acknowledgment preserves helper and reservation", async () => {
  const h = harness(), controller = new AbortController(), authorized = deferred<void>(), sent = deferred<void>();
  const open = h.factory.open;
  h.factory.open = async (...args) => {
    const pipe = await open(...args), writer = pipe.stdin.getWriter();
    pipe.stdin = new WritableStream({ async write(bytes) { await writer.write(bytes); if (h.writes.length === 2) sent.resolve(); } });
    return pipe;
  };
  const promise = runAdapterCommand(h.factory, install, { signal: controller.signal, authorizeInstall: async () => true, onAuthorized: () => authorized.resolve() });
  const command = await h.opened; hello(h, command); h.send(command, { kind: "prepared", ...preparation }, 1); await sent.promise;
  h.send(command, { kind: "authorized", ...preparation }, 2); await authorized.promise; controller.abort();
  await fails(promise, "cancelled", "acknowledged"); expect(h.aborts()).toBe(0);
});

test("independent commands reject cross-command responses and use different nonces", async () => {
  const a = harness(), b = harness(), pa = runAdapterCommand(a.factory, check), pb = runAdapterCommand(b.factory, check);
  const ca = await a.opened, cb = await b.opened;
  expect(ca.commandId).not.toBe(cb.commandId); expect(ca.nonce).not.toBe(cb.nonce);
  hello(a, cb); hello(b, ca); await fails(pa, "protocol"); await fails(pb, "protocol");
});

test("authorization write failure is uncertain even before native acknowledgment", async () => {
  const h = harness(), open = h.factory.open;
  h.factory.open = async (...args) => {
    const pipe = await open(...args), writer = pipe.stdin.getWriter(); let writes = 0;
    pipe.stdin = new WritableStream({ async write(bytes) { if (++writes === 2) throw Error("private-write-error-secret"); await writer.write(bytes); } });
    return pipe;
  };
  const promise = runAdapterCommand(h.factory, install, { authorizeInstall: async () => true });
  const command = await h.opened; hello(h, command); h.send(command, { kind: "prepared", ...preparation }, 1);
  await fails(promise, "closed", "uncertain"); expect(h.aborts()).toBe(0);
});

test("the helper cannot acknowledge a different prepared journal", async () => {
  const h = harness(), sent = deferred<void>(), open = h.factory.open;
  h.factory.open = async (...args) => {
    const pipe = await open(...args), writer = pipe.stdin.getWriter();
    pipe.stdin = new WritableStream({ async write(bytes) { await writer.write(bytes); if (h.writes.length === 2) sent.resolve(); } });
    return pipe;
  };
  const promise = runAdapterCommand(h.factory, install, { authorizeInstall: async () => true });
  const command = await h.opened; hello(h, command); h.send(command, { kind: "prepared", ...preparation }, 1); await sent.promise;
  h.send(command, { kind: "authorized", ...preparation, journalSha256: "d".repeat(64) }, 2);
  await fails(promise, "protocol", "uncertain"); expect(h.aborts()).toBe(0);
});

test("recovery has only recorded transaction authority and transport loss must preserve the helper", async () => {
  const h = harness(), promise = runAdapterCommand(h.factory, { command: "recover", installationId: "fixture", transactionId: "recorded-tx", revision: 7 });
  const command = await h.opened;
  expect(Object.keys(command).sort()).toEqual(["command", "commandId", "installationId", "nonce", "revision", "schema", "transactionId"]);
  hello(h, command); h.end(); await fails(promise, "closed", "uncertain"); expect(h.aborts()).toBe(0);
  expect(() => parseAdapterCommand({ ...command, journalPath: "/tmp/forged-journal" })).toThrow(AdapterError);
});

test("late pipe acquisition after cancellation cleans up without dispatching a command", async () => {
  const h = harness(), controller = new AbortController(), release = deferred<void>(), open = h.factory.open;
  h.factory.open = async (...args) => { await release.promise; return open(...args); };
  const promise = runAdapterCommand(h.factory, check, { signal: controller.signal }); controller.abort();
  await fails(promise, "cancelled"); release.resolve();
  for (let i = 0; i < 20 && h.aborts() === 0; i++) await Promise.resolve();
  expect(h.writes).toEqual([]); expect(h.aborts()).toBe(1);
});

test("download stalls and unsupported install capability fail before handoff", async () => {
  const h = harness(), promise = runAdapterCommand(h.factory, { ...check, command: "download", candidate }, { timeoutMs: 1000, noProgressTimeoutMs: 5 });
  const command = await h.opened; hello(h, command); await fails(promise, "timeout");
  const unavailable: VerifiedPipeFactory = { capabilities: new Set(["check"]), open: async () => { throw Error("must not open"); } };
  await fails(runAdapterCommand(unavailable, install, { authorizeInstall: async () => true }), "unavailable");
  await fails(runAdapterCommand(h.factory, install), "unavailable");
});

test("malformed private URLs produce only sanitized protocol errors", () => {
  const fixture = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/desktop-update/adapter-wire.json"), "utf8"));
  expect(() => parseAdapterCommand({ ...fixture.commands[1], candidate: { ...candidate, url: "private-invalid-url-secret" } })).toThrow(AdapterError);
});

test("adoption command is candidate-free, attached-only and uses explicit separate recovery",()=>{
 const binding={schema:1,commandId:"adopt-command",installationId:"fixture",transactionId:"tx-1",revision:2,nonce:"a".repeat(64)};
 const command={...binding,command:"adopt",target:{...target,ownership:"attached"}};
 expect(parseAdapterCommand(command).command).toBe("adopt");
 expect(()=>parseAdapterCommand({...command,candidate})).toThrow();
 expect(()=>parseAdapterCommand({...command,target})).toThrow();
 expect(parseAdapterCommand({...binding,command:"recover-adoption"}).command).toBe("recover-adoption");
});

test("adoption waits for durable continuation and separate recovery preserves uncertain handoff",async()=>{
 const h=harness();(h.factory.capabilities as Set<string>).add("adopt");
 const result=runAdapterCommand(h.factory,{command:"adopt",installationId:"fixture",revision:2,transactionId:"tx-1",target:{...target,ownership:"attached"}},{authorizeInstall:async()=>true});
 const command=await h.opened;hello(h,command);h.send(command,{kind:"prepared",...preparation},1);
 for(let i=0;i<20&&h.writes.length<2;i++)await Bun.sleep(1);
 expect(h.writes[1]).toMatchObject({kind:"authorize-install",commandId:command.commandId,...preparation});
 h.send(command,{kind:"authorized",...preparation},2);h.send(command,{kind:"outcome",outcome:"committed"},3);h.end();
 expect(await result).toMatchObject({kind:"outcome",outcome:"committed"});
 const recover=harness();(recover.factory.capabilities as Set<string>).add("recover-adoption");
 const pending=runAdapterCommand(recover.factory,{command:"recover-adoption",installationId:"fixture",revision:3,transactionId:"tx-1"});
 const recoveryCommand=await recover.opened;hello(recover,recoveryCommand);recover.end();
 await fails(pending,"closed","uncertain");expect(recover.aborts()).toBe(0);
});

test("adoption recovery accepts a journal-verified terminal outcome without reauthorization",async()=>{
 const h=harness();(h.factory.capabilities as Set<string>).add("recover-adoption");
 const result=runAdapterCommand(h.factory,{command:"recover-adoption",installationId:"fixture",revision:3,transactionId:"tx-1"});
 const command=await h.opened;hello(h,command);h.send(command,{kind:"outcome",outcome:"restored"},1);h.end();
 expect(await result).toMatchObject({kind:"outcome",outcome:"restored"});expect(h.writes).toHaveLength(1);
});
