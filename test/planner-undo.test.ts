import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { restorePlannerInstall } from "../src/plugins/planner-install";
import { readManifest } from "../src/install/manifest";
import { writeUndoSnapshot, undoKeyDir, readSnapshotFile, UNDO_CAP_BYTES, type SnapshotChange } from "../src/install/undo-store";
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