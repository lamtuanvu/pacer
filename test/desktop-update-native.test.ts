import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  nativeSocketPath,
  compiledAppleTeamId,
  compiledSigningCertSha1,
  DarwinAuthority,
} from "../src/update/desktop/native-os";
import { fakeCtx } from "./helpers";

test("source and runtime env cannot enable native production trust", () => {
  const old = process.env.PACER_BUILD_APPLE_TEAM_ID;
  process.env.PACER_BUILD_APPLE_TEAM_ID = "ABCDE12345";
  process.env.PACER_BUILD_SIGNING_CERT_SHA1 = "A".repeat(40);
  try {
    expect(compiledAppleTeamId()).toBeNull();
    expect(compiledSigningCertSha1()).toBeNull();
    expect(DarwinAuthority.configured()).toBeNull();
  } finally {
    if (old === undefined) delete process.env.PACER_BUILD_APPLE_TEAM_ID;
    else process.env.PACER_BUILD_APPLE_TEAM_ID = old;
    delete process.env.PACER_BUILD_SIGNING_CERT_SHA1;
  }
});
test("native socket derives short distinct endpoints from canonical home port and UID", () => {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome);
  const a = nativeSocketPath(ctx.pacerHome, 7433, 501);
  expect(a).toMatch(/^\/private\/tmp\/pacer-native-501\/[a-f0-9]{32}\.sock$/);
  expect(Buffer.byteLength(a)).toBeLessThan(104);
  expect(nativeSocketPath(ctx.pacerHome + "/.", 7433, 501)).toBe(a);
  expect(nativeSocketPath(ctx.pacerHome, 7434, 501)).not.toBe(a);
  expect(nativeSocketPath(ctx.pacerHome, 7433, 502)).not.toBe(a);
});
test("native dynamic verifier rejects an unrelated process and supplied invalid audit token", () => {
  if (process.platform !== "darwin") return;
  const authority = new DarwinAuthority({ appleTeamId: "ABCDE12345" });
  expect(() => authority.verifyPeer(new Uint8Array(32), "desktop")).toThrow();
  expect(() => authority.verifyStatic(process.execPath, "desktop")).toThrow();
});

test("private native socket reports kernel peer token and frames a real local connection", async () => {
  if (process.platform !== "darwin") return;
  const { LocalNativeServer } = await import(
    "../src/update/desktop/native-socket"
  );
  const { connect } = await import("node:net");
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome);
  const path = nativeSocketPath(ctx.pacerHome, 7433, process.getuid!());
  let received: unknown;
  const server = new LocalNativeServer(path, (peer) => {
    expect(new DataView(peer.auditToken.buffer).getUint32(20, true)).toBe(
      process.pid,
    );
    peer.onFrame = (value) => {
      received = value;
      void peer.send({ kind: "ok" });
    };
  });
  const client = connect(path);
  try {
    const { encodeFrame } = await import("../src/update/desktop/adapter");
    const reply = new Promise<Buffer>((resolve, reject) => {
      client.once("data", resolve);
      client.once("error", reject);
    });
    client.write(encodeFrame({ hello: "local" }));
    expect((await reply).subarray(4).toString()).toBe('{"kind":"ok"}');
    expect(received).toEqual({ hello: "local" });
  } finally {
    client.destroy();
    server.close();
  }
});

test("CLI build identity reports disabled source authority without copying runtime trust claims", async () => {
  const { main } = await import("../src/cli");
  const ctx = fakeCtx();
  ctx.env.PACER_BUILD_APPLE_TEAM_ID = "ABCDE12345";
  const result = await main(["--pacer-identity"], ctx);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out)).toMatchObject({
    schema: 1,
    role: "cli",
    bundleId: "dev.pacer.cli",
    fixture: false,
    otaMode: "disabled",
    appleTeamId: null,
    signingCertSha1: null,
    signer: null,
  });
});

test("native transaction readers refuse missing or unbound authority", async () => {
  const { readNativeTransaction } = await import(
    "../src/update/desktop/native-record"
  );
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome);
  expect(() => readNativeTransaction(ctx, "desktop", "transaction")).toThrow();
  expect(() =>
    readNativeTransaction(ctx, "../escape", "transaction"),
  ).toThrow();
});

test("native reservation inspection never creates or releases admission", async () => {
  const admission = await import("../src/update/desktop/admission");
  const ctx = fakeCtx();
  expect(admission.hasReservation(ctx, "transaction")).toBe(false);
  expect(await admission.reserveIdle(ctx, "transaction")).toMatchObject({
    reserved: true,
  });
  expect(admission.hasReservation(ctx, "transaction")).toBe(true);
  expect(admission.hasReservation(ctx, "other")).toBe(false);
  expect(admission.hasReservation(ctx, "transaction")).toBe(true);
});

async function nativeRecordFixture() {
  const { readFileSync, writeFileSync, realpathSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const { readUpdate, writeUpdate } = await import(
    "../src/update/desktop/store"
  );
  const { requestRestart } = await import("../src/update/desktop/policy");
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/desktop-update/journal.json", import.meta.url),
      "utf8",
    ),
  );
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { mode: 0o700 });
  fixture.prepared.target.pacerHome = realpathSync(ctx.pacerHome);
  fixture.prepared.target.ownerUid = process.getuid!();
  fixture.prepared.oldServiceExecutable =
    fixture.prepared.target.appPath + "/Contents/Resources/pacer";
  const initial = readUpdate(ctx, "fixture"),
    ready = writeUpdate(
      ctx,
      {
        ...initial,
        phase: "ready",
        candidate: fixture.prepared.candidate,
        downloadedBytes: 100,
        totalBytes: 100,
      },
      initial.revision,
    );
  const waiting = requestRestart(
    ready,
    {
      installationId: "fixture",
      requestId: "request",
      expectRevision: ready.revision,
      version: "1.1.0",
      clientId: "client",
    },
    "boot-one",
  );
  const record = writeUpdate(
    ctx,
    { ...waiting, phase: "reserved" },
    waiting.revision,
  );
  fixture.prepared.binding.transactionId = record.transactionId;
  fixture.prepared.binding.revision = record.revision;
  const dir = join(
    ctx.pacerHome,
    "desktop-updates",
    "native",
    "fixture",
    record.transactionId!,
  );
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const save = () => {
    const bytes = JSON.stringify(fixture.prepared);
    fixture.journal.manifestSha256 = createHash("sha256")
      .update(bytes)
      .digest("hex");
    writeFileSync(join(dir, "prepared.json"), bytes, { mode: 0o600 });
    writeFileSync(join(dir, "journal.json"), JSON.stringify(fixture.journal), {
      mode: 0o600,
    });
  };
  save();
  return { ctx, fixture, dir, record, save, writeUpdate };
}
test("native journal matches immutable preparation and durable restart receipt", async () => {
  const { readNativeTransaction } = await import(
    "../src/update/desktop/native-record"
  );
  const f = await nativeRecordFixture();
  expect(
    readNativeTransaction(f.ctx, "fixture", f.record.transactionId!)
      .authorization,
  ).toBeNull();
  f.fixture.prepared.binding.revision += 100;
  f.save();
  expect(() =>
    readNativeTransaction(f.ctx, "fixture", f.record.transactionId!),
  ).toThrow();
});
test("terminal native journal cannot bypass missing original request receipt", async () => {
  const { readNativeTransaction } = await import(
    "../src/update/desktop/native-record"
  );
  const f = await nativeRecordFixture();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    `${f.ctx.pacerHome}/desktop-updates/fixture.json`,
    JSON.stringify({
      ...f.record,
      phase: "complete",
      requestId: null,
      requestedBy: null,
      requesterBootId: null,
      requestHistory: [],
    }),
    { mode: 0o600 },
  );
  expect(() =>
    readNativeTransaction(f.ctx, "fixture", f.record.transactionId!),
  ).toThrow();
});

test("native control rejects public claims and sequence replay before any authority effect", async () => {
  const { NativeControlBridge } = await import(
    "../src/update/desktop/native-provider"
  );
  const sent: unknown[] = [];
  let closed = false,
    resolveClosed!: () => void;
  const peer = {
    auditToken: new Uint8Array(32),
    closed: new Promise<void>((resolve) => (resolveClosed = resolve)),
    onFrame: (_value: unknown) => {},
    send: async (value: unknown) => {
      sent.push(value);
    },
    close: () => {
      closed = true;
      resolveClosed();
    },
  };
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome);
  const bridge = new NativeControlBridge(() => ctx, {
    port: 7433,
    authority: {
      verifyPeer: () => {
        throw Error("unsigned");
      },
      verifyStatic: () => {},
    },
    verifyService: async () => {},
  });
  bridge.accept(peer);
  await Bun.sleep(1);
  const challenge = sent[0] as any;
  peer.onFrame({
    schema: 1,
    kind: "hello",
    role: "desktop",
    version: "1.0.0",
    nonce: "a".repeat(64),
    challenge: challenge.nonce,
    clientId: "public-claim",
  });
  await Bun.sleep(1);
  expect(closed).toBe(true);
  expect(bridge.sessions()).toEqual([]);
  bridge.stop();
});

test("authorized native journal requires exact durable service grant", async () => {
  const { readNativeTransaction, grantNativeTransaction } = await import(
    "../src/update/desktop/native-record"
  );
  const f = await nativeRecordFixture();
  const authorization = {
    ...f.fixture.prepared.binding,
    kind: "authorize-install",
    reservationId: f.record.transactionId,
    journalSha256: f.fixture.journal.manifestSha256,
  };
  f.fixture.journal.authorization = authorization;
  f.fixture.journal.state = "authorized";
  f.save();
  expect(() =>
    readNativeTransaction(f.ctx, "fixture", f.record.transactionId!),
  ).toThrow();
  f.fixture.journal.authorization = null;
  f.fixture.journal.state = "prepared";
  f.save();
  const tx = readNativeTransaction(f.ctx, "fixture", f.record.transactionId!);
  grantNativeTransaction(tx);
  f.fixture.journal.authorization = authorization;
  f.fixture.journal.state = "authorized";
  f.save();
  expect(
    readNativeTransaction(f.ctx, "fixture", f.record.transactionId!)
      .authorization,
  ).toEqual(authorization);
  f.fixture.journal.authorization.commandId = "different";
  f.save();
  expect(() =>
    readNativeTransaction(f.ctx, "fixture", f.record.transactionId!),
  ).toThrow();
});

test("fresh authenticated launch can fill the journal crash gap using exact durable launch intent", async () => {
  const { readNativeTransaction, grantNativeTransaction, verifyNativeLaunch } =
    await import("../src/update/desktop/native-record");
  const f = await nativeRecordFixture();
  grantNativeTransaction(
    readNativeTransaction(f.ctx, "fixture", f.record.transactionId!),
  );
  f.fixture.journal.authorization = {
    ...f.fixture.prepared.binding,
    kind: "authorize-install",
    reservationId: f.record.transactionId,
    journalSha256: f.fixture.journal.manifestSha256,
  };
  f.fixture.journal.state = "installing";
  const launchId = "d".repeat(64);
  const service = { pid: 201, bootId: "boot-one", birth: "2:1" },
    desktop = { pid: 202, bootId: "boot-one", birth: "2:2" };
  f.fixture.journal.steps.push({
    action: {
      kind: "launch",
      role: "service",
      release: "candidate",
      launchId: "e".repeat(64),
    },
    intentRevision: 6,
    intentBootId: "boot-one",
    evidence: {
      kind: "launched",
      launch: {
        role: "service",
        release: "candidate",
        launchId: "e".repeat(64),
        process: service,
        nativeSessionId: "service-session",
        version: "1.1.0",
      },
    },
  });
  f.fixture.journal.steps.push({
    action: { kind: "launch", role: "desktop", release: "candidate", launchId },
    intentRevision: 7,
    intentBootId: "boot-one",
    evidence: null,
  });
  f.save();
  const ticket = {
    schema: 1 as const,
    installationId: "fixture",
    transactionId: f.record.transactionId!,
    launchId,
    nonce: launchId,
    nativeSessionId: "candidate-session",
    service,
    serviceVersion: "1.1.0",
    desktopVersion: "1.1.0",
    protocol: 3 as const,
  };
  expect(verifyNativeLaunch(f.ctx, ticket, desktop).record.transactionId).toBe(
    f.record.transactionId,
  );
  expect(() =>
    verifyNativeLaunch(f.ctx, { ...ticket, desktopVersion: "9.0.0" }, desktop),
  ).toThrow();
  expect(() =>
    verifyNativeLaunch(
      f.ctx,
      { ...ticket, launchId: "f".repeat(64), nonce: "f".repeat(64) },
      desktop,
    ),
  ).toThrow();
});

test("OS process enumeration and dynamic signing use kernel incarnations", async () => {
  if (process.platform !== "darwin") return;
  const { enumerateNativeProcesses } = await import(
    "../src/update/desktop/native-os"
  );
  const { ownProcessIdentity } = await import(
    "../src/update/desktop/process-identity"
  );
  expect(
    enumerateNativeProcesses().find((p) => p.process.pid === process.pid)
      ?.process,
  ).toEqual(ownProcessIdentity()!);
  const authority = new DarwinAuthority({ appleTeamId: "ABCDE12345" });
  expect(() => authority.verifyProcess(ownProcessIdentity()!, "cli")).toThrow();
});

test("coexisting known CLI outside service and enrolled work blocks native mutation", async () => {
  const { assertNativeProcessCoverage } = await import(
    "../src/update/desktop/native-provider"
  );
  const service = { pid: 1, bootId: "boot", birth: "1:1" },
    child = { pid: 2, bootId: "boot", birth: "2:1" };
  const processes = [
    {
      process: service,
      uid: 501,
      parentPid: 0,
      name: "pacer",
      executable: "/opt/pacer",
    },
    {
      process: child,
      uid: 501,
      parentPid: 1,
      name: "pacer",
      executable: "/opt/old-pacer",
    },
  ];
  expect(() =>
    assertNativeProcessCoverage(processes, service, [], "/opt/pacer"),
  ).toThrow();
  expect(() =>
    assertNativeProcessCoverage(processes, service, [child], "/opt/pacer"),
  ).not.toThrow();
  expect(() =>
    assertNativeProcessCoverage(
      processes,
      service,
      [{ ...child, birth: "reused" }],
      "/opt/pacer",
    ),
  ).toThrow();
});

async function nativeBridgeFixture(role: "desktop" | "helper" = "desktop", paired = false) {
  const { writeFileSync } = await import("node:fs"),
    { dirname, join } = await import("node:path"),
    { plist, servicePath } = await import("../src/service");
  const { NativeControlBridge } = await import(
      "../src/update/desktop/native-provider"
    ),
    { ownProcessIdentity } = await import(
      "../src/update/desktop/process-identity"
    ),
    { currentVersion } = await import("../src/update/version");
  const ctx = fakeCtx({ env: { PACER_PORT: "7433" } });
  mkdirSync(ctx.pacerHome);
  const app = join(ctx.home, "Applications/pacer.app"),
    cli = join(app, "Contents/Resources/pacer"),
    desktop = join(app, "Contents/MacOS/pacer");
  mkdirSync(dirname(cli), { recursive: true });
  mkdirSync(dirname(desktop), { recursive: true });
  for (const path of [cli, desktop, join(dirname(cli), "pacer-update-helper")])
    writeFileSync(path, "fixture", { mode: 0o755 });
  if (paired) writeFileSync(join(dirname(cli), "pacer-core"), "fixture core", { mode: 0o755 });
  writeFileSync(
    join(dirname(cli), "pacer-release.json"),
    JSON.stringify({
      schema: 1,
      bundleId: "dev.pacer.desktop",
      version: currentVersion(),
      arch: process.arch === "arm64" ? "aarch64" : "x86_64",
      protocolMajors: [3],
      admissionProtocol: 1,
      nativeTransportAbi: 1,
      rollbackCompatible: true,
      ...(paired ? { cliLayout: "paired" } : {}),
    }),
  );
  writeFileSync(
    join(app, "Contents/Info.plist"),
    `<plist><dict><key>CFBundleIdentifier</key><string>dev.pacer.desktop</string><key>CFBundleShortVersionString</key><string>${currentVersion()}</string><key>CFBundleExecutable</key><string>pacer</string></dict></plist>`,
  );
  mkdirSync(dirname(servicePath(ctx, "darwin")), { recursive: true });
  writeFileSync(servicePath(ctx, "darwin"), plist(ctx, [cli]));
  let resolve!: () => void,
    closed = false;
  const sent: any[] = [];
  const verifiedStatic: string[] = [];
  const peer = {
    auditToken: new Uint8Array(32),
    closed: new Promise<void>((r) => (resolve = r)),
    onFrame: (_value: unknown) => {},
    send: async (value: unknown) => {
      sent.push(value);
    },
    close: () => {
      closed = true;
      resolve();
    },
  };
  const bridge = new NativeControlBridge(() => ctx, {
    port: 7433,
    authority: {
      verifyPeer: (_token, role) => ({
        process: ownProcessIdentity()!,
        uid: process.getuid!(),
        executable: desktop,
        auditToken: new Uint8Array(32),
        role,
      }),
      verifyStatic: path => { verifiedStatic.push(path); },
    },
    verifyService: async () => {},
  });
  await (await import("../src/update/desktop/identity")).inspectInstallation(ctx, app);
  bridge.accept(peer);
  peer.onFrame({
    schema: 1,
    kind: "hello",
    role,
    version: currentVersion(),
    nonce: "a".repeat(64),
    challenge: sent[0].nonce,
  });
  await Bun.sleep(1);
  return {
    ctx,
    peer,
    bridge,
    sent,
    closed: () => closed,
    version: currentVersion(),
    app,
    verifiedStatic,
  };
}
test("native desktop admission verifies the paired core's signing role", async () => {
  const f = await nativeBridgeFixture("desktop", true);
  try {
    expect(f.verifiedStatic).toContain(join(f.app, "Contents/Resources/pacer-core"));
  } finally { f.bridge.stop(); }
});
test("native session appears only after signed channel readiness and is revoked on replay", async () => {
  const f = await nativeBridgeFixture();
  try {
    expect(f.bridge.sessions()).toHaveLength(0);
    const sessionId = f.sent[1].sessionId;
    f.peer.onFrame({
      schema: 1,
      kind: "desktop-ready",
      sessionId,
      sequence: 1,
      validStateRead: true,
      protocol: 3,
      serviceVersion: f.version,
      proof: null,
    });
    await Bun.sleep(1);
    const sessions = f.bridge.sessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].desktopClientId).not.toBe("public-claim");
    f.peer.onFrame({ schema: 1, kind: "heartbeat", sessionId, sequence: 1 });
    await Bun.sleep(1);
    expect(f.closed()).toBe(true);
    expect(f.bridge.sessions()).toHaveLength(0);
  } finally {
    f.bridge.stop();
  }
});

test("fixture native trust is compile-only and rejects production or mismatched lease paths", async () => {
  const { compiledNativeFixture, parseNativeFixture } = await import(
    "../src/update/desktop/native-fixture"
  );
  expect(compiledNativeFixture()).toBeNull();
  const nonce = "a".repeat(32),
    root = "/tmp/test/.work/live/lease/ota",
    home = "/tmp/test/.work/live/lease/home";
  const policy = {
    schema: 1 as const,
    root,
    home,
    nonce,
    port: 7433,
    currentApp: `${root}/current.app`,
    serviceLabel: `com.pacer.live.${nonce}.service`,
    recoveryLabel: `com.pacer.live.${nonce}.recovery`,
    uid: 501,
  };
  expect(parseNativeFixture(JSON.stringify(policy))).toEqual(policy);
  const pinned = { ...policy, signingCertSha1: "2C5405FB6D2906AE2049D59B9DF5D42661997922" };
  expect(parseNativeFixture(JSON.stringify(pinned))).toEqual(pinned);
  for (const patch of [
    { signingCertSha1: "2c5405fb6d2906ae2049d59b9df5d42661997922" },
    { signingCertSha1: "" },
    { root: "/Applications" },
    { home: "/tmp/different" },
    { port: 4317 },
    { nonce: "bad" },
    { currentApp: "/Applications/pacer.app" },
    { serviceLabel: "com.pacer.serve" },
  ])
    expect(() =>
      parseNativeFixture(JSON.stringify({ ...policy, ...patch })),
    ).toThrow();
});

test("service maintenance launch discovery binds pending intent and refuses an already different incarnation", async () => {
  const {
    readNativeTransaction,
    grantNativeTransaction,
    discoverServiceLaunch,
  } = await import("../src/update/desktop/native-record");
  const f = await nativeRecordFixture();
  const { ownProcessIdentity } = await import(
    "../src/update/desktop/process-identity"
  );
  const own = ownProcessIdentity()!;
  grantNativeTransaction(
    readNativeTransaction(f.ctx, "fixture", f.record.transactionId!),
  );
  f.fixture.journal.authorization = {
    ...f.fixture.prepared.binding,
    kind: "authorize-install",
    reservationId: f.record.transactionId,
    journalSha256: f.fixture.journal.manifestSha256,
  };
  f.fixture.journal.state = "installing";
  const intent = {
    action: {
      kind: "launch",
      role: "service",
      release: "candidate",
      launchId: "e".repeat(64),
    },
    intentRevision: 6,
    intentBootId: own.bootId,
    evidence: null as any,
  };
  f.fixture.journal.steps.push(intent);
  f.save();
  const launch = discoverServiceLaunch(
    f.ctx,
    f.fixture.prepared.target.appPath + "/Contents/Resources/pacer",
    "1.1.0",
    own,
  );
  expect(launch?.evidence).toMatchObject({
    role: "service",
    release: "candidate",
    launchId: "e".repeat(64),
    process: own,
    version: "1.1.0",
  });
  intent.evidence = {
    kind: "launched",
    launch: { ...launch!.evidence, process: { ...own, birth: "different" } },
  };
  f.save();
  expect(() =>
    discoverServiceLaunch(
      f.ctx,
      f.fixture.prepared.target.appPath + "/Contents/Resources/pacer",
      "1.1.0",
      own,
    ),
  ).toThrow();
  expect(discoverServiceLaunch(f.ctx, f.fixture.prepared.target.appPath + "/Contents/Resources/pacer", "1.1.0", {...own,bootId:"next-boot"})).toBeNull();
});

test("native helper acquisition cannot spawn from a public installation ID without session", async () => {
  const { createNativePipeFactory } = await import(
    "../src/update/desktop/native-provider"
  );
  const ctx = fakeCtx();
  let checked = false;
  const factory = createNativePipeFactory(
    () => ctx,
    { sessions: () => [], reverify: async () => {} } as any,
    {
      verifyStatic: () => {
        checked = true;
      },
    } as any,
  );
  await expect(
    factory.open("public-installation", new AbortController().signal),
  ).rejects.toThrow();
  expect(checked).toBe(false);
});

test("dedicated fixture trust verifies actual signed process and rejects changed component identity", async () => {
  if (process.platform !== "darwin") return;
  const { mkdtempSync, writeFileSync, realpathSync, chmodSync } = await import(
      "node:fs"
    ),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path");
  const { processIdentity } = await import(
    "../src/update/desktop/process-identity"
  );
  const base = join(
      realpathSync(mkdtempSync(join(tmpdir(), "pacer-native-sign-"))),
      ".work/live/lease",
    ),
    root = join(base, "ota"),
    home = join(base, "home"),
    nonce = "c".repeat(32);
  for (const dir of [base, root, home]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  const policy = {
    schema: 1 as const,
    root,
    home,
    nonce,
    port: 7433,
    currentApp: join(root, "current.app"),
    serviceLabel: `com.pacer.live.${nonce}.service`,
    recoveryLabel: `com.pacer.live.${nonce}.recovery`,
    uid: process.getuid!(),
  };
  writeFileSync(
    join(root, "record.json"),
    JSON.stringify({
      schema: 1,
      phase: "prepared",
      root,
      nonce,
      pacerHome: home,
      innerPort: 7433,
      currentApp: policy.currentApp,
      serviceLabel: policy.serviceLabel,
      recoveryLabel: policy.recoveryLabel,
      ownerUid: policy.uid,
    }),
    { mode: 0o600 },
  );
  const source = join(root, "probe.c"),
    binary = join(root, "pacer");
  writeFileSync(
    source,
    '#include <unistd.h>\nint main(){write(1,"ready",5);sleep(30);return 0;}\n',
  );
  expect(
    Bun.spawnSync(["/usr/bin/clang", source, "-o", binary], { stderr: "pipe" })
      .exitCode,
  ).toBe(0);
  expect(
    Bun.spawnSync(
      [
        "/usr/bin/codesign",
        "--force",
        "--sign",
        "-",
        "--identifier",
        "dev.pacer.cli",
        binary,
      ],
      { stderr: "pipe" },
    ).exitCode,
  ).toBe(0);
  const child = Bun.spawn([binary], { stdout: "pipe", stderr: "ignore" });
  const reader = child.stdout.getReader();
  await reader.read();
  reader.releaseLock();
  try {
    const authority = new DarwinAuthority({}, policy);
    authority.verifyStatic(binary, "cli");
    expect(
      authority.verifyProcess(processIdentity(child.pid)!, "cli").executable,
    ).toBe(binary);
    expect(() =>
      authority.verifyProcess(processIdentity(child.pid)!, "helper"),
    ).toThrow();
  } finally {
    child.kill("SIGTERM");
    await child.exited;
  }
});

test("native authority files reject hard links and malformed service-grant schemas", async () => {
  const { readNativeTransaction, grantNativeTransaction, privateNativeBytes } =
    await import("../src/update/desktop/native-record");
  const { readFileSync, writeFileSync, linkSync, unlinkSync } = await import(
    "node:fs"
  );
  const { join } = await import("node:path");
  const f = await nativeRecordFixture();
  const file = join(f.dir, "prepared.json"),
    alias = join(f.dir, "alias");
  linkSync(file, alias);
  expect(() => privateNativeBytes(file)).toThrow();
  unlinkSync(alias);
  grantNativeTransaction(
    readNativeTransaction(f.ctx, "fixture", f.record.transactionId!),
  );
  const grantPath = join(f.dir, "service-grant.json"),
    grant = JSON.parse(readFileSync(grantPath, "utf8"));
  f.fixture.journal.authorization = grant.authorization;
  f.fixture.journal.state = "authorized";
  f.save();
  for (const patch of [{ schema: 2 }, { unexpected: true }]) {
    writeFileSync(grantPath, JSON.stringify({ ...grant, ...patch }));
    expect(() =>
      readNativeTransaction(f.ctx, "fixture", f.record.transactionId!),
    ).toThrow();
  }
});

test("recovery helper identity uses current signed bundle version while transaction target stays old",async()=>{
 const {nativeHelperIdentity}=await import("../src/update/desktop/native-provider");const {readFileSync,writeFileSync}=await import("node:fs"),{join}=await import("node:path");const f=await nativeBridgeFixture();
 try{
  f.peer.onFrame({schema:1,kind:"desktop-ready",sessionId:f.sent[1].sessionId,sequence:1,validStateRead:true,protocol:3,serviceVersion:f.version,proof:null});await Bun.sleep(1);
  const original=f.bridge.sessions()[0].installation,metadata=join(original.appPath,"Contents/Resources/pacer-release.json"),info=join(original.appPath,"Contents/Info.plist");
  const release=JSON.parse(readFileSync(metadata,"utf8"));release.version="99.0.0";writeFileSync(metadata,JSON.stringify(release));writeFileSync(info,readFileSync(info,"utf8").replace(f.version,"99.0.0"));
  expect((await nativeHelperIdentity(f.ctx,original)).version).toBe("99.0.0");expect(original.version).toBe(f.version);
 }finally{f.bridge.stop();}
});

test("recovery acquisition selects original digest-bound helper and rejects replacement", async () => {
  const { nativeRecoveryHelper } = await import("../src/update/desktop/native-provider");
  const { readNativeTransaction, grantNativeTransaction } = await import("../src/update/desktop/native-record");
  const { writeFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const f = await nativeRecordFixture();
  const bytes = Buffer.from("original signed helper");
  f.fixture.prepared.recoveryJob.helper = {relativePath:"pacer-update-helper",sha256:createHash("sha256").update(bytes).digest("hex")};
  writeFileSync(`${f.dir}/pacer-update-helper`,bytes,{mode:0o700});
  f.save();
  grantNativeTransaction(readNativeTransaction(f.ctx,"fixture",f.record.transactionId!));
  const grant=JSON.parse(await Bun.file(`${f.dir}/service-grant.json`).text());
  f.fixture.journal.authorization=grant.authorization;f.fixture.journal.state="authorized";f.save();
  const selected=nativeRecoveryHelper(f.ctx,"fixture",f.record.transactionId!);
  expect(selected.source).toBe((await import("node:fs")).realpathSync(`${f.dir}/pacer-update-helper`));
  expect(selected.identity.version).toBe("1.0.0");
  writeFileSync(selected.source,"replacement candidate helper");
  expect(()=>nativeRecoveryHelper(f.ctx,"fixture",f.record.transactionId!)).toThrow();
});

test("terminal cleanup retains original receipt authority after core advances without weakening install reads", async()=>{
 const {readNativeCleanup,readNativeTransaction,grantNativeTransaction}=await import("../src/update/desktop/native-record");const f=await nativeRecordFixture();
 grantNativeTransaction(readNativeTransaction(f.ctx,"fixture",f.record.transactionId!));const grant=JSON.parse(await Bun.file(`${f.dir}/service-grant.json`).text());
 f.fixture.journal.authorization=grant.authorization;f.fixture.journal.state="committed";f.save();
 f.writeUpdate(f.ctx,{...f.record,phase:"idle",candidate:null,transactionId:null,requestId:null,requestedBy:null,requesterBootId:null},f.record.revision);
 expect(()=>readNativeTransaction(f.ctx,"fixture",f.record.transactionId!)).toThrow();
 expect(readNativeCleanup(f.ctx,"fixture",f.record.transactionId!).authorization).not.toBeNull();
 f.fixture.journal.state="installing";f.save();expect(()=>readNativeCleanup(f.ctx,"fixture",f.record.transactionId!)).toThrow();
});

test("grantless terminal cleanup requires unchanged original hash and rejects destructive actions",async()=>{
 const {readNativeCleanup,readNativeTransaction}=await import("../src/update/desktop/native-record");const f=await nativeRecordFixture();
 f.fixture.journal.state="restored";f.save();expect(()=>readNativeCleanup(f.ctx,"fixture",f.record.transactionId!)).toThrow();
 f.fixture.journal.unchangedOriginal={sha256:f.fixture.prepared.oldBundleBackup.sha256,observedAt:{bootId:"boot-one",millis:42}};f.save();
 expect(readNativeCleanup(f.ctx,"fixture",f.record.transactionId!).authorization).toBeNull();
 expect(()=>readNativeTransaction(f.ctx,"fixture",f.record.transactionId!)).toThrow();
 f.fixture.journal.steps.push({action:{kind:"install-candidate"},intentRevision:8,intentBootId:"boot-one",evidence:null});f.save();expect(()=>readNativeCleanup(f.ctx,"fixture",f.record.transactionId!)).toThrow();
});

test("fixture coexistence scope excludes production paths without granting them authority",async()=>{
 const {fixtureProcessInScope}=await import("../src/update/desktop/native-fixture");
 const policy={root:"/tmp/.work/live/lease/ota",home:"/tmp/.work/live/lease/home"} as any;
 expect(fixtureProcessInScope(policy,"/opt/pacer")).toBe(false);
 expect(fixtureProcessInScope(policy,policy.root+"/current.app/Contents/Resources/pacer")).toBe(true);
 expect(fixtureProcessInScope(policy,policy.root+"-other/pacer")).toBe(false);
 expect(fixtureProcessInScope(policy,policy.home+"/desktop-updates/native/id/tx/pacer-update-helper")).toBe(true);
 expect(fixtureProcessInScope(policy,null)).toBe(false);
});

test("fresh helper cleanup removes only exact exited-child assets and retains ambiguous contents",async()=>{
 const {freshHelperCleanup}=await import("../src/update/desktop/native-command-cleanup");const fs=await import("node:fs"),{join}=await import("node:path");
 for(const change of ["none","replacement","extra","live"]){
  const ctx=fakeCtx();fs.mkdirSync(ctx.pacerHome,{mode:0o700});const dir=fs.realpathSync(ctx.pacerHome),file=join(dir,"pacer-update-helper");fs.writeFileSync(file,"original",{mode:0o700});
  const owner={pid:99999,bootId:"boot",birth:"1:1"};const cleanup=freshHelperCleanup(file,owner,()=>change==="live"?owner:null);
  if(change==="replacement"){fs.unlinkSync(file);fs.writeFileSync(file,"replacement",{mode:0o700});}
  if(change==="extra")fs.writeFileSync(join(dir,"unrelated"),"keep");
  cleanup();expect(fs.existsSync(dir)).toBe(change!=="none");
 }
});


test("authenticated helper cannot acquire fixture cleanup authority in a production or source build",async()=>{
 const f=await nativeBridgeFixture("helper");
 try{f.peer.onFrame({schema:1,kind:"fixture-cleanup",sessionId:f.sent[1].sessionId,sequence:1});await Bun.sleep(1);expect(f.closed()).toBe(true);
 const {hasReservation}=await import("../src/update/desktop/admission");expect(hasReservation(f.ctx,"fixture-cleanup-"+"a".repeat(32))).toBe(false);
 }finally{f.bridge.stop();}
});

test("helper can reverify download context after progress without acquiring transaction authority", async () => {
  const { readUpdate, writeUpdate } = await import("../src/update/desktop/store");
  const { ownProcessIdentity } = await import("../src/update/desktop/process-identity");
  for (const [phase, revision, allowed] of [["downloading", 0, true], ["checking", 0, true], ["downloading", 2, false], ["idle", 0, false], ["error", 0, false]] as const) {
    const f = await nativeBridgeFixture("helper");
    try {
      const value = readUpdate(f.ctx, "fixture");
      writeUpdate(f.ctx, { ...value, phase }, value.revision);
      const session = { installation: { id: "fixture" }, sessionId: "session", desktop: ownProcessIdentity(), service: ownProcessIdentity() } as any;
      let verified = 0;
      f.bridge.sessions = () => [session];
      f.bridge.reverify = async () => { verified++; };
      const binding = { schema: 1, commandId: "command", installationId: "fixture", transactionId: null, revision, nonce: "b".repeat(64) };
      f.peer.onFrame({ schema: 1, kind: "helper-context", sessionId: f.sent[1].sessionId, sequence: 1, binding });
      await Bun.sleep(5);
      expect(f.closed()).toBe(!allowed);
      if (allowed) {
        expect(verified).toBe(1);
        expect(f.sent.at(-1).binding).toEqual(binding);
        expect(f.sent.at(-1).transaction).toBeNull();
      }
    } finally { f.bridge.stop(); }
  }
});

test("native shutdown acknowledges consumption before the desktop closes its authenticated channel", async () => {
  const f = await nativeBridgeFixture();
  try {
    const connection = [...(f.bridge as any).connections][0];
    const finished = (f.bridge as any).effect(connection, "shutdown", { schema: 1, commandId: "command", installationId: "fixture", transactionId: "transaction", revision: 1, nonce: "b".repeat(64) });
    const effectId = f.sent.at(-1).effectId;
    expect(f.sent.at(-1).kind).toBe("shutdown");
    f.peer.onFrame({ schema: 1, kind: "effect-ack", sessionId: f.sent[1].sessionId, sequence: 1, effectId });
    await finished;
    expect(f.sent.at(-1)).toEqual({ schema: 1, kind: "effect-accepted", effectId });
    f.peer.close();
  } finally { f.bridge.stop(); }
});

test("unready candidate service cleanup requires the exact authorized managed launch and completed predecessors",async()=>{
 const {readNativeTransaction,grantNativeTransaction}=await import("../src/update/desktop/native-record");
 const f=await nativeRecordFixture();
 grantNativeTransaction(readNativeTransaction(f.ctx,"fixture",f.record.transactionId!));
 const grant=JSON.parse(await Bun.file(`${f.dir}/service-grant.json`).text());
 f.fixture.journal.authorization=grant.authorization;
 f.fixture.journal.state="restoring";
 const launchId="a".repeat(64),boot="boot-one";
 const step=(action:unknown,evidence:unknown={kind:"complete"})=>({action,evidence,intentBootId:boot,intentRevision:1});
 const steps=[
  step({kind:"suppress-lifecycle"}),
  step({kind:"stop",role:"desktop",process:f.fixture.prepared.oldDesktop}),
  step({kind:"stop",role:"service",process:f.fixture.prepared.oldService}),
  step({kind:"install-candidate"}),step({kind:"switch-registration"}),
  step({kind:"launch",role:"service",release:"candidate",launchId},null),
  step({kind:"stop-unready-candidate-service",launchId}),
 ];
 const read=()=>readNativeTransaction(f.ctx,"fixture",f.record.transactionId!);
 f.fixture.journal.steps=steps;f.save();expect(read().authorization).not.toBeNull();
 f.fixture.journal.state="installing";f.save();expect(read).toThrow();f.fixture.journal.state="restoring";
 for(let index=0;index<6;index++){
  f.fixture.journal.steps=steps.filter((_,i)=>i!==index);f.save();expect(read).toThrow();
 }
 for(const changed of [
  [...steps.slice(0,-1),step({kind:"stop-unready-candidate-service",launchId,path:"untrusted"})],
  [...steps.slice(0,-1),{...steps.at(-1),intentBootId:"another-boot"}],
  [...steps,step({kind:"launch",role:"desktop",release:"candidate",launchId:"b".repeat(64)},null)],
  [...steps.slice(0,5),step({kind:"launch",role:"service",release:"candidate",launchId}),steps[6]],
  [...steps.slice(0,-1),step({kind:"stop-unready-candidate-service",launchId},{kind:"unknown"})],
  [steps[6],...steps.slice(0,6)],
 ]){f.fixture.journal.steps=changed;f.save();expect(read).toThrow();}
});

test("native helper factory advertises service adoption and its recovery", async () => {
  const { createNativePipeFactory } = await import("../src/update/desktop/native-provider");
  const ctx = fakeCtx();
  const factory = createNativePipeFactory(() => ctx, { sessions: () => [], reverify: async () => {} }, {} as never);
  expect([...factory.capabilities].sort()).toEqual(["adopt", "check", "download", "install", "recover", "recover-adoption"]);
});
