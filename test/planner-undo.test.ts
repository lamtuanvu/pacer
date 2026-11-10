import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { restorePlannerInstall } from "../src/plugins/planner-install";
import { readManifest } from "../src/install/manifest";
import { writeUndoSnapshot, undoKeyDir, readSnapshotFile, UNDO_CAP_BYTES, pruneUndoSnapshotsAtStartup, UNDO_MISMATCH, type SnapshotChange } from "../src/install/undo-store";
import { withInstallLock } from "../src/install/lock";
import { runDoctor } from "../src/install/doctor";
import { sha256 } from "../src/install/fsx";

/** A ctx with a writable ~/.claude and a fresh pacerHome. */
function ctx(now = Math.floor(Date.now() / 1000)) {
  const c = fakeCtx({ now });
  mkdirSync(join(c.home, ".claude"), { recursive: true });
  mkdirSync(c.pacerHome, { recursive: true });
  return c;
}
/** Write an install manifest with one record whose undoConnect snapshot is supplied. */
function writeManifest(c: ReturnType<typeof ctx>, record: Record<string, unknown>) {
  writeFileSync(
    join(c.pacerHome, "install-manifest.json"),
    JSON.stringify({ version: 1, planners: { "claude-code": record } }, null, 2) + "\n",
  );
}
function record(undoConnect: unknown, extra: Record<string, unknown> = {}) {
  return {
    planner: "claude-code",
    folder: join(ctx().home, ".claude"),
    installedAt: 0,
    pacerArgv: [],
    commands: [],
    notes: [],
    files: [],
    undoConnect,
    ...extra,
  };
}
/** Seed the private snapshot store and return the metadata the manifest must carry. */
function seedSnapshot(c: ReturnType<typeof ctx>, files: SnapshotChange[], revision: string, at = c.now) {
  const snap = writeUndoSnapshot(c, "claude-code", files, revision, at);
  if (!snap) throw Error("seed snapshot refused (over cap)");
  return snap;
}

test("undo after two connects reverses only the second connect (F1)", async () => {
  const c = ctx();
  const first = join(c.home, ".claude", "AGENTS.md"), second = join(c.home, ".claude", "rules.md");
  writeFileSync(first, "one\n");
  writeFileSync(second, "two\n");
  const snap = seedSnapshot(c, [{ path: second, before: null, after: "two\n" }], "rev-2");
  writeManifest(c, record(snap, {
    files: [
      { path: first, action: "created", exact: true, undo: [], afterHash: sha256("one\n") },
      { path: second, action: "created", exact: true, undo: [], afterHash: sha256("two\n") },
    ],
    integration: { schema: 1, fingerprint: "old" },
  }));
  const r = await restorePlannerInstall(c, "claude-code", "claude-code", "rev-2");
  expect(r).toEqual({ restored: [], removed: [second], reverted: [], kept: [] });
  expect(existsSync(first)).toBe(true);
  expect(existsSync(second)).toBe(false);
  const after = readManifest(c).planners["claude-code"];
  expect(after.files.map(file => file.path)).toEqual([first]);
  expect(after.undoneAt).toBeDefined();
  expect(after.undoConnect).toBeUndefined();
  expect(after.integration).toBeUndefined();
  // The private snapshot store is cleared after a successful undo.
  expect(readdirSync(join(c.pacerHome, "undo"))).toEqual([]);
});

test("a user-edited file is kept and left alone (F2)", async () => {
  const c = ctx();
  const skill = join(c.home, ".claude", "skills", "pacer", "SKILL.md");
  mkdirSync(join(c.home, ".claude", "skills", "pacer"), { recursive: true });
  writeFileSync(skill, "my custom instructions\n");
  const snap = seedSnapshot(c, [{ path: skill, before: null, after: "installed\n" }], "rev");
  writeManifest(c, record(snap, {
    files: [{ path: skill, action: "created", exact: true, undo: [], afterHash: sha256("installed\n") }],
  }));
  const r = await restorePlannerInstall(c, "claude-code", "claude-code", "rev");
  expect(r.kept).toEqual([skill]);
  expect(r.removed).toEqual([]);
  expect(readFileSync(skill, "utf8")).toBe("my custom instructions\n");
  expect(readManifest(c).planners["claude-code"].files.map(file => file.path)).toEqual([skill]);
});

test("a file with no recorded hash is kept, never treated as unchanged (F2)", async () => {
  const c = ctx();
  const extra = join(c.home, ".claude", "extra.txt");
  writeFileSync(extra, "present now\n");
  const snap = seedSnapshot(c, [{ path: extra, before: null, after: null }], "rev");
  writeManifest(c, record(snap, {
    files: [{ path: extra, action: "created", exact: true, undo: [] }],
  }));
  const r = await restorePlannerInstall(c, "claude-code", "claude-code", "rev");
  expect(r.kept).toContain(extra);
  expect(existsSync(extra)).toBe(true);
  expect(readManifest(c).planners["claude-code"].files.map(file => file.path)).toEqual([extra]);
});

test("an expired undo window is refused (F1/window, F7)", async () => {
  const c = ctx();
  const skill = join(c.home, ".claude", "skills", "pacer", "SKILL.md");
  mkdirSync(join(c.home, ".claude", "skills", "pacer"), { recursive: true });
  writeFileSync(skill, "x\n");
  const snap = seedSnapshot(c, [{ path: skill, before: null, after: "x\n" }], "rev", c.now - 8 * 86_400);
  writeManifest(c, record(snap, { files: [{ path: skill, action: "created", exact: true, undo: [] }] }));
  await expect(restorePlannerInstall(c, "claude-code", "claude-code", "rev")).rejects.toMatchObject({ code: "not_found" });
});

test("a path outside the allowed folders is refused (F3)", async () => {
  const c = ctx();
  const ok = join(c.home, ".claude", "ok.txt");
  const outside = join(tmpDir(), "outside.txt");
  writeFileSync(ok, "ok\n");
  writeFileSync(outside, "outside\n");
  const snap = seedSnapshot(c, [{ path: outside, before: null, after: "outside\n" }], "rev");
  writeManifest(c, record(snap, { files: [{ path: ok, action: "created", exact: true, undo: [] }] }));
  await expect(restorePlannerInstall(c, "claude-code", "claude-code", "rev")).rejects.toMatchObject({ code: "capability_denied" });
  expect(existsSync(outside)).toBe(true);
});

test("a crash mid-undo leaves recovery working for later undos (F3)", async () => {
  const c = ctx();
  const skill = join(c.home, ".claude", "skills", "pacer", "SKILL.md");
  mkdirSync(join(c.home, ".claude", "skills", "pacer"), { recursive: true });
  const content = "x\n";
  writeFileSync(skill, content);
  const snap = seedSnapshot(c, [{ path: skill, before: null, after: content }], "rev");
  writeManifest(c, record(snap, { files: [{ path: skill, action: "created", exact: true, undo: [], afterHash: sha256(content) }] }));
  // Leftover from an interrupted undo: the journal was written but the file effect
  // and manifest had not settled. Recovery must settle it, not wedge later work.
  writeFileSync(join(c.pacerHome, "install-transaction.json"), JSON.stringify({ schema: 1,
    files: [{ path: skill, before: content, after: null }],
    manifestHash: sha256("a manifest that does not match the current one") }));
  const r = await restorePlannerInstall(c, "claude-code", "claude-code", "rev");
  expect(r.removed).toEqual([skill]);
  expect(existsSync(skill)).toBe(false);
  expect(readManifest(c).planners["claude-code"].undoneAt).toBeDefined();
  expect(existsSync(join(c.pacerHome, "install-transaction.json"))).toBe(false);
});

test("restored files are restored to their pre-connect content (F1)", async () => {
  const c = ctx();
  const settings = join(c.home, ".claude", "settings.json"), pre = '{"hook":false}\n', post = '{"hook":true}\n';
  writeFileSync(settings, post);
  const snap = seedSnapshot(c, [{ path: settings, before: pre, mode: 0o600, after: post }], "rev");
  writeManifest(c, record(snap, { files: [{ path: settings, action: "edited", exact: true, undo: [] }] }));
  const r = await restorePlannerInstall(c, "claude-code", "claude-code", "rev");
  expect(r.restored).toEqual([settings]);
  expect(readFileSync(settings, "utf8")).toBe(pre);
  // The before-image was read from the private copy, not from the manifest.
  expect(readFileSync(join(c.pacerHome, "install-manifest.json"), "utf8")).not.toContain(pre);
  expect(readSnapshotFile(c, "claude-code", settings)).toBeNull();
});

test("undo binds consent to the recorded snapshot's revision (F7/N4)", async () => {
  const c = ctx();
  const skill = join(c.home, ".claude", "skills", "pacer", "SKILL.md");
  mkdirSync(join(c.home, ".claude", "skills", "pacer"), { recursive: true });
  writeFileSync(skill, "x\n");
  const snap = seedSnapshot(c, [{ path: skill, before: null, after: "x\n" }], "rev-latest");
  writeManifest(c, record(snap, { files: [{ path: skill, action: "created", exact: true, undo: [] }] }));
  await expect(restorePlannerInstall(c, "claude-code", "claude-code", "rev-stale")).rejects.toMatchObject({ code: "conflict" });
  await expect(restorePlannerInstall(c, "claude-code", "claude-code", "rev-latest")).resolves.toMatchObject({ removed: [skill] });
});

test("a missing undo revision is refused (N4)", async () => {
  const c = ctx();
  const skill = join(c.home, ".claude", "skills", "pacer", "SKILL.md");
  mkdirSync(join(c.home, ".claude", "skills", "pacer"), { recursive: true });
  writeFileSync(skill, "x\n");
  const snap = seedSnapshot(c, [{ path: skill, before: null, after: "x\n" }], "rev-latest");
  writeManifest(c, record(snap, { files: [{ path: skill, action: "created", exact: true, undo: [] }] }));
  await expect(restorePlannerInstall(c, "claude-code", "claude-code")).rejects.toMatchObject({ code: "conflict" });
});

test("recovery accepts the same folders undo used for an account folder outside the standard homes (N3)", async () => {
  const c = ctx();
  const folder = join(c.home, "custom-account");
  mkdirSync(folder, { recursive: true });
  mkdirSync(c.pacerHome, { recursive: true });
  writeFileSync(join(c.pacerHome, "strategy.yaml"),
    JSON.stringify({ planner: "codex#team", accounts: { team: { kind: "codex", home: folder, usage: "quota" } } }));
  const file = join(folder, "AGENTS.md"), content = "line\n";
  writeFileSync(file, content);
  const snap = writeUndoSnapshot(c, "codex#team", [{ path: file, before: null, after: content }], "rev", c.now)!;
  writeFileSync(join(c.pacerHome, "install-manifest.json"), JSON.stringify({ version: 1, planners: { "codex#team": {
    planner: "codex#team", installedAt: 0, pacerArgv: [], commands: [], notes: [], files: [], undoConnect: snap } } }, null, 2) + "\n");
  // Leftover journal from a crash mid-undo for this record-only account folder.
  writeFileSync(join(c.pacerHome, "install-transaction.json"), JSON.stringify({ schema: 1,
    files: [{ path: file, before: content, after: null }],
    manifestHash: sha256("does not match") }));
  const r = await restorePlannerInstall(c, "codex", "codex#team", "rev");
  expect(r.removed).toContain(file);
  expect(existsSync(file)).toBe(false);
  expect(existsSync(join(c.pacerHome, "install-transaction.json"))).toBe(false);
});

test("snapshots over the size cap are refused and no undo is offered (N1)", async () => {
  const c = ctx();
  const big = join(c.home, ".claude", "big.txt"), content = "x".repeat(UNDO_CAP_BYTES + 1);
  writeFileSync(big, content);
  expect(writeUndoSnapshot(c, "claude-code", [{ path: big, before: content, after: content }])).toBeNull();
  expect(existsSync(undoKeyDir(c, "claude-code"))).toBe(false);
});

test("a sized snapshot stores private copies and prunes expired snapshots (N1)", async () => {
  const c = ctx();
  const a = join(c.home, ".claude", "a.txt"), b = join(c.home, ".claude", "b.txt");
  mkdirSync(join(c.home, ".claude"), { recursive: true });
  const small = "small\n";
  writeUndoSnapshot(c, "claude-code", [{ path: a, before: small, after: "changed\n" }], "rev-a", c.now - 8 * 86_400);
  writeUndoSnapshot(c, "codex#team", [{ path: b, before: small, after: "changed\n" }], "rev-b", c.now);
  // Pruning happened on the second write: the expired key vanished, the fresh one stays.
  expect(readdirSync(join(c.pacerHome, "undo"))).toEqual(["codex#team"]);
  expect(readSnapshotFile(c, "codex#team", b)).toEqual({ text: small, mode: 0o600 });
  expect(statSync(join(c.pacerHome, "undo")).mode & 0o777).toBe(0o700);
  const dir = join(c.pacerHome, "undo", "codex#team");
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  for (const name of readdirSync(dir)) {
    if (name === "meta.json") continue;
    expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
  }
  rmSync(join(c.pacerHome, "undo"), { recursive: true, force: true });
});

test("M1: a crash after the manifest commit but before the snapshot swap leaves old copies; undo refuses", async () => {
  const c = ctx();
  const settings = join(c.home, ".claude", "settings.json"), post = '{"hook":true}\n';
  writeFileSync(settings, post);
  // Connect #1's snapshot stays in the store (connect #2's swap aborted).
  writeUndoSnapshot(c, "claude-code", [{ path: settings, before: "OLD", after: post }], "rev-1");
  // The manifest commits connect #2's snapshot, but the store still holds #1's
  // copies. Undo must refuse rather than restore the older before-image.
  const snapB = {
    at: c.now, revision: "rev-2", size: 3,
    files: [{ path: settings, beforeHash: sha256("NEW"), size: 3, afterHash: sha256(post), copy: "f-0" }],
  };
  writeManifest(c, record(snapB, { files: [{ path: settings, action: "edited", exact: true, undo: [] }] }));
  let crashErr: unknown;
  try { await restorePlannerInstall(c, "claude-code", "claude-code", "rev-2"); throw Error("undo should have refused"); }
  catch (e) { crashErr = e; }
  expect(crashErr).toMatchObject({ code: "conflict" });
  expect((crashErr as Error).message).toBe(UNDO_MISMATCH);
  // The on-disk file is untouched by the refused undo.
  expect(readFileSync(settings, "utf8")).toBe(post);
});

test("M1: a tampered copy in the private undo store is refused", async () => {
  const c = ctx();
  const settings = join(c.home, ".claude", "settings.json"), pre = '{"hook":false}\n', post = '{"hook":true}\n';
  writeFileSync(settings, post);
  const snap = seedSnapshot(c, [{ path: settings, before: pre, mode: 0o600, after: post }], "rev");
  writeManifest(c, record(snap, { files: [{ path: settings, action: "edited", exact: true, undo: [] }] }));
  // Tamper: overwrite the private copy so its hash no longer matches the manifest.
  writeFileSync(join(undoKeyDir(c, "claude-code"), snap.files[0]!.copy!), "TAMPERED");
  let tamperedErr: unknown;
  try { await restorePlannerInstall(c, "claude-code", "claude-code", "rev"); throw Error("undo should have refused"); }
  catch (e) { tamperedErr = e; }
  expect(tamperedErr).toMatchObject({ code: "conflict" });
  expect((tamperedErr as Error).message).toBe(UNDO_MISMATCH);
  // The on-disk file is untouched by the refused undo.
  expect(readFileSync(settings, "utf8")).toBe(post);
});

test("M1: a mismatch refuses the whole undo; no file is restored or removed", async () => {
  const c = ctx();
  const a = join(c.home, ".claude", "a.txt"), b = join(c.home, ".claude", "b.txt");
  writeFileSync(a, "A-current"); writeFileSync(b, "B-current");
  const snap = seedSnapshot(c, [
    { path: a, before: "A-old", after: "A-current" },
    { path: b, before: "B-old", after: "B-current" },
  ], "rev");
  writeManifest(c, record(snap, { files: [
    { path: a, action: "edited", exact: true, undo: [] },
    { path: b, action: "edited", exact: true, undo: [] },
  ] }));
  // Tamper with one copy so the whole undo must refuse.
  writeFileSync(join(undoKeyDir(c, "claude-code"), snap.files[0]!.copy!), "TAMPERED-A");
  let err: unknown;
  try { await restorePlannerInstall(c, "claude-code", "claude-code", "rev"); throw Error("undo should have refused"); }
  catch (e) { err = e; }
  expect(err).toMatchObject({ code: "conflict" });
  expect((err as Error).message).toBe(UNDO_MISMATCH);
  // No file was restored or removed by the refused undo.
  expect(readFileSync(a, "utf8")).toBe("A-current");
  expect(readFileSync(b, "utf8")).toBe("B-current");
});

test("expired snapshots are pruned at service startup and by doctor (L2)", async () => {
  const c = ctx();
  const file = join(c.home, ".claude", "a.txt"), small = "x\n";
  writeFileSync(file, small);
  // Fresh keys must survive; nothing else may prune here, so seed one key at a time.
  writeFileSync(join(c.pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders:\n  claude-code: {usage: quota}\n  codex: {usage: quota}\nrouting:\n  - default: [codex]\n");
  const status = () => ({
    generatedAt: 0, strategy: "default", planner: "claude-code", mode: "normal",
    disabled: false, paused: null, modeHold: null, calendarPace: true, executors: { ranked: [], excluded: [] },
    providers: ["claude-code", "codex"].map((id) => ({ id, usage: "quota", windows: [], binding: null, verdict: "OK", installed: true, stale: false })),
  }) as never;
  const service = async () => ({ installed: true, running: true, healthy: true, binaryMatches: true }) as never;

  // Service-startup pruner (under the install lock) removes an expired snapshot.
  writeUndoSnapshot(c, "claude-code", [{ path: file, before: small, after: "b\n" }], "rev-expired", c.now - 8 * 86_400);
  await pruneUndoSnapshotsAtStartup(c);
  expect(readdirSync(join(c.pacerHome, "undo"))).toEqual([]);
  // ... and keeps a fresh one.
  writeUndoSnapshot(c, "codex#team", [{ path: file, before: small, after: "b\n" }], "rev-fresh", c.now);
  await pruneUndoSnapshotsAtStartup(c);
  expect(readdirSync(join(c.pacerHome, "undo"))).toEqual(["codex#team"]);

  // Doctor also prunes expired snapshots.
  writeUndoSnapshot(c, "claude-code", [{ path: file, before: small, after: "b\n" }], "rev-expired", c.now - 8 * 86_400);
  await runDoctor(c, { status, service });
  expect(readdirSync(join(c.pacerHome, "undo"))).toEqual(["codex#team"]);
});

test("startup pruning never queues behind a busy install lock; a starting service must not delay its listener past the installer's health deadline", async () => {
  const c = ctx();
  const file = join(c.home, ".claude", "a.txt");
  // `service install` holds the install lock across its health verification, so a
  // serve that starts while it runs must skip pruning instead of waiting for it.
  let release!: () => void;
  const holder = withInstallLock(c, () => new Promise<void>(resolve => { release = resolve; }));
  const lockDir = join(c.pacerHome, "install-locks");
  while (readdirSync(lockDir).filter(other => other.endsWith(".json")).length === 0) await Bun.sleep(10);
  writeUndoSnapshot(c, "claude-code", [{ path: file, before: "a\n", after: "b\n" }], "rev", c.now - 8 * 86_400);
  const startedAt = Date.now();
  await pruneUndoSnapshotsAtStartup(c);
  expect(Date.now() - startedAt).toBeLessThan(2000);
  // A busy lock skips the prune but keeps the expired snapshot; a free lock prunes it.
  expect(existsSync(undoKeyDir(c, "claude-code"))).toBe(true);
  release();
  await holder;
  await pruneUndoSnapshotsAtStartup(c);
  expect(existsSync(undoKeyDir(c, "claude-code"))).toBe(false);
});