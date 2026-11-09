import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeCtx } from "../../src/ctx";
import { installPlanner } from "../../src/install";
import { pacerArgv } from "../../src/install/self";
import { restorePlannerInstall } from "../../src/plugins/planner-install";
import { readManifest } from "../../src/install/manifest";
import { pluginRegistry, shutdownPlugins } from "../../src/plugins";
import { BUNDLED } from "../../plugins/bundled";
import { record, type Session } from "./core";

/**
 * CT-11 (N1/N4 round 2): connect -> user edit -> reconnect -> undo under a
 * disposable home, verifying the install manifest stays metadata-only (no file
 * contents or modes) and that undo reads the private snapshot store.
 */
export async function exerciseUndoStore(session: Session): Promise<void> {
  const root = session.root;
  const home = join(root, "undo-home");
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const pacerHome = join(home, ".pacer"), codex = join(home, ".codex");
  mkdirSync(pacerHome, { recursive: true, mode: 0o700 });
  const env = {
    HOME: home, PACER_HOME: pacerHome, PACER_BIN: join(session.root, "bin/pacer"),
    CODEX_HOME: codex, CLAUDE_CONFIG_DIR: join(home, ".claude"),
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
    TMPDIR: join(home, "tmp"), PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", LANG: "C",
  };
  mkdirSync(env.TMPDIR, { recursive: true, mode: 0o700 });
  const ctx = makeCtx({ home, pacerHome, env, which: () => null,
    run: async () => { throw Error("Unexpected installer subprocess"); } });
  pluginRegistry(ctx, {
    bundled: BUNDLED,
    spawnBundled: (_c, id) => ({
      argv: [process.execPath, join(import.meta.dir, "../../src/cli.ts"), "plugin", "run", id],
      cwd: home, env: { PATH: process.env.PATH },
    }),
  });
  const must = (ok: boolean, message: string) => { if (!ok) throw Error(message); };
  const manifestText = () => existsSync(join(pacerHome, "install-manifest.json"))
    ? readFileSync(join(pacerHome, "install-manifest.json"), "utf8")
    : "";
  const assertMetadataOnly = (label: string, secretMarker: string) => {
    const text = manifestText();
    must(!text.includes('"before":'), `${label}: manifest still carries before-content (legacy field)`);
    must(!text.includes("beforeMode"), `${label}: manifest still carries file modes`);
    must(!text.includes(secretMarker), `${label}: manifest leaks file content`);
  };

  // 1. Connect.
  await installPlanner({ ctx, pacerArgv: pacerArgv(env), mcp: false, folder: codex }, "codex");
  const skillPath = join(codex, "skills/pacer/SKILL.md");
  must(existsSync(skillPath), "connect did not install the codex skill file");
  const secret = "UNDO_LIVE_SECRET_9f2c81";
  const first = readManifest(ctx).planners.codex.undoConnect;
  must(!!first && !!first.revision && first.files.length > 0, "connect did not record a snapshot with a revision");
  assertMetadataOnly("after connect", secret);
  record(session, { kind: "note", behavior: "connect snapshot", surface: "installer", verdict: "PASS", text: "Connect recorded snapshot metadata with a revision; the manifest has no file contents or modes." });

  // 2. User edit.
  const before = readFileSync(skillPath, "utf8");
  writeFileSync(skillPath, before + "# user marker " + secret + "\n");
  const edited = readFileSync(skillPath, "utf8");
  must(edited.includes(secret), "edit did not apply");

  // 3. Reconnect supersedes the snapshot.
  await installPlanner({ ctx, pacerArgv: pacerArgv(env), mcp: false, folder: codex }, "codex");
  const second = readManifest(ctx).planners.codex.undoConnect;
  must(!!second && !!second.revision && second.revision !== first.revision, "reconnect did not supersede the snapshot revision");
  assertMetadataOnly("after reconnect", secret);
  record(session, { kind: "note", behavior: "reconnect supersede", surface: "installer", verdict: "PASS", text: "Reconnect replaced the snapshot with a new revision and the manifest remained metadata-only." });

  // 4. Undo restores from the private store.
  const undo = await restorePlannerInstall(ctx, "codex", "codex", second.revision);
  must(undo.restored.includes(skillPath) || undo.kept.includes(skillPath), "undo did not restore/keep the edited file");
  const afterUndo = readFileSync(skillPath, "utf8");
  must(afterUndo === edited, "undo did not restore the reconnect's pre-image from the private copy");
  assertMetadataOnly("after undo", secret);
  must(existsSync(join(pacerHome, "install-manifest.json")), "manifest should still exist after undo");
  const undoDir = join(pacerHome, "undo");
  must(!existsSync(undoDir) || readdirSync(undoDir).length === 0, "undo did not clear the private snapshot store");
  record(session, { kind: "note", behavior: "undo restore", surface: "undo", verdict: "PASS",
    text: "Undo restored the reconnect's pre-image from the private store and cleared it; the manifest is metadata-only across connect, edit, reconnect and undo." });

  // 5. Tamper with a fresh snapshot's copy; undo must refuse (M1).
  writeFileSync(skillPath, edited + "# user marker " + secret + "\n");
  await installPlanner({ ctx, pacerArgv: pacerArgv(env), mcp: false, folder: codex }, "codex");
  const third = readManifest(ctx).planners.codex.undoConnect;
  must(!!third && !!third.revision, "tamper-step reconnect did not record a snapshot");
  const copyName = third.files.find((file) => file.copy)?.copy;
  must(!!copyName, "tamper-step snapshot has no private copy");
  writeFileSync(join(pacerHome, "undo", "codex", copyName), "LIVE_TAMPERED");
  let refused = false;
  try {
    await restorePlannerInstall(ctx, "codex", "codex", third.revision);
  } catch (error) {
    refused = String((error as Error).message).includes("don't match this repair");
  }
  must(refused, "undo did not refuse a tampered private copy");
  must(readFileSync(skillPath, "utf8") !== "", "file state after refused undo unexpected");
  record(session, { kind: "note", behavior: "tamper refusal", surface: "undo", verdict: "PASS",
    text: "After tampering with the private snapshot copy, undo refused with the mismatch error instead of restoring foreign content." });
  await shutdownPlugins({ pacerHome });
}