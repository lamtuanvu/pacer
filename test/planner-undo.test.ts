import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { restorePlannerInstall } from "../src/plugins/planner-install";
import { readManifest } from "../src/install/manifest";
import { sha256 } from "../src/install/fsx";

/** A ctx with a writable ~/.claude and a fresh pacerHome. */
function ctx() {
  const c = fakeCtx();
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
function record(files: unknown[], undoConnect: unknown, extra: Record<string, unknown> = {}) {
  return {
    planner: "claude-code",
    folder: join(ctx().home, ".claude"),
    installedAt: 0,
    pacerArgv: [],
    commands: [],
    notes: [],
    files,
    undoConnect,
    ...extra,
  };
}

test("undo after two connects reverses only the second connect (F1)", async () => {
  const c = ctx();
  const first = join(c.home, ".claude", "AGENTS.md"), second = join(c.home, ".claude", "rules.md");
  writeFileSync(first, "one\n");
  writeFileSync(second, "two\n");
  writeManifest(c, record(
    [
      { path: first, action: "created", exact: true, undo: [], afterHash: sha256("one\n") },
      { path: second, action: "created", exact: true, undo: [], afterHash: sha256("two\n") },
    ],
    { at: c.now, revision: "rev-2", files: [{ path: second, before: null, afterHash: sha256("two\n") }] },
    { integration: { schema: 1, fingerprint: "old" } },
  ));
  const r = await restorePlannerInstall(c, "claude-code", "claude-code", "rev-2");
  expect(r).toEqual({ restored: [], removed: [second], reverted: [], kept: [] });
  expect(existsSync(first)).toBe(true);
  expect(existsSync(second)).toBe(false);
  const after = readManifest(c).planners["claude-code"];
  expect(after.files.map(file => file.path)).toEqual([first]);
  expect(after.undoneAt).toBeDefined();
  expect(after.undoConnect).toBeUndefined();
  expect(after.integration).toBeUndefined();
});

test("a user-edited file is kept and left alone (F2)", async () => {
  const c = ctx();
  const skill = join(c.home, ".claude", "skills", "pacer", "SKILL.md");
  mkdirSync(join(c.home, ".claude", "skills", "pacer"), { recursive: true });
  writeFileSync(skill, "my custom instructions\n");
  writeManifest(c, record(
    [{ path: skill, action: "created", exact: true, undo: [], afterHash: sha256("installed\n") }],
    { at: c.now, revision: "", files: [{ path: skill, before: null, afterHash: sha256("installed\n") }] },
  ));
  const r = await restorePlannerInstall(c, "claude-code", "claude-code");
  expect(r.kept).toEqual([skill]);
  expect(r.removed).toEqual([]);
  expect(readFileSync(skill, "utf8")).toBe("my custom instructions\n");
  expect(readManifest(c).planners["claude-code"].files.map(file => file.path)).toEqual([skill]);
});

test("a file with no recorded hash is kept, never treated as unchanged (F2)", async () => {
  const c = ctx();
  const extra = join(c.home, ".claude", "extra.txt");
  writeFileSync(extra, "present now\n");
  writeManifest(c, record(
    [{ path: extra, action: "created", exact: true, undo: [] }],
    { at: c.now, revision: "", files: [{ path: extra, before: null }] },
  ));
  const r = await restorePlannerInstall(c, "claude-code", "claude-code");
  expect(r.kept).toContain(extra);
  expect(existsSync(extra)).toBe(true);
  expect(readManifest(c).planners["claude-code"].files.map(file => file.path)).toEqual([extra]);
});

test("an expired undo window is refused (F1/window, F7)", async () => {
  const c = ctx();
  const skill = join(c.home, ".claude", "skills", "pacer", "SKILL.md");
  mkdirSync(join(c.home, ".claude", "skills", "pacer"), { recursive: true });
  writeFileSync(skill, "x\n");
  writeManifest(c, record(
    [{ path: skill, action: "created", exact: true, undo: [] }],
    { at: c.now - 8 * 86_400, revision: "", files: [{ path: skill, before: null, afterHash: sha256("x\n") }] },
  ));
  await expect(restorePlannerInstall(c, "claude-code", "claude-code")).rejects.toMatchObject({ code: "not_found" });
});

test("a path outside the allowed folders is refused (F3)", async () => {
  const c = ctx();
  const ok = join(c.home, ".claude", "ok.txt");
  const outside = join(tmpDir(), "outside.txt");
  writeFileSync(ok, "ok\n");
  writeFileSync(outside, "outside\n");
  writeManifest(c, record(
    [{ path: ok, action: "created", exact: true, undo: [] }],
    { at: c.now, revision: "", files: [{ path: outside, before: null, afterHash: sha256("outside\n") }] },
  ));
  await expect(restorePlannerInstall(c, "claude-code", "claude-code")).rejects.toMatchObject({ code: "capability_denied" });
  expect(existsSync(outside)).toBe(true);
});

test("a crash mid-undo leaves recovery working for later undos (F3)", async () => {
  const c = ctx();
  const skill = join(c.home, ".claude", "skills", "pacer", "SKILL.md");
  mkdirSync(join(c.home, ".claude", "skills", "pacer"), { recursive: true });
  const content = "x\n";
  writeFileSync(skill, content);
  writeManifest(c, record(
    [{ path: skill, action: "created", exact: true, undo: [], afterHash: sha256(content) }],
    { at: c.now, revision: "", files: [{ path: skill, before: null, afterHash: sha256(content) }] },
  ));
  // Leftover from an interrupted undo: the journal was written but the file effect
  // and manifest had not settled. Recovery must settle it, not wedge later work.
  writeFileSync(join(c.pacerHome, "install-transaction.json"), JSON.stringify({ schema: 1,
    files: [{ path: skill, before: content, after: null }],
    manifestHash: sha256("a manifest that does not match the current one") }));
  const r = await restorePlannerInstall(c, "claude-code", "claude-code");
  expect(r.removed).toEqual([skill]);
  expect(existsSync(skill)).toBe(false);
  expect(readManifest(c).planners["claude-code"].undoneAt).toBeDefined();
  expect(existsSync(join(c.pacerHome, "install-transaction.json"))).toBe(false);
});

test("restored files are restored to their pre-connect content (F1)", async () => {
  const c = ctx();
  const settings = join(c.home, ".claude", "settings.json"), pre = '{"hook":false}\n', post = '{"hook":true}\n';
  writeFileSync(settings, post);
  writeManifest(c, record(
    [{ path: settings, action: "edited", exact: true, undo: [] }],
    { at: c.now, revision: "rev", files: [{ path: settings, before: pre, beforeMode: 0o600, afterHash: sha256(post) }] },
  ));
  const r = await restorePlannerInstall(c, "claude-code", "claude-code", "rev");
  expect(r.restored).toEqual([settings]);
  expect(readFileSync(settings, "utf8")).toBe(pre);
});

test("undo binds consent to the recorded snapshot's revision (F7)", async () => {
  const c = ctx();
  const skill = join(c.home, ".claude", "skills", "pacer", "SKILL.md");
  mkdirSync(join(c.home, ".claude", "skills", "pacer"), { recursive: true });
  writeFileSync(skill, "x\n");
  writeManifest(c, record(
    [{ path: skill, action: "created", exact: true, undo: [] }],
    { at: c.now, revision: "rev-latest", files: [{ path: skill, before: null, afterHash: sha256("x\n") }] },
  ));
  await expect(restorePlannerInstall(c, "claude-code", "claude-code", "rev-stale")).rejects.toMatchObject({ code: "conflict" });
  await expect(restorePlannerInstall(c, "claude-code", "claude-code", "rev-latest")).resolves.toMatchObject({ removed: [skill] });
});