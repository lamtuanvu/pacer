import { afterEach, expect, test } from "bun:test";
import { createCallAuthority, type CallAuthority, type CallResources } from "../src/plugins/authority";
import { HostLeaseBroker, type HostLeaseProvider } from "../src/plugins/host-lease";
import { fakeCtx } from "./helpers";
import { releaseReservation, reserveIdle } from "../src/update/desktop/admission";

const owners: CallAuthority[] = [];
afterEach(async () => {
  await Promise.allSettled(owners.map(owner => owner.revoke()));
  owners.length = 0;
});

function owner(grants = ["hosts"], hosts: CallResources["hosts"] = []): CallAuthority {
  const authority = createCallAuthority(fakeCtx(), { reads: [], commands: [], stores: [], hosts }, {
    deadlineMs: Date.now() + 5000, grants,
  });
  owners.push(authority);
  return authority;
}

test("an exact host-issued repo check is single-use; a hosts grant cannot broaden it", async () => {
  const f = fixture();
  const issued = { alias: "box", hostFingerprint: "host-one", script: "CHECK_REPO", args: ["~/repo", "check"],
    timeoutMs: 1000, maxBytes: 1024 } as const;
  const a = owner(["hosts"], [{ ...issued, args: [...issued.args] }]);
  const b = owner();
  const input = { alias: "box", sshTarget: "ssh-box", hostFingerprint: "host-one", callerGeneration: "caller-one",
    callerProcess: f.callerProcess, provider: f.provider };
  const { session } = await f.broker.open(a, input);
  const { session: unissued } = await f.broker.open(b, input);
  const request = { session, script: "CHECK_REPO" as const, args: ["~/repo", "check"], timeoutMs: 1000, maxBytes: 1024 };
  for (const bad of [
    { ...request, args: ["~/other", "check"] },
    { ...request, args: ["~/repo", "clone"] },
    { ...request, timeoutMs: 1001 },
    { ...request, maxBytes: 1025 },
    { ...request, stdin: "" },
  ]) await expect(f.broker.run(a, bad)).rejects.toMatchObject({ code: "capability_denied" });
  await expect(f.broker.run(b, { ...request, session: unissued })).rejects.toMatchObject({ code: "capability_denied" });
  expect(f.calls.filter(call => call.method === "hostRunner.run")).toHaveLength(0);
  await expect(f.broker.run(a, request)).resolves.toMatchObject({ stdout: "ok" });
  await expect(f.broker.run(a, request)).rejects.toMatchObject({ code: "capability_denied" });
  expect(f.calls.filter(call => call.method === "hostRunner.run")).toHaveLength(1);
});

test("an exact host-issued identity mutation is single-use and owner-bound", async () => {
  const f = fixture();
  const issued = { alias: "box", hostFingerprint: "host-one", script: "SET_IDENTITY",
    args: ["~/repo", "Example", "example@example.invalid"], timeoutMs: 1000, maxBytes: 1024 };
  const a = owner(["hosts"], [issued]), b = owner();
  const input = { alias: "box", sshTarget: "ssh-box", hostFingerprint: "host-one", callerGeneration: "caller-one",
    callerProcess: f.callerProcess, provider: f.provider };
  const { session } = await f.broker.open(a, input);
  const { session: foreignSession } = await f.broker.open(b, input);
  const request = { session, script: "SET_IDENTITY" as const, args: [...issued.args],
    timeoutMs: 1000, maxBytes: 1024 };
  for (const bad of [
    { ...request, args: ["~/other", ...issued.args.slice(1)] },
    { ...request, args: [issued.args[0], "Changed", issued.args[2]] },
    { ...request, timeoutMs: 1001 }, { ...request, maxBytes: 1025 },
    { ...request, stdin: "injected" },
  ]) await expect(f.broker.run(a, bad)).rejects.toMatchObject({ code: "capability_denied" });
  await expect(f.broker.run(b, { ...request, session: foreignSession })).rejects.toMatchObject({ code: "capability_denied" });
  expect(f.calls.filter(call => call.method === "hostRunner.run")).toHaveLength(0);
  await expect(f.broker.run(a, request)).resolves.toMatchObject({ code: 0, stdout: "ok" });
  await expect(f.broker.run(a, request)).rejects.toMatchObject({ code: "capability_denied" });
  expect(f.calls.filter(call => call.method === "hostRunner.run")).toHaveLength(1);
});

test("identity deadline expiry before provider dispatch releases its admission blocker", async () => {
  const f = fixture();
  const issued = { alias: "box", hostFingerprint: "host-one", script: "SET_IDENTITY",
    args: ["~/repo", "Example", "example@example.invalid"], timeoutMs: 1000, maxBytes: 1024 };
  const a = owner(["hosts"], [issued]);
  const { session } = await f.broker.open(a, { alias: "box", sshTarget: "ssh-box",
    hostFingerprint: "host-one", callerGeneration: "caller-one", callerProcess: f.callerProcess,
    provider: f.provider });
  const consume = a.consumeHostOperation.bind(a);
  a.consumeHostOperation = resource => {
    consume(resource);
    // Expire after validation and grant consumption, before the broker dispatches.
    (a as { deadlineMs: number }).deadlineMs = Date.now() - 1;
  };
  await expect(f.broker.run(a, { session, script: "SET_IDENTITY", args: issued.args,
    timeoutMs: issued.timeoutMs, maxBytes: issued.maxBytes })).rejects.toMatchObject({ code: "plugin_timeout" });
  expect(f.calls.filter(call => call.method === "hostRunner.run")).toHaveLength(0);
  const transaction = "123e4567-e89b-42d3-a456-426614174003";
  const idle = await reserveIdle(a.ctx, transaction);
  expect(idle.blockers.some(blocker => blocker.label === "Remote identity operation on box")).toBe(false);
  if (idle.reserved) await releaseReservation(a.ctx, transaction);
});

function fixture() {
  const calls: { method: string; params: unknown; signal: AbortSignal }[] = [];
  const callerProcess = {};
  const providerProcess = {};
  let valid = true;
  const provider: HostLeaseProvider = {
    id: "fx-ssh", generation: "generation-one", process: providerProcess,
    invoke: async (method, params, _deadlineAt, signal) => {
      calls.push({ method, params, signal });
      switch (method) {
        case "hostRunner.open": return { session: "provider-private-handle" };
        case "hostRunner.run": {
          const request = params as { script?: string; completionNonce?: string };
          return { code: 0, stdout: request.script === "SET_IDENTITY" ?
            `ok\n__PACER_DONE__=${request.completionNonce}\n` : "ok", stderr: "", timedOut: false };
        }
        case "hostRunner.close": return { ok: true };
        default: throw Error("unexpected method");
      }
    },
  };
  const broker = new HostLeaseBroker({ validate: () => {
    if (!valid) throw Error("provider or host generation changed");
  } });
  return { broker, provider, callerProcess, calls, retire: () => { valid = false; } };
}

test("broker handles stay private and owner-bound across open, run and close", async () => {
  const f = fixture(), a = owner(), b = owner();
  const { session } = await f.broker.open(a, {
    alias: "box", sshTarget: "ssh-box", hostFingerprint: "host-one", callerGeneration: "caller-one",
    callerProcess: f.callerProcess, provider: f.provider,
  });
  expect(session).not.toBe("provider-private-handle");
  expect(session).toMatch(/^[a-f0-9]{32}$/);
  await expect(f.broker.run(b, { session, script: "PROBE", args: [], timeoutMs: 1000, maxBytes: 100 })).rejects.toMatchObject({ code: "capability_denied" });
  await expect(f.broker.run(a, { session: "provider-private-handle", script: "PROBE", args: [], timeoutMs: 1000, maxBytes: 100 })).rejects.toMatchObject({ code: "capability_denied" });
  expect(f.calls.map(call => call.method)).toEqual(["hostRunner.open"]);
  await expect(f.broker.run(a, { session, script: "PROBE", args: [], timeoutMs: 1000, maxBytes: 100 })).resolves.toMatchObject({ stdout: "ok" });
  expect(f.calls[1]?.params).toMatchObject({ session: "provider-private-handle" });
  await expect(f.broker.close(a, { session })).resolves.toEqual({ ok: true });
  await expect(f.broker.close(a, { session })).resolves.toEqual({ ok: true });
  expect(f.calls.filter(call => call.method === "hostRunner.close")).toHaveLength(1);
  await expect(f.broker.run(a, { session, script: "PROBE", args: [], timeoutMs: 1000, maxBytes: 100 })).rejects.toMatchObject({ code: "capability_denied" });
});

test("host sessions refuse mutation, arguments, stdin and oversized probe output before provider effects", async () => {
  const f = fixture(), a = owner();
  const { session } = await f.broker.open(a, {
    alias: "box", sshTarget: "ssh-box", hostFingerprint: "host-one", callerGeneration: "caller-one",
    callerProcess: f.callerProcess, provider: f.provider,
  });
  const base = { session, script: "PROBE" as const, args: [], timeoutMs: 1000, maxBytes: 1024 };
  await expect(f.broker.run(a, { ...base, script: "CLEAN" })).rejects.toMatchObject({ code: "capability_denied" });
  await expect(f.broker.run(a, { ...base, args: ["unexpected"] })).rejects.toMatchObject({ code: "capability_denied" });
  await expect(f.broker.run(a, { ...base, stdin: "secret" })).rejects.toMatchObject({ code: "capability_denied" });
  await expect(f.broker.run(a, { ...base, maxBytes: 65_537 })).rejects.toMatchObject({ code: "capability_denied" });
  expect(f.calls.filter(call => call.method === "hostRunner.run")).toHaveLength(0);
  await expect(f.broker.run(a, base)).resolves.toMatchObject({ stdout: "ok" });
});

test("missing grant and changed generation deny before provider effects", async () => {
  const f = fixture();
  await expect(f.broker.open(owner([]), {
    alias: "box", sshTarget: "ssh-box", hostFingerprint: "host-one", callerGeneration: "caller-one",
    callerProcess: f.callerProcess, provider: f.provider,
  })).rejects.toMatchObject({ code: "capability_denied" });
  expect(f.calls).toHaveLength(0);
  const a = owner();
  const { session } = await f.broker.open(a, {
    alias: "box", sshTarget: "ssh-box", hostFingerprint: "host-one", callerGeneration: "caller-one",
    callerProcess: f.callerProcess, provider: f.provider,
  });
  f.retire();
  await expect(f.broker.run(a, { session, script: "PROBE", args: [], timeoutMs: 1000, maxBytes: 100 })).rejects.toBeDefined();
  expect(f.calls.filter(call => call.method === "hostRunner.run")).toHaveLength(0);
});

test("revoke retires a running lease and closes with a fresh bounded signal", async () => {
  const f = fixture(), a = owner();
  let release!: (value: unknown) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.provider.invoke = async (method, params, _deadlineAt, signal) => {
    f.calls.push({ method, params, signal });
    if (method === "hostRunner.open") return { session: "provider-private-handle" };
    if (method === "hostRunner.run") { entered(); return new Promise(resolve => { release = resolve; }); }
    return { ok: true };
  };
  const { session } = await f.broker.open(a, {
    alias: "box", sshTarget: "ssh-box", hostFingerprint: "host-one", callerGeneration: "caller-one",
    callerProcess: f.callerProcess, provider: f.provider,
  });
  const pending = f.broker.run(a, { session, script: "PROBE", args: [], timeoutMs: 1000, maxBytes: 100 });
  await started;
  const revoked = a.revoke();
  release({ code: 0, stdout: "late", stderr: "", timedOut: false });
  await expect(pending).rejects.toMatchObject({ code: "capability_denied" });
  await revoked;
  const close = f.calls.find(call => call.method === "hostRunner.close");
  expect(close).toBeDefined();
  expect(close!.signal.aborted).toBe(false);
  expect(f.calls.find(call => call.method === "hostRunner.run")!.signal.aborted).toBe(true);
});

test("close waits for one active run and refuses a second run", async () => {
  const f = fixture(), a = owner();
  let finish!: (value: unknown) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.provider.invoke = async (method, params, _deadlineAt, signal) => {
    f.calls.push({ method, params, signal });
    if (method === "hostRunner.open") return { session: "provider-private-handle" };
    if (method === "hostRunner.run") { entered(); return new Promise(resolve => { finish = resolve; }); }
    return { ok: true };
  };
  const { session } = await f.broker.open(a, {
    alias: "box", sshTarget: "ssh-box", hostFingerprint: "host-one", callerGeneration: "caller-one",
    callerProcess: f.callerProcess, provider: f.provider,
  });
  const request = { session, script: "PROBE" as const, args: [], timeoutMs: 1000, maxBytes: 100 };
  const first = f.broker.run(a, request);
  await started;
  await expect(f.broker.run(a, request)).rejects.toMatchObject({ code: "conflict" });
  const closing = f.broker.close(a, { session });
  await Bun.sleep(0);
  expect(f.calls.filter(call => call.method === "hostRunner.close")).toHaveLength(0);
  finish({ code: 0, stdout: "first", stderr: "", timedOut: false });
  await expect(first).resolves.toMatchObject({ stdout: "first" });
  await expect(closing).resolves.toEqual({ ok: true });
  expect(f.calls.map(call => call.method)).toEqual(["hostRunner.open", "hostRunner.run", "hostRunner.close"]);
});

test("late open after owner cancellation is closed and never published", async () => {
  const f = fixture(), a = owner();
  let finish!: (value: unknown) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.provider.invoke = async (method, params, _deadlineAt, signal) => {
    f.calls.push({ method, params, signal });
    if (method === "hostRunner.open") { entered(); return new Promise(resolve => { finish = resolve; }); }
    return { ok: true };
  };
  const opening = f.broker.open(a, {
    alias: "box", sshTarget: "ssh-box", hostFingerprint: "host-one", callerGeneration: "caller-one",
    callerProcess: f.callerProcess, provider: f.provider,
  });
  await started;
  await a.revoke();
  await expect(opening).rejects.toMatchObject({ code: "capability_denied" });
  finish({ session: "provider-private-handle" });
  await Bun.sleep(0);
  expect(f.calls.map(call => call.method)).toEqual(["hostRunner.open", "hostRunner.close"]);
  expect(f.calls[1]!.signal.aborted).toBe(false);
});

test("one call can own at most four sessions and malformed output retires the lease", async () => {
  const f = fixture(), a = owner();
  const sessions: string[] = [];
  for (let i = 0; i < 4; i++) {
    sessions.push((await f.broker.open(a, {
      alias: "box", sshTarget: "ssh-box", hostFingerprint: "host-one", callerGeneration: "caller-one",
      callerProcess: f.callerProcess, provider: f.provider,
    })).session);
  }
  await expect(f.broker.open(a, {
    alias: "box", sshTarget: "ssh-box", hostFingerprint: "host-one", callerGeneration: "caller-one",
    callerProcess: f.callerProcess, provider: f.provider,
  })).rejects.toMatchObject({ code: "too_large" });
  expect(f.calls.filter(call => call.method === "hostRunner.open")).toHaveLength(4);
  f.provider.invoke = async () => { throw Error("must not replace captured provider"); };
  const request = { session: sessions[0]!, script: "PROBE" as const, args: [], timeoutMs: 1000, maxBytes: 1 };
  await expect(f.broker.run(a, request)).rejects.toMatchObject({ code: "plugin_refused" });
  await expect(f.broker.run(a, request)).rejects.toMatchObject({ code: "capability_denied" });
});

test("generation edit retires an in-flight run before the provider replies", async () => {
  const f = fixture(), a = owner();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.provider.invoke = async (method, params, _deadlineAt, signal) => {
    f.calls.push({ method, params, signal });
    if (method === "hostRunner.open") return { session: "provider-private-handle" };
    if (method === "hostRunner.run") { entered(); return new Promise(() => {}); }
    return { ok: true };
  };
  const { session } = await f.broker.open(a, {
    alias: "box", sshTarget: "ssh-box", hostFingerprint: "host-one", callerGeneration: "caller-one",
    callerProcess: f.callerProcess, provider: f.provider,
  });
  const running = f.broker.run(a, { session, script: "PROBE", args: [], timeoutMs: 1000, maxBytes: 100 });
  await started;
  f.retire();
  await expect(running).rejects.toMatchObject({ code: "capability_denied" });
  expect(f.calls.find(call => call.method === "hostRunner.run")!.signal.aborted).toBe(true);
  const until = Date.now() + 2500;
  while (!f.calls.some(call => call.method === "hostRunner.close") && Date.now() < until) await Bun.sleep(10);
  expect(f.calls.some(call => call.method === "hostRunner.close")).toBe(true);
});

test("owner revoke waits for an already-started provider close", async () => {
  const f = fixture(), a = owner();
  let finish!: (value: unknown) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.provider.invoke = async (method, params, _deadlineAt, signal) => {
    f.calls.push({ method, params, signal });
    if (method === "hostRunner.open") return { session: "provider-private-handle" };
    if (method === "hostRunner.close") { entered(); return new Promise(resolve => { finish = resolve; }); }
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
  const { session } = await f.broker.open(a, {
    alias: "box", sshTarget: "ssh-box", hostFingerprint: "host-one", callerGeneration: "caller-one",
    callerProcess: f.callerProcess, provider: f.provider,
  });
  const closing = f.broker.close(a, { session });
  await started;
  let settled = false;
  const revoked = a.revoke().then(() => { settled = true; });
  await Bun.sleep(0);
  expect(settled).toBe(false);
  finish({ ok: true });
  await revoked;
  await expect(closing).rejects.toMatchObject({ code: "capability_denied" });
  expect(f.calls.filter(call => call.method === "hostRunner.close")).toHaveLength(1);
});

test("closed session tombstones have a finite per-call issue cap", async () => {
  const f = fixture(), a = owner();
  const input = { alias: "box", sshTarget: "ssh-box", hostFingerprint: "host-one", callerGeneration: "caller-one",
    callerProcess: f.callerProcess, provider: f.provider };
  for (let i = 0; i < 64; i++) {
    const { session } = await f.broker.open(a, input);
    await f.broker.close(a, { session });
  }
  await expect(f.broker.open(a, input)).rejects.toMatchObject({ code: "too_large" });
  expect(f.calls.filter(call => call.method === "hostRunner.open")).toHaveLength(64);
});
