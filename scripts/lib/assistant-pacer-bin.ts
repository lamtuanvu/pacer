import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ASSISTANT_PACER_EXECUTABLE } from "../../src/plugins/native-bundled";
import { signLocal } from "../../src/update/signing";
import type { Platform } from "../../src/update/manifest";

/** Release asset basename for the native assistant plugin next to a platform core. */
export function assistantPacerFile(platform: Platform): string {
  return `${ASSISTANT_PACER_EXECUTABLE}-${platform.os}-${platform.arch}`;
}

export function assistantPacerCrate(root: string): string {
  return join(root, "crates", "assistant-pacer");
}

export function assistantPacerCratePresent(root: string): boolean {
  return existsSync(join(assistantPacerCrate(root), "Cargo.toml"));
}

/** Same cargo target dir the release front-door build uses (`scripts/release/build.ts`). */
export function frontDoorCargoTargetDir(root: string): string {
  return join(root, "target");
}

function rustTarget(platform: Platform): string {
  const arch = platform.arch === "arm64" ? "aarch64" : "x86_64";
  return `${arch}-${platform.os === "darwin" ? "apple-darwin" : "unknown-linux-musl"}`;
}

/**
 * Build `pacer-assistant-pacer` when `crates/assistant-pacer` exists, place it at `outfile`,
 * and sign darwin hosts the same way as pacer-core. No-op (returns false) when the crate is absent.
 */
export async function compileAssistantPacer(o: {
  root: string;
  target: Platform;
  outfile: string;
  cargoTargetDir?: string;
  smoke?: boolean;
}): Promise<boolean> {
  if (!assistantPacerCratePresent(o.root)) return false;
  const targetDir = o.cargoTargetDir ?? frontDoorCargoTargetDir(o.root);
  const triple = rustTarget(o.target);
  const build = o.target.os === "linux"
    ? ["cargo", "zigbuild", "--release", "--locked", "-p", "pacer-assistant-pacer", "--bin", ASSISTANT_PACER_EXECUTABLE, "--target", triple]
    : ["cargo", "build", "--release", "--locked", "-p", "pacer-assistant-pacer", "--bin", ASSISTANT_PACER_EXECUTABLE, "--target", triple];
  const process = Bun.spawn(build, {
    cwd: o.root,
    env: { ...Bun.env, CARGO_TARGET_DIR: targetDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code !== 0) throw new Error(`assistant-pacer build failed for ${triple} (exit ${code}):\n${(err || out).trim()}`);
  const built = join(targetDir, triple, "release", ASSISTANT_PACER_EXECUTABLE);
  if (!existsSync(built)) throw new Error(`assistant-pacer build did not produce ${built}`);
  mkdirSync(dirname(o.outfile), { recursive: true });
  copyFileSync(built, o.outfile);
  if (o.target.os === "darwin") await signLocal(o.outfile, { smoke: o.smoke === true });
  return true;
}

/** Copy a built assistant-pacer binary next to a core path when the source exists. */
export function stageAssistantPacerBeside(corePath: string, source?: string | null): boolean {
  const from = source ?? join(dirname(corePath), ASSISTANT_PACER_EXECUTABLE);
  if (!from || !existsSync(from)) return false;
  const dest = join(dirname(corePath), ASSISTANT_PACER_EXECUTABLE);
  if (from !== dest) copyFileSync(from, dest);
  try { Bun.spawnSync(["chmod", "0755", dest]); } catch { /* best-effort mode bits */ }
  return true;
}
