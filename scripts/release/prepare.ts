#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compareVersions, isVersion } from "../../src/update/version";

export function prepareChangelog(text: string, version: string, date: string): string {
  const heading = /^## \[Unreleased\][ \t]*$/m;
  if (!heading.test(text)) throw new Error("CHANGELOG.md has no Unreleased section");
  if (text.includes(`## [${version}]`)) throw new Error(`CHANGELOG.md already contains ${version}`);
  return text.replace(heading, `## [Unreleased]\n\n## [${version}] - ${date}`);
}

// Replace only the top-level version string so the hand-formatted config keeps its layout.
function bumpJsonVersion(text: string, version: string): string {
  const result = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  const before = JSON.parse(text), after = JSON.parse(result);
  if (after.version !== version || JSON.stringify({ ...after, version: before.version }) !== JSON.stringify(before)) {
    throw new Error("tauri.conf.json must have a top-level version before any nested one");
  }
  return result;
}

function bumpCargoVersion(text: string, version: string, lockfile: boolean): string {
  let matches = 0;
  const result = text.split(/(?=^\[)/m).map(section => {
    const isPackage = lockfile
      ? section.startsWith("[[package]]\n") && /^name\s*=\s*"pacer-desktop"\s*$/m.test(section)
      : section.startsWith("[package]\n");
    if (!isPackage) return section;
    return section.replace(/^(version\s*=\s*")[^"]+(".*)$/m, (_, prefix, suffix) => {
      matches++;
      return `${prefix}${version}${suffix}`;
    });
  }).join("");
  if (matches !== 1) throw new Error(`${lockfile ? "Cargo.lock" : "Cargo.toml"} must contain one desktop package version`);
  return result;
}

export async function prepareRelease(root: string, version: string): Promise<void> {
  const packagePath = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || !isVersion(version)) throw new Error("version must be MAJOR.MINOR.PATCH");
  if (compareVersions(version, pkg.version) <= 0) throw new Error(`version must be greater than ${pkg.version}`);
  const changelogPath = join(root, "CHANGELOG.md");
  const changelog = prepareChangelog(readFileSync(changelogPath, "utf8"), version, new Date().toISOString().slice(0, 10));
  const marketplacePath = join(root, "orca-marketplace.json");
  const marketplace = JSON.parse(readFileSync(marketplacePath, "utf8"));
  const plugin = marketplace.plugins.find((p: { id: string }) => p.id === "lamtuanvu.pacer");
  if (!plugin) throw new Error("orca-marketplace.json has no lamtuanvu.pacer entry");
  const desktopPath = join(root, "desktop", "src-tauri");
  const tauriPath = join(desktopPath, "tauri.conf.json");
  const tauri = bumpJsonVersion(readFileSync(tauriPath, "utf8"), version);
  const cargoPath = join(desktopPath, "Cargo.toml");
  const cargo = bumpCargoVersion(readFileSync(cargoPath, "utf8"), version, false);
  const lockPath = join(desktopPath, "Cargo.lock");
  const lock = bumpCargoVersion(readFileSync(lockPath, "utf8"), version, true);
  plugin.source.ref = `orca-plugin-v${version}`;
  pkg.version = version;
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(changelogPath, changelog);
  writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);
  writeFileSync(tauriPath, tauri);
  writeFileSync(cargoPath, cargo);
  writeFileSync(lockPath, lock);
  const p = Bun.spawn([process.execPath, "run", "plugin:build"], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (await p.exited !== 0) throw new Error("plugin:build failed; fix the build and rerun bun run plugin:build before committing");
  // The app embeds APP_VERSION, which the release build checks against package.json.
  const a = Bun.spawn([process.execPath, "run", "app:build"], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (await a.exited !== 0) throw new Error("app:build failed; fix the build and rerun bun run app:build before committing");
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error("usage: bun run release:prepare <x.y.z>");
    const version = process.argv[2];
    await prepareRelease(resolve(import.meta.dir, "..", ".."), version);
    console.log(`Next: commit with git commit -s -m "chore: release ${version}" via a PR and merge it.\nThen: git tag -s v${version} -m "pacer ${version}" (or use -a)\nThen: git push origin v${version}`);
  } catch (e) {
    console.error(`release:prepare: ${(e as Error).message}`);
    process.exit(1);
  }
}
