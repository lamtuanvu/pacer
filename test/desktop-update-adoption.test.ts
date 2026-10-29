import { expect, test } from "bun:test";
import { fakeCtx } from "./helpers";
import {
  beginAdoption,
  cancelAdoption,
  readAdoption,
  transitionAdoption,
} from "../src/update/desktop/adoption-store";
import { readUpdate, writeUpdate } from "../src/update/desktop/store";
import type { Installation } from "../src/update/desktop/types";

test("native adoption rejects a takeover manifest", async () => {
  const { readNativeAdoption } = await import("../src/update/desktop/native-adoption");
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const f = await nativeFixture();
  const bytes = readFileSync(join(import.meta.dir, "fixtures/desktop-update/takeover-manifest.json"));
  f.fs.writeFileSync(f.join(f.dir, "adoption-prepared.json"), bytes);
  expect(() => readNativeAdoption(f.ctx, "attached", f.record.transactionId)).toThrow();
});

function fixture() {
  const ctx = fakeCtx(),
    target: Installation = {
      id: "attached",
      appPath: "/tmp/pacer.app",
      bundleId: "dev.pacer.desktop",
      ownerUid: process.getuid?.() ?? 0,
      arch: "aarch64",
      pacerHome: ctx.pacerHome,
      port: 7433,
      serviceLabel: "com.pacer.serve",
      ownership: "attached",
      version: "1.0.0",
    };
  const authority = {
    target,
    nativeSessionId: "native",
    desktopClientId: "desktop",
    bootId: "boot",
    desktop: { pid: 101, bootId: "boot", birth: "1:1" },
    service: { pid: 102, bootId: "boot", birth: "1:2" },
    serviceVersion: "1.0.0",
    oldServiceExecutable: "/opt/pacer",
    newServiceExecutable: "/tmp/pacer.app/Contents/Resources/pacer",
  };
  return {
    ctx,
    target,
    authority,
    request: {
      installationId: target.id,
      requestId: "adopt-one",
      expectRevision: 0,
    },
  };
}
test("adoption intent and receipt are one SQLite mutation without an update candidate or JSON mutation", () => {
  const f = fixture(),
    before = readUpdate(f.ctx, f.target.id);
  const adopted = beginAdoption(f.ctx, f.request, f.authority);
  expect(adopted).toMatchObject({
    phase: "waiting",
    revision: 1,
    installationId: "attached",
  });
  expect(adopted.receipts).toHaveLength(1);
  expect(readAdoption(f.ctx, f.target.id)).toEqual(adopted);
  expect(readUpdate(f.ctx, f.target.id)).toEqual(before);
});
test("adoption exact retries replay original intent and altered authority or stale requests conflict", () => {
  const f = fixture(),
    first = beginAdoption(f.ctx, f.request, f.authority);
  expect(beginAdoption(f.ctx, f.request, f.authority)).toEqual(first);
  expect(() =>
    beginAdoption(
      f.ctx,
      { ...f.request, requestId: "stale", expectRevision: 1 },
      f.authority,
    ),
  ).toThrow();
  expect(() =>
    beginAdoption(f.ctx, f.request, {
      ...f.authority,
      oldServiceExecutable: "/opt/other",
    }),
  ).toThrow();
});
test("adoption cancellation uses its own revision and exact retry cannot rearm it", () => {
  const f = fixture(),
    first = beginAdoption(f.ctx, f.request, f.authority),
    request = {
      installationId: f.target.id,
      requestId: "cancel",
      expectRevision: first.revision,
    };
  const cancelled = cancelAdoption(f.ctx, request);
  expect(cancelled.phase).toBe("cancelled");
  expect(cancelAdoption(f.ctx, request)).toEqual(cancelled);
  expect(beginAdoption(f.ctx, f.request, f.authority)).toEqual(cancelled);
});
test("authorized adoption cannot cancel and invalid transition cannot escape durable maintenance", () => {
  const f = fixture(),
    first = beginAdoption(f.ctx, f.request, f.authority);
  const reserved = transitionAdoption(
    f.ctx,
    f.target.id,
    first.revision,
    "reserved",
  );
  const installing = transitionAdoption(
    f.ctx,
    f.target.id,
    reserved.revision,
    "installing",
  );
  expect(() =>
    cancelAdoption(f.ctx, {
      installationId: f.target.id,
      requestId: "cancel",
      expectRevision: installing.revision,
    }),
  ).toThrow();
  expect(() =>
    transitionAdoption(f.ctx, f.target.id, installing.revision, "cancelled"),
  ).toThrow();
});
test("pending adoption blocks update CAS mutations and a competing installation adoption", () => {
  const f = fixture();
  beginAdoption(f.ctx, f.request, f.authority);
  const current = readUpdate(f.ctx, f.target.id);
  expect(() =>
    writeUpdate(f.ctx, { ...current, autoDownload: false }, current.revision),
  ).toThrow();
  expect(() =>
    beginAdoption(
      f.ctx,
      { ...f.request, installationId: "other" },
      { ...f.authority, target: { ...f.target, id: "other" } },
    ),
  ).toThrow();
});
test("an older request replays its terminal outcome after a newer adoption begins", () => {
  const f = fixture(),
    first = beginAdoption(f.ctx, f.request, f.authority);
  const old = cancelAdoption(f.ctx, {
    installationId: f.target.id,
    requestId: "cancel-old",
    expectRevision: first.revision,
  });
  const next = beginAdoption(
    f.ctx,
    { ...f.request, requestId: "new-adopt" },
    f.authority,
  );
  expect(next.transactionId).not.toBe(first.transactionId);
  expect(beginAdoption(f.ctx, f.request, f.authority)).toMatchObject({
    transactionId: first.transactionId,
    phase: "cancelled",
    revision: old.revision,
  });
  expect(readAdoption(f.ctx, f.target.id)?.transactionId).toBe(
    next.transactionId,
  );
});

test("adoption runtime waits for idle and cancelled native permission never rearms", async () => {
  const { createAdoptionRuntime } = await import(
    "../src/update/desktop/adoption-service"
  );
  const f = fixture();
  let alive = true;
  const calls: string[] = [];
  const session = {
    installation: f.target,
    desktopClientId: "desktop",
    sessionId: "native",
    bootId: "boot",
    desktop: f.authority.desktop,
    service: f.authority.service,
    alive: () => alive,
    closed: new Promise<void>(() => {}),
  };
  const runtime = createAdoptionRuntime(() => f.ctx, {
    native: {
      sessions: () => [session],
      reverify: async () => {},
      inspectAdoption: () => f.authority,
      authorizeAdoption: async () => true,
      verifyAdoptionOutcome: async () => {
        throw Error("unexpected outcome");
      },
    },
    adapter: {
      capabilities: new Set(["adopt", "recover-adoption"]),
      open: async () => {
        calls.push("open");
        throw Error("unexpected helper");
      },
    },
    admission: {
      reserveIdle: async () => ({
        reserved: false,
        blockers: [{ kind: "task", id: "busy", label: "Running task" }],
      }),
      releaseReservation: async () => {
        calls.push("release");
      },
    },
    bootId: () => "boot",
  });
  const waiting = await runtime.adopt(f.request);
  expect(waiting.phase).toBe("waiting");
  await runtime.tick();
  expect(readAdoption(f.ctx, "attached")?.blockers[0]?.id).toBe("busy");
  alive = false;
  await runtime.tick();
  expect(readAdoption(f.ctx, "attached")?.phase).toBe("cancelled");
  expect(calls).not.toContain("open");
  runtime.stop();
});
test("adoption authority reads reject hardlinked and redirected SQLite state", async () => {
  const fs = await import("node:fs"),
    { join } = await import("node:path");
  const f = fixture();
  beginAdoption(f.ctx, f.request, f.authority);
  const path = join(f.ctx.pacerHome, "desktop-updates/admission.sqlite"),
    alias = path + ".alias";
  fs.linkSync(path, alias);
  expect(() => readAdoption(f.ctx, "attached")).toThrow();
  fs.unlinkSync(alias);
  fs.renameSync(path, alias);
  fs.symlinkSync(alias, path);
  expect(() => readAdoption(f.ctx, "attached")).toThrow();
});
test("adoption revision exhaustion preserves durable state", async () => {
  const f = fixture(),
    first = beginAdoption(f.ctx, f.request, f.authority);
  cancelAdoption(f.ctx, {
    installationId: "attached",
    requestId: "cancel",
    expectRevision: first.revision,
  });
  const { withDesktopCoordinator } = await import(
    "../src/update/desktop/coordinator"
  );
  withDesktopCoordinator(f.ctx, (db) => {
    const row = db
      .query<{ body: string }, []>("SELECT body FROM desktop_adoptions")
      .get()!;
    const value = JSON.parse(row.body);
    value.revision = Number.MAX_SAFE_INTEGER;
    db.query("UPDATE desktop_adoptions SET body=?").run(JSON.stringify(value));
  });
  expect(() =>
    beginAdoption(f.ctx, { ...f.request, requestId: "new" }, f.authority),
  ).toThrow();
  expect(readAdoption(f.ctx, "attached")?.revision).toBe(
    Number.MAX_SAFE_INTEGER,
  );
});

test("adoption recovery can finish preauthorization abort while retaining exact original reservation", async () => {
  const { createAdoptionRuntime } = await import(
    "../src/update/desktop/adoption-service"
  );
  const { FrameDecoder, encodeFrame, parseAdapterCommand } = await import(
    "../src/update/desktop/adapter"
  );
  const f = fixture(),
    first = beginAdoption(f.ctx, f.request, f.authority);
  transitionAdoption(f.ctx, "attached", first.revision, "reserved");
  const released: string[] = [],
    session = {
      installation: f.target,
      desktopClientId: "desktop",
      sessionId: "native",
      bootId: "boot",
      desktop: f.authority.desktop,
      service: f.authority.service,
      alive: () => true,
      closed: new Promise<void>(() => {}),
    };
  const runtime = createAdoptionRuntime(() => f.ctx, {
    native: {
      sessions: () => [session],
      reverify: async () => {},
      inspectAdoption: () => f.authority,
      authorizeAdoption: async () => {
        throw Error("recovery cannot reauthorize");
      },
      verifyAdoptionOutcome: async () => ({
        installation: f.target,
        attempted: false,
      }),
    },
    adapter: {
      capabilities: new Set(["adopt", "recover-adoption"]),
      async open() {
        let output!: ReadableStreamDefaultController<Uint8Array>;
        const decoder = new FrameDecoder();
        return {
          identity: {
            version: "1.0.0",
            arch: "aarch64",
            bundleId: "dev.pacer.desktop",
          },
          stdout: new ReadableStream({
            start(c) {
              output = c;
            },
          }),
          stdin: new WritableStream({
            write(bytes) {
              const command = parseAdapterCommand(decoder.push(bytes)[0]);
              expect(command.command).toBe("recover-adoption");
              const { command: _, ...binding } = command;
              output.enqueue(
                encodeFrame({
                  ...binding,
                  sequence: 0,
                  kind: "hello",
                  version: "1.0.0",
                  arch: "aarch64",
                  bundleId: "dev.pacer.desktop",
                }),
              );
              output.enqueue(
                encodeFrame({
                  ...binding,
                  sequence: 1,
                  kind: "outcome",
                  outcome: "restored",
                }),
              );
              output.close();
            },
          }),
          exited: Promise.resolve(0),
          abort() {
            throw Error("cannot abort recovery");
          },
        };
      },
    },
    admission: {
      reserveIdle: async () => {
        throw Error("cannot acquire a new recovery reservation");
      },
      releaseReservation: async (_ctx, tx) => {
        released.push(tx);
      },
    },
    bootId: () => "boot",
  });
  await runtime.start();
  await runtime.tick();
  await runtime.settled();
  expect(readAdoption(f.ctx, "attached")?.phase).toBe("restored");
  expect(released).toEqual([first.transactionId]);
  runtime.stop();
});

test("reconnected adoption request replays original permission without granting the new native session", () => {
  const f = fixture(),
    first = beginAdoption(f.ctx, f.request, f.authority);
  const replay = beginAdoption(f.ctx, f.request, {
    ...f.authority,
    nativeSessionId: "reconnected",
    desktopClientId: "new-client",
    desktop: { ...f.authority.desktop, pid: 201 },
  });
  expect(replay).toEqual(first);
  expect(replay.authority.nativeSessionId).toBe("native");
});

async function nativeFixture() {
  const f = fixture();
  const fs = await import("node:fs"),
    { join } = await import("node:path"),
    { createHash } = await import("node:crypto");
  const first = beginAdoption(f.ctx, f.request, f.authority),
    record = transitionAdoption(f.ctx, "attached", first.revision, "reserved");
  const binding = {
    schema: 1,
    commandId: "adoption-command",
    installationId: "attached",
    transactionId: record.transactionId,
    revision: record.revision,
    nonce: "a".repeat(64),
  };
  const manifest = {
    schema: 1,
    transactionKind: "adoption",
    binding,
    source: f.authority,
    request: {
      requestId: record.receipts[0]!.requestId,
      fingerprint: record.receipts[0]!.fingerprint,
    },
    expectedNewInstallationId: "managed",
    managedLaunchId: "b".repeat(64),
    originalLaunchId: "c".repeat(64),
    oldRegistration: { relativePath: "original.plist", sha256: "d".repeat(64) },
    newRegistration: { relativePath: "managed.plist", sha256: "e".repeat(64) },
    recoveryJob: {
      label: "com.pacer.recovery",
      helper: { relativePath: "pacer-update-helper", sha256: "f".repeat(64) },
    },
  };
  const dir = join(
    f.ctx.pacerHome,
    "desktop-updates/native/attached",
    record.transactionId,
  );
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const text = JSON.stringify(manifest),
    digest = createHash("sha256").update(text).digest("hex");
  fs.writeFileSync(join(dir, "adoption-prepared.json"), text, { mode: 0o600 });
  const journal = {
    schema: 1,
    transactionKind: "adoption",
    revision: 0,
    manifestSha256: digest,
    state: "prepared",
    authorization: null,
    steps: [],
    verificationStarted: null,
    restorationStarted: null,
    restorationHistory: [],
    verificationProof: null,
    restorationProof: null,
    unchangedRegistration: null,
    error: null,
  };
  const save = () =>
    fs.writeFileSync(
      join(dir, "adoption-journal.json"),
      JSON.stringify(journal),
      { mode: 0o600 },
    );
  save();
  return {
    ...f,
    dir,
    digest,
    record,
    binding,
    manifest,
    journal,
    save,
    fs,
    join,
  };
}
test("native adoption authority binds its candidate-free manifest, SQLite receipt and separate grant", async () => {
  const { readNativeAdoption, grantNativeAdoption } = await import(
    "../src/update/desktop/native-adoption"
  );
  const f = await nativeFixture();
  const tx = readNativeAdoption(f.ctx, "attached", f.record.transactionId);
  expect(tx.digest).toBe(f.digest);
  grantNativeAdoption(tx);
  const grant = JSON.parse(
    f.fs.readFileSync(f.join(f.dir, "service-adoption-grant.json"), "utf8"),
  );
  expect(grant.transactionKind).toBe("adoption");
  f.journal.authorization = grant.authorization;
  f.journal.state = "authorized";
  f.save();
  expect(
    readNativeAdoption(f.ctx, "attached", f.record.transactionId).authorization,
  ).toEqual(grant.authorization);
  grant.transactionKind = "update";
  f.fs.writeFileSync(
    f.join(f.dir, "service-adoption-grant.json"),
    JSON.stringify(grant),
  );
  expect(() =>
    readNativeAdoption(f.ctx, "attached", f.record.transactionId),
  ).toThrow();
});
test("grantless adoption cleanup requires unchanged original registration and cleanup-only effects", async () => {
  const { readNativeAdoption } = await import(
    "../src/update/desktop/native-adoption"
  );
  const f = await nativeFixture();
  f.journal.state = "restored";
  f.save();
  expect(() =>
    readNativeAdoption(f.ctx, "attached", f.record.transactionId, true),
  ).toThrow();
  (f.journal as any).unchangedRegistration = {
    sha256: f.manifest.oldRegistration.sha256,
    observedAt: { bootId: "boot", millis: 1 },
  };
  f.save();
  expect(
    readNativeAdoption(f.ctx, "attached", f.record.transactionId, true)
      .authorization,
  ).toBeNull();
  (f.journal.steps as any[]).push({
    action: { kind: "stop-service", process: f.authority.service },
    intentRevision: 1,
    intentBootId: "boot",
    evidence: null,
  });
  f.save();
  expect(() =>
    readNativeAdoption(f.ctx, "attached", f.record.transactionId, true),
  ).toThrow();
});

test("terminal adoption request replays after old native installation session disappears", async () => {
  const { createAdoptionRuntime } = await import(
    "../src/update/desktop/adoption-service"
  );
  const f = fixture(),
    first = beginAdoption(f.ctx, f.request, f.authority),
    reserved = transitionAdoption(
      f.ctx,
      "attached",
      first.revision,
      "reserved",
    ),
    verifying = transitionAdoption(
      f.ctx,
      "attached",
      reserved.revision,
      "verifying",
    );
  transitionAdoption(f.ctx, "attached", verifying.revision, "committed", {
    resultingInstallationId: "managed",
  });
  const runtime = createAdoptionRuntime(() => f.ctx, {
    native: {
      sessions: () => [],
      reverify: async () => {
        throw Error("must not require a gone old session");
      },
    },
    bootId: () => "boot",
  });
  expect(await runtime.adopt(f.request)).toMatchObject({
    phase: "committed",
    resultingInstallationId: "managed",
    transactionId: first.transactionId,
  });
  await expect(
    runtime.adopt({ ...f.request, expectRevision: 1 }),
  ).rejects.toMatchObject({ code: "conflict" });
  runtime.stop();
});

test("adoption fresh service connection binds branch intent, unchanged desktop and current boot", async () => {
  const {
    readNativeAdoption,
    grantNativeAdoption,
    adoptionReconnectPlan,
    verifyAdoptionLaunch,
  } = await import("../src/update/desktop/native-adoption");
  const f = await nativeFixture();
  let tx = readNativeAdoption(f.ctx, "attached", f.record.transactionId);
  grantNativeAdoption(tx);
  f.journal.authorization = JSON.parse(
    f.fs.readFileSync(f.join(f.dir, "service-adoption-grant.json"), "utf8"),
  ).authorization;
  f.journal.state = "switching";
  f.journal.revision = 1;
  (f.journal.steps as any[]).push({
    action: {
      kind: "launch-service",
      branch: "managed",
      launchId: f.manifest.managedLaunchId,
    },
    intentRevision: 1,
    intentBootId: "boot",
    evidence: null,
  });
  f.save();
  tx = readNativeAdoption(f.ctx, "attached", f.record.transactionId);
  const plan = adoptionReconnectPlan(tx),
    service = { pid: 301, bootId: "boot", birth: "new-service" };
  expect(
    verifyAdoptionLaunch(
      f.ctx,
      plan,
      f.authority.desktop,
      service,
      f.authority.newServiceExecutable,
      "1.0.0",
    ).selected.branch,
  ).toBe("managed");
  expect(() =>
    verifyAdoptionLaunch(
      f.ctx,
      plan,
      { ...f.authority.desktop, pid: 999 },
      service,
      f.authority.newServiceExecutable,
      "1.0.0",
    ),
  ).toThrow();
  expect(() =>
    verifyAdoptionLaunch(
      f.ctx,
      plan,
      f.authority.desktop,
      { ...service, bootId: "reboot" },
      f.authority.newServiceExecutable,
      "1.0.0",
    ),
  ).toThrow();
  expect(() =>
    verifyAdoptionLaunch(
      f.ctx,
      plan,
      f.authority.desktop,
      service,
      f.authority.oldServiceExecutable,
      "1.0.0",
    ),
  ).toThrow();
});

test("adoption snapshot refuses redirected SQLite sidecars", async () => {
  const f = fixture();
  beginAdoption(f.ctx, f.request, f.authority);
  const fs = await import("node:fs"),
    { join } = await import("node:path");
  const sidecar = join(f.ctx.pacerHome, "desktop-updates/admission.sqlite-wal"),
    target = join(f.ctx.pacerHome, "unrelated");
  fs.writeFileSync(target, "", { mode: 0o600 });
  fs.symlinkSync(target, sidecar);
  expect(() => readAdoption(f.ctx, "attached")).toThrow();
});

test("reboot adoption reconnect is original-only and uses durable fresh desktop capability", async () => {
  const {
    readNativeAdoption,
    grantNativeAdoption,
    adoptionReconnectPlan,
    verifyAdoptionLaunch,
  } = await import("../src/update/desktop/native-adoption");
  const f = await nativeFixture();
  grantNativeAdoption(
    readNativeAdoption(f.ctx, "attached", f.record.transactionId),
  );
  f.journal.authorization = JSON.parse(
    f.fs.readFileSync(f.join(f.dir, "service-adoption-grant.json"), "utf8"),
  ).authorization;
  f.journal.state = "restoring";
  f.journal.revision = 2;
  const desktop = { pid: 201, bootId: "new-boot", birth: "2:1" },
    service = { pid: 202, bootId: "new-boot", birth: "2:2" },
    capability = {
      desktop,
      originalLaunchId: "9".repeat(64),
      bootId: "new-boot",
      nativeSessionId: "new-native",
    };
  (f.journal as any).recoveryReconnects = [capability];
  (f.journal.steps as any[]).push(
    {
      action: {
        kind: "launch-service",
        branch: "original",
        launchId: capability.originalLaunchId,
      },
      intentRevision: 1,
      intentBootId: "new-boot",
      evidence: null,
    },
    {
      action: { kind: "prepare-recovery-reconnect", capability },
      intentRevision: 2,
      intentBootId: "new-boot",
      evidence: null,
    },
  );
  f.save();
  const tx = readNativeAdoption(f.ctx, "attached", f.record.transactionId),
    plan = adoptionReconnectPlan(tx);
  expect(plan).toMatchObject({
    recovery: true,
    managed: null,
    desktop,
    nativeSessionId: "new-native",
    original: { launchId: capability.originalLaunchId },
  });
  expect(
    verifyAdoptionLaunch(
      f.ctx,
      plan,
      desktop,
      service,
      f.authority.oldServiceExecutable,
      "1.0.0",
    ).selected.branch,
  ).toBe("original");
  expect(() =>
    verifyAdoptionLaunch(
      f.ctx,
      plan,
      desktop,
      service,
      f.authority.newServiceExecutable,
      "1.0.0",
    ),
  ).toThrow();
  expect(() =>
    verifyAdoptionLaunch(
      f.ctx,
      plan,
      f.authority.desktop,
      service,
      f.authority.oldServiceExecutable,
      "1.0.0",
    ),
  ).toThrow();
});

test("adoption lifecycle and registration intents may repeat only on distinct boots",async()=>{
 const {readNativeAdoption,grantNativeAdoption}=await import("../src/update/desktop/native-adoption");
 const f=await nativeFixture(),read=()=>readNativeAdoption(f.ctx,"attached",f.record.transactionId);
 grantNativeAdoption(read());f.journal.authorization=JSON.parse(f.fs.readFileSync(f.join(f.dir,"service-adoption-grant.json"),"utf8")).authorization;
 f.journal.state="restoring";
 const step=(action:unknown,boot:string)=>({action,intentBootId:boot,intentRevision:0,evidence:{kind:"complete"}});
 for(const action of [{kind:"suppress-lifecycle"},{kind:"switch-registration",branch:"original"}]){
  (f.journal.steps as any[])=[step(action,"boot-one"),step(action,"boot-two")];f.save();expect(read().journal.steps).toHaveLength(2);
  (f.journal.steps as any[])=[step(action,"boot-one"),step(action,"boot-one")];f.save();expect(read).toThrow();
 }
 (f.journal.steps as any[])=[step({kind:"release-reservation"},"boot-one"),step({kind:"release-reservation"},"boot-two")];f.save();expect(read).toThrow();
});
test("native adoption journal carries the error that started restoration", async () => {
  const { readNativeAdoption } = await import(
    "../src/update/desktop/native-adoption"
  );
  const f = await nativeFixture();
  (f.journal as any).restorationCause = "recovery-failed";
  f.save();
  expect(
    readNativeAdoption(f.ctx, "attached", f.record.transactionId).digest,
  ).toBe(f.digest);
});
