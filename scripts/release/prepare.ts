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

function prepareDesktopVersions(root: string, version: string): { path: string; text: string }[] {
  const targets = [
    {
      file: "tauri.conf.json",
      pattern: /(^[ \t]*"version"[ \t]*:[ \t]*")[^"\r\n]*(")/m,
      field: "version line",
    },
    {
      file: "Cargo.toml",
      pattern: /(^\[package\][^\r\n]*\r?\n(?:(?![ \t]*\[)[^\n]*\n)*?[ \t]*version[ \t]*=[ \t]*")[^"\r\n]*(")/m,
      field: "[package] version line",
    },
    {
      file: "Cargo.lock",
      pattern: /(^name[ \t]*=[ \t]*"pacer-desktop"[^\r\n]*\r?\n(?:(?![ \t]*\[)[^\n]*\n)*?[ \t]*version[ \t]*=[ \t]*")[^"\r\n]*(")/m,
      field: "pacer-desktop version line",
    },
  ];
  return targets.map(({ file, pattern, field }) => {
    const path = join(root, "desktop", "src-tauri", file);
    const text = readFileSync(path, "utf8");
    if (!pattern.test(text)) throw new Error(`desktop/src-tauri/${file} has no ${field}`);
    return { path, text: text.replace(pattern, (_, prefix, suffix) => `${prefix}${version}${suffix}`) };
  });
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
  const desktopVersions = prepareDesktopVersions(root, version);
  plugin.source.ref = `orca-plugin-v${version}`;
  pkg.version = version;
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(changelogPath, changelog);
  writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);
  for (const { path, text } of desktopVersions) writeFileSync(path, text);
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
