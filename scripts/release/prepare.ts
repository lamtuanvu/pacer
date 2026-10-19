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
  // Validate all native metadata before changing any release file.
  const native = join(root, "desktop", "src-tauri");
  const cargoPath = join(native, "Cargo.toml"), lockPath = join(native, "Cargo.lock");
  const configPath = join(native, "tauri.conf.json");
  const cargo = readFileSync(cargoPath, "utf8"), lock = readFileSync(lockPath, "utf8");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const packageSection = /(^\[package\]\s*\n)([^]*?)(?=^\[|$(?![^]))/m;
  const section = cargo.match(packageSection);
  if (!section || !/^name\s*=\s*"pacer-desktop"\s*$/m.test(section[2]) || !/^version\s*=\s*"[^"]+"\s*$/m.test(section[2])) {
    throw new Error("Cargo.toml has no versioned pacer-desktop package");
  }
  const nextCargo = cargo.replace(packageSection, (_, header: string, body: string) => header + body.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`));
  let changed = 0;
  const nextLock = lock.replace(/(^\[\[package\]\]\s*\n)([^]*?)(?=^\[\[|$(?![^]))/gm, (block, header: string, body: string) => {
    if (!/^name = "pacer-desktop"$/m.test(body)) return block;
    if (!/^version = "[^"]+"$/m.test(body)) throw new Error("Cargo.lock pacer-desktop has no version");
    changed++;
    return header + body.replace(/^version = "[^"]+"/m, `version = "${version}"`);
  });
  if (changed !== 1) throw new Error("Cargo.lock must contain exactly one pacer-desktop package");
  if (typeof config.version !== "string") throw new Error("Tauri config has no desktop version");
  config.version = version;
  plugin.source.ref = `orca-plugin-v${version}`;
  pkg.version = version;
  writeFileSync(cargoPath, nextCargo);
  writeFileSync(lockPath, nextLock);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(changelogPath, changelog);
  writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);
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
