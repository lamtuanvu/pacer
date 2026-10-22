import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { NativeControlBridge, verifyPairedNativeServiceOwner, assertNativeServiceLaunch, assertNativeProcessCoverage, assertLegacyNativeServiceLayout } from "../src/update/desktop/native-provider";
import { ownProcessIdentity, processIdentity } from "../src/update/desktop/process-identity";
import { currentVersion } from "../src/update/version";
import { plist, servicePath } from "../src/service";
import type { NativeServiceOwner } from "../src/update/desktop/native-service-owner";
import type { NativeProcess } from "../src/update/desktop/native-os";

function fixture() {
  const ctx = fakeCtx({ home: realpathSync(tmpDir()), env: { PACER_PORT: "7433" } });
  mkdirSync(ctx.pacerHome);
  const app = join(ctx.home, "Applications/pacer.app");
  const front = join(app, "Contents/Resources/pacer");
  const core = join(dirname(front), "pacer-core");
  const desktop = join(app, "Contents/MacOS/pacer");
  mkdirSync(dirname(front), { recursive: true });
  mkdirSync(dirname(desktop), { recursive: true });
  for (const file of [front, core, desktop, join(dirname(front), "pacer-update-helper")]) writeFileSync(file, "fixture", { mode: 0o755 });
  const metadataPath = join(dirname(front), "pacer-release.json");
  const release = { schema: 1, bundleId: "dev.pacer.desktop", version: currentVersion(), arch: process.arch === "arm64" ? "aarch64" : "x86_64", protocolMajors: [3], admissionProtocol: 1, nativeTransportAbi: 1, rollbackCompatible: true, cliLayout: "paired" };
  const metadata = JSON.stringify(release);
  writeFileSync(metadataPath, metadata);
  writeFileSync(join(app, "Contents/Info.plist"), `<plist><dict><key>CFBundleIdentifier</key><string>dev.pacer.desktop</string><key>CFBundleShortVersionString</key><string>${currentVersion()}</string><key>CFBundleExecutable</key><string>pacer</string></dict></plist>`);
  mkdirSync(dirname(servicePath(ctx, "darwin")), { recursive: true });
  writeFileSync(servicePath(ctx, "darwin"), plist(ctx, [front]));
  const own = ownProcessIdentity()!;
  const root = processIdentity(process.ppid)!;
  const owner: NativeServiceOwner = { process: root, executable: front, argv: [front, "serve"], transport: own, appPath: app };
  const processes: NativeProcess[] = [
    { process: root, uid: process.getuid!(), parentPid: 1, name: "pacer", executable: front },
    { process: own, uid: process.getuid!(), parentPid: root.pid, name: "pacer-core", executable: core },
  ];
  const checked: string[] = [];
  const authority = {
    verifyStatic(path: string, role: string) { checked.push(`static:${role}:${path}`); },
    verifyProcess(identity: typeof own, role: string) {
      checked.push(`process:${role}:${identity.pid}`);
      const found = processes.find(p => p.process.pid === identity.pid && p.process.birth === identity.birth && p.process.bootId === identity.bootId);
      if (!found) throw Error("unverified process");
      return found;
    },
  };
  return { ctx, app, front, core, desktop, metadataPath, metadata, release, own, root, owner, processes, checked, authority };
}

function channel() {
  let resolve!: () => void;
  const sent: any[] = [];
  let closed = false;
  return { sent, isClosed: () => closed, peer: {
    auditToken: new Uint8Array(32), closed: new Promise<void>(r => { resolve = r; }),
    onFrame: (_frame: unknown) => {},
    send: async (frame: unknown) => { sent.push(frame); },
    close: () => { closed = true; resolve(); },
  } };
}

test("paired bridge publishes Root identity and executable while retaining original peer admission", async () => {
  const f = fixture(), desktop = channel(), helper = channel();
  let peerChecks = 0;
  const bridge = new NativeControlBridge(() => f.ctx, {
    port: 7433,
    paired: { owner: f.owner, listener: { fd: 900, owner: f.root }, shutdown: () => {} },
    authority: {
      verifyStatic: () => {},
      verifyPeer: (_token, role) => {
        peerChecks++;
        return { process: f.own, uid: process.getuid!(), executable: f.desktop, auditToken: new Uint8Array(32), role };
      },
    },
    verifyService: async () => {},
  });
  try {
    for (const [client, role] of [[desktop, "desktop"], [helper, "helper"]] as const) {
      bridge.accept(client.peer);
      expect(client.sent[0].service).toEqual(f.root);
      client.peer.onFrame({ schema: 1, kind: "hello", role, version: currentVersion(), nonce: "a".repeat(64), challenge: client.sent[0].nonce });
      await Bun.sleep(5);
      expect(client.isClosed()).toBe(false);
    }
    desktop.peer.onFrame({ schema: 1, kind: "desktop-ready", sessionId: desktop.sent[1].sessionId, sequence: 1, validStateRead: true, protocol: 3, serviceVersion: currentVersion(), proof: null });
    await Bun.sleep(5);
    const session = bridge.sessions()[0]!;
    expect(session.service).toEqual(f.root);
    await bridge.reverify(session);
    helper.peer.onFrame({ schema: 1, kind: "helper-context", sessionId: helper.sent[1].sessionId, sequence: 1, binding: { schema: 1, commandId: "command", installationId: session.installation.id, transactionId: null, revision: 0, nonce: "b".repeat(64) } });
    await Bun.sleep(5);
    expect(helper.sent.at(-1)).toMatchObject({ service: f.root, serviceExecutable: f.front });
    expect(peerChecks).toBeGreaterThanOrEqual(7);
  } finally { bridge.stop(); desktop.peer.close(); helper.peer.close(); }
});

test("paired owner revalidation checks both process signatures, sealed bundle and exact core coverage", () => {
  const f = fixture();
  const verified = verifyPairedNativeServiceOwner(f.authority, f.owner, 7433, f.metadata);
  expect(verified.process).toEqual(f.own);
  expect(f.checked).toEqual(expect.arrayContaining([
    `process:cli:${f.root.pid}`, `process:cli:${f.own.pid}`, `static:desktop:${f.app}`, `static:cli:${f.front}`, `static:cli:${f.core}`,
  ]));
  expect(() => assertNativeProcessCoverage(f.processes, f.root, [], f.front)).toThrow();
  expect(() => assertNativeProcessCoverage(f.processes, f.root, [], f.front, [verified.process])).not.toThrow();
  expect(() => assertNativeProcessCoverage(f.processes, f.root, [], f.front, [{ ...verified.process, birth: "reused" }])).toThrow();
  for (const rejected of [f.root.pid, f.own.pid]) {
    expect(() => verifyPairedNativeServiceOwner({ ...f.authority, verifyProcess: (identity, role) => {
      if (identity.pid === rejected) throw Error("signature refused");
      return f.authority.verifyProcess(identity, role);
    } }, f.owner, 7433, f.metadata)).toThrow("signature refused");
  }
});

test("paired owner revalidation rejects changed parent, path, incarnation or metadata", () => {
  for (const field of ["parent", "path", "uid", "incarnation", "metadata"] as const) {
    const f = fixture();
    if (field === "parent") f.processes[1]!.parentPid++;
    if (field === "path") f.processes[1]!.executable = f.front;
    if (field === "uid") f.processes[1]!.uid++;
    if (field === "incarnation") f.owner.transport = { ...f.own, birth: "reused" };
    if (field === "metadata") writeFileSync(f.metadataPath, JSON.stringify({ ...f.release, cliLayout: undefined }));
    expect(() => verifyPairedNativeServiceOwner(f.authority, f.owner, 7433, f.metadata)).toThrow();
  }
});

test("launchd verification requires logical Root PID and exact canonical Root argv", () => {
  const f = fixture();
  const status = { code: 0, stdout: `service = {\n pid = ${f.root.pid}\n}\n` };
  expect(() => assertNativeServiceLaunch(f.owner, f.owner.argv, status)).not.toThrow();
  expect(() => assertNativeServiceLaunch(f.owner, f.owner.argv, { ...status, stdout: `\n pid = ${f.own.pid}\n` })).toThrow();
  expect(() => assertNativeServiceLaunch(f.owner, [f.core, "serve"], status)).toThrow();
  expect(() => assertNativeServiceLaunch(f.owner, [...f.owner.argv, "--source"], status)).toThrow();
});


test("paired bundles and direct cores cannot enter the legacy native service path", () => {
  const f = fixture();
  expect(() => assertLegacyNativeServiceLayout(f.front)).toThrow();
  expect(() => assertLegacyNativeServiceLayout(f.core)).toThrow();
  writeFileSync(f.metadataPath, JSON.stringify({ ...f.release, cliLayout: undefined }));
  expect(() => assertLegacyNativeServiceLayout(f.front)).not.toThrow();
  expect(() => assertLegacyNativeServiceLayout(realpathSync(process.execPath))).not.toThrow();
});

test("paired metadata revalidation refuses redirected or oversized files", () => {
  const f = fixture();
  const other = join(f.ctx.home, "redirect.json");
  writeFileSync(other, f.metadata);
  unlinkSync(f.metadataPath);
  symlinkSync(other, f.metadataPath);
  expect(() => verifyPairedNativeServiceOwner(f.authority, f.owner, 7433, f.metadata)).toThrow();
  unlinkSync(f.metadataPath);
  writeFileSync(f.metadataPath, " ".repeat(65537));
  expect(() => verifyPairedNativeServiceOwner(f.authority, f.owner, 7433, f.metadata)).toThrow();
});

test("paired helper bootstrap names Root while child-parent admission still requires Core", async () => {
  const f = fixture();
  const { createNativePipeFactory } = await import("../src/update/desktop/native-provider");
  const { inspectInstallation } = await import("../src/update/desktop/identity");
  const { readdirSync } = await import("node:fs");
  const { FrameDecoder } = await import("../src/update/desktop/adapter");
  const helper = join(dirname(f.front), "pacer-update-helper");
  writeFileSync(helper, `#!${process.execPath}
import { readSync, writeSync } from "node:fs";
function read(length) {
  const bytes = Buffer.alloc(length);
  for (let at = 0; at < length;) {
    const count = readSync(0, bytes, at, length - at, null);
    if (!count) throw Error("short bootstrap");
    at += count;
  }
  return bytes;
}
const header = read(4), body = read(header.readUInt32BE());
writeSync(1, header); writeSync(1, body);
`);
  const installation = await inspectInstallation(f.ctx, f.app);
  const session = { installation, service: f.root, alive: () => true };
  let parent = process.pid;
  const factory = createNativePipeFactory(() => f.ctx, {
    sessions: () => [session], reverify: async () => {},
  } as never, {
    verifyStatic: () => {},
    verifyProcess: (identity: typeof f.own) => {
      const commands = join(f.ctx.pacerHome, "desktop-updates/native", installation.id, "commands");
      const directory = readdirSync(commands).at(-1)!;
      return { process: identity, parentPid: parent, executable: join(commands, directory, "pacer-update-helper") };
    },
  } as never, f.owner);
  const pipe = await factory.open(installation.id, new AbortController().signal);
  try {
    const bytes = new Uint8Array(await new Response(pipe.stdout).arrayBuffer());
    const [bootstrap] = new FrameDecoder().push(bytes);
    expect(bootstrap).toMatchObject({ kind: "helper-bootstrap", service: f.root, executable: f.front });
    expect(await pipe.exited).toBe(0);
  } finally { pipe.abort(); }
  parent = f.root.pid;
  await expect(factory.open(installation.id, new AbortController().signal)).rejects.toThrow();
});

test("authenticated shutdown targets Root and invokes the paired control callback after ack", async () => {
  const f = fixture();
  const { createHash } = await import("node:crypto");
  const { readFileSync } = await import("node:fs");
  const { readUpdate, writeUpdate } = await import("../src/update/desktop/store");
  const { requestRestart } = await import("../src/update/desktop/policy");
  const { readNativeTransaction, grantNativeTransaction } = await import("../src/update/desktop/native-record");
  const { reserveIdle, releaseReservation } = await import("../src/update/desktop/admission");
  const data = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/desktop-update/journal.json"), "utf8"));
  data.prepared.target.pacerHome = f.ctx.pacerHome;
  data.prepared.target.ownerUid = process.getuid!();
  const initial = readUpdate(f.ctx, "fixture");
  const ready = writeUpdate(f.ctx, { ...initial, phase: "ready", candidate: data.prepared.candidate, downloadedBytes: 100, totalBytes: 100 }, initial.revision);
  const waiting = requestRestart(ready, { installationId: "fixture", requestId: "request", expectRevision: ready.revision, version: "1.1.0", clientId: "client" }, "boot-one");
  const record = writeUpdate(f.ctx, { ...waiting, phase: "reserved" }, waiting.revision);
  data.prepared.binding.transactionId = record.transactionId;
  data.prepared.binding.revision = record.revision;
  const directory = join(f.ctx.pacerHome, "desktop-updates/native/fixture", record.transactionId!);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const bytes = JSON.stringify(data.prepared);
  data.journal.manifestSha256 = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(join(directory, "prepared.json"), bytes, { mode: 0o600 });
  const save = () => writeFileSync(join(directory, "journal.json"), JSON.stringify(data.journal), { mode: 0o600 });
  save();
  grantNativeTransaction(readNativeTransaction(f.ctx, "fixture", record.transactionId!));
  data.journal.authorization = JSON.parse(readFileSync(join(directory, "service-grant.json"), "utf8")).authorization;
  data.journal.state = "authorized";
  save();
  expect((await reserveIdle(f.ctx, record.transactionId!)).reserved).toBe(true);
  let shutdowns = 0;
  const clients: ReturnType<typeof channel>[] = [];
  const bridge = new NativeControlBridge(() => f.ctx, {
    port: 7433, shutdown: () => { throw Error("must not exit Core"); },
    paired: { owner: f.owner, listener: { fd: 900, owner: f.root }, shutdown: () => {
      expect(clients.at(-1)!.sent.at(-1).kind).toBe("ack");
      shutdowns++;
    } },
    authority: { verifyStatic: () => {}, verifyPeer: (_token, role) => ({ process: f.own, uid: process.getuid!(), executable: f.desktop, auditToken: new Uint8Array(32), role }) },
    verifyService: async () => {},
  });
  try {
    for (const expected of [f.own, f.root]) {
      const client = channel(); clients.push(client); bridge.accept(client.peer);
      client.peer.onFrame({ schema: 1, kind: "hello", role: "helper", version: currentVersion(), nonce: "a".repeat(64), challenge: client.sent[0].nonce });
      await Bun.sleep(5);
      client.peer.onFrame({ schema: 1, kind: "shutdown-service", sessionId: client.sent[1].sessionId, sequence: 1, binding: data.prepared.binding, expected });
      await Bun.sleep(5);
      if (expected === f.own) { expect(client.isClosed()).toBe(true); expect(shutdowns).toBe(0); }
    }
    expect(shutdowns).toBe(1);
  } finally {
    bridge.stop(); for (const client of clients) client.peer.close();
    await releaseReservation(f.ctx, record.transactionId!);
  }
});

test("verified paired ownership does not admit an unsigned external helper", async () => {
  const f = fixture(), client = channel();
  const bridge = new NativeControlBridge(() => f.ctx, {
    port: 7433,
    paired: { owner: f.owner, listener: { fd: 900, owner: f.root }, shutdown: () => {} },
    authority: { verifyStatic: () => {}, verifyPeer: () => { throw Error("unsigned helper"); } },
    verifyService: async () => {},
  });
  try {
    bridge.accept(client.peer);
    client.peer.onFrame({ schema: 1, kind: "hello", role: "helper", version: currentVersion(), nonce: "a".repeat(64), challenge: client.sent[0].nonce });
    await Bun.sleep(5);
    expect(client.isClosed()).toBe(true);
    expect(client.sent).toHaveLength(1);
    expect(bridge.sessions()).toEqual([]);
  } finally { bridge.stop(); client.peer.close(); }
});

test("paired revalidation retains ephemeral launch intent but requires an actual bound port", () => {
  const f = fixture(); f.owner.argv = [f.front, "serve", "--port", "0"];
  expect(verifyPairedNativeServiceOwner(f.authority, f.owner, 7433, f.metadata).process).toEqual(f.own);
  for (const value of ["00", "+0", "7434"]) {
    f.owner.argv[3] = value;
    expect(() => verifyPairedNativeServiceOwner(f.authority, f.owner, 7433, f.metadata)).toThrow();
  }
  f.owner.argv[3] = "0";
  expect(() => verifyPairedNativeServiceOwner(f.authority, f.owner, 0, f.metadata)).toThrow();
});
