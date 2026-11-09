import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { fakeCtx } from "./helpers";
import { PluginRegistry } from "../src/plugins/registry";
import { withPlannerInstall } from "../src/plugins/planner-install";
import { writeUndoSnapshot, stageUndoSnapshot, discardStagedUndoSnapshot, readSnapshotFile } from "../src/install/undo-store";
import { readManifest, writeManifest } from "../src/install/manifest";
import type { PluginManifest } from "../src/plugins/protocol";

test("N1: the manifest carries only snapshot metadata and never file contents or modes", async () => {
  const ctx = fakeCtx();
  await mkdir(ctx.pacerHome, { recursive: true });
  await mkdir(join(ctx.home, ".claude"), { recursive: true });
  const secret = "PACER_SECRET_KEY=abcdef-super-secret";
  const settings = join(ctx.home, ".claude", "settings.json");
  await writeFile(settings, '{"hook":false}\n');
  const snap = writeUndoSnapshot(ctx, "claude-code", [{ path: settings, before: secret, mode: 0o700, after: '{"hook":true}\n' }], "rev-1")!;
  const manifest = readManifest(ctx);
  manifest.planners["claude-code"] = {
    planner: "claude-code", installedAt: 0, pacerArgv: [], commands: [], notes: [],
    files: [{ path: settings, action: "edited", exact: true, undo: [] }],
    undoConnect: snap,
  };
  writeManifest(ctx, manifest);
  const text = await readFile(join(ctx.pacerHome, "install-manifest.json"), "utf8");
  // File contents, file modes and the legacy full-content fields never reach the manifest.
  expect(text).not.toContain(secret);
  expect(text).not.toContain('"before":');
  expect(text).not.toContain("beforeMode");
  expect(text).not.toContain("0600");
  // The private store holds the exact content and mode.
  const copy = await readFile(join(ctx.pacerHome, "undo", "claude-code", snap.files[0]!.copy!), "utf8");
  expect(copy).toBe(secret);
  // The manifest snapshot keeps only metadata: path, hashes, size, time, revision, copy reference.
  expect(snap).toMatchObject({ at: expect.any(Number), revision: "rev-1", size: secret.length,
    files: [{ path: settings, afterHash: expect.any(String), size: secret.length, copy: expect.any(String) }] });
});

test("N1 availability: an aborted staged snapshot leaves the prior snapshot's copies intact", async () => {
  const ctx = fakeCtx();
  await mkdir(ctx.pacerHome, { recursive: true });
  await mkdir(join(ctx.home, ".claude"), { recursive: true });
  const settings = join(ctx.home, ".claude", "settings.json");
  await writeFile(settings, "v1");
  writeUndoSnapshot(ctx, "claude-code", [{ path: settings, before: "v1", after: "v2" }], "rev-1");
  // A rival reconnect stages a new snapshot but its commit is aborted.
  const staged = stageUndoSnapshot(ctx, "claude-code", [{ path: settings, before: "v2", after: "v3" }], "rev-2");
  expect(staged).toBeTruthy();
  discardStagedUndoSnapshot(staged!.dir);
  // The live key dir still holds the first snapshot's private copy, so undo of
  // the first connect remains available even though the manifest was untouched.
  expect(readSnapshotFile(ctx, "claude-code", settings)).toEqual({ text: "v1", mode: 0o600 });
});

test("N2: a planner plugin's forged snapshot is ignored; the host owns undoConnect and undoneAt", async () => {
  const ctx = fakeCtx();
  const folder = join(ctx.home, "planner");
  await mkdir(folder);
  await mkdir(ctx.pacerHome, { recursive: true });
  await writeFile(join(folder, "settings.json"), "before");
  const manifest: PluginManifest = {
    id: "sp-forge", version: "1.0.0", publisher: "pacer", host: "^1.6",
    contributes: { planner: {} },
    capabilities: [
      { name: "fs.read", scopes: [folder + "/**"] },
      { name: "fs.write", scopes: [folder + "/**"] },
    ],
    tier: "free", reentrant: false,
  };
  const registry = new PluginRegistry({
    bundled: [{ manifest, main: async () => ({ handlers: {} }) }],
    spawnBundled: () => ({
      argv: [process.execPath, join(import.meta.dir, "fixtures/sp-forge/install.ts")],
      cwd: ctx.home,
      env: {},
    }),
  });
  try {
    await withPlannerInstall(
      { ctx, pacerArgv: ["pacer"], folder },
      "forge",
      { pluginId: "sp-forge", roots: [folder], binaries: [], registry, undoRevision: "preview-123" },
    );
    const saved = readManifest(ctx).planners.forge;
    // The forged revision and content are gone; the host's snapshot is bound to the preview revision.
    expect(saved.undoConnect).toBeDefined();
    expect(saved.undoConnect!.revision).toBe("preview-123");
    expect(saved.undoneAt).toBeUndefined();
    const paths = saved.undoConnect!.files.map((file) => file.path);
    expect(paths).toContain(join(folder, "settings.json"));
    expect(saved.undoConnect!.files.find((file) => file.path === join(folder, "settings.json"))!.beforeHash).toBeDefined();
    const text = await readFile(join(ctx.pacerHome, "install-manifest.json"), "utf8");
    expect(text).not.toContain("FORGED");
    expect(text).not.toContain("deadbeef");
  } finally {
    await registry.shutdown();
    await rm(ctx.home, { recursive: true, force: true });
  }
});