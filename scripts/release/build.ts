#!/usr/bin/env bun
import { validSignerPins, type SignerPins } from "../../src/update/desktop/signer-requirement";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type Manifest, type Platform, type ReleaseAsset, type Target, TARGETS, assetFile, formatSha256Sums,
  hostPlatform, hostTarget, parseLatest, sha256Hex,
} from "../../src/update/manifest";
import { signLocal } from "../../src/update/signing";
import { compareVersions, isVersion } from "../../src/update/version";

export const BUILD_USAGE = "usage: bun run release [--host | --targets <os-arch,...>] [--write-only] [--desktop-production] [--out <dir>] [--version <x.y.z>]";

export interface BuildArgs { host: boolean; out?: string; version?: string; targets?: Target[]; writeOnly?: boolean; desktopProduction?: boolean }

export interface BuildOptions {
  root: string;
  outRoot?: string;
  version?: string;
  targets?: Target[];
  bunExe?: string;
  desktopTrust?: SignerPins;
  log?: (line: string) => void;
}

export function parseBuildArgs(argv: string[]): BuildArgs | string {
  const a: BuildArgs = { host: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--host") {
      a.host = true;
    } else if (x === "--desktop-production") {
      a.desktopProduction = true;
    } else if (x === "--write-only") {
      a.writeOnly = true;
    } else if (x === "--out" || x === "--version" || x === "--targets") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) return `release: ${x} needs a value\n${BUILD_USAGE}`;
      if (x === "--out") a.out = v;
      else if (x === "--version") a.version = v;
      else {
        const names = v.split(",");
        const targets = names.map(name => TARGETS.find(t => `${t.os}-${t.arch}` === name));
        if (targets.some(t => !t) || new Set(names).size !== names.length) return `release: invalid --targets "${v}"`;
        a.targets = targets as Target[];
      }
      i++;
    } else {
      return `release: unknown argument "${x}"\n${BUILD_USAGE}`;
    }
  }
  if (a.host && a.targets) return "release: --host and --targets cannot be combined";
  return a;
}

/** One `bun build --compile` for one target. The host target reuses the running bun, so it needs no download. */
type CompileOptions = { root: string; target: Target; version: string; outfile: string; bunExe?: string; desktopTrust?: SignerPins };
function validateDesktopTrust(trust?: SignerPins): void {
  if (trust && !validSignerPins(trust)) throw Error("Invalid desktop signer pins (Apple Team ID and/or signing certificate SHA-1)");
}
export function compileCommand(o: CompileOptions): string[] {
  validateDesktopTrust(o.desktopTrust);
  if (o.desktopTrust && o.target.os !== "darwin") throw Error("Desktop trust requires a macOS target");
  const bun = o.bunExe ?? process.execPath;
  const host = hostPlatform();
  const isHost = host !== null && host.os === o.target.os && host.arch === o.target.arch;
  return [
    bun, "build", "--compile",
    `--target=${o.target.bunTarget}`,
    "--define", `PACER_BUILD_VERSION=${JSON.stringify(o.version)}`,
    ...(o.desktopTrust?.appleTeamId ? ["--define", `PACER_BUILD_APPLE_TEAM_ID=${JSON.stringify(o.desktopTrust.appleTeamId)}`] : []),
    ...(o.desktopTrust?.signingCertSha1 ? ["--define", `PACER_BUILD_SIGNING_CERT_SHA1=${JSON.stringify(o.desktopTrust.signingCertSha1)}`] : []),
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    ...(isHost ? [`--compile-executable-path=${bun}`] : []),
    join(o.root, "src", "cli.ts"),
    "--outfile", o.outfile,
  ];
}
export async function compileTarget(o: CompileOptions): Promise<void> {
  const argv = compileCommand(o);
  const host = hostPlatform();
  const isHost = host !== null && host.os === o.target.os && host.arch === o.target.arch;
  const p = Bun.spawn(argv, { cwd: o.root, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`bun build failed for ${o.target.bunTarget} (exit ${code}):\n${(err || out).trim()}`);
  if (o.target.os === "darwin" && !o.desktopTrust) await signLocal(o.outfile, { smoke: isHost });
}

function readLatestVersion(path: string): string | null {
  try {
    return parseLatest(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/** Hash the binaries already in <outRoot>/<version>/ and write SHA256SUMS, manifest.json and <outRoot>/latest.json. */
export function writeRelease(outRoot: string, version: string, platforms: Platform[]): Manifest {
  const dir = join(outRoot, version);
  const assets: ReleaseAsset[] = platforms.map((p) => {
    const file = assetFile(p);
    const bytes = readFileSync(join(dir, file));
    return { os: p.os, arch: p.arch, file, sha256: sha256Hex(bytes), size: bytes.length };
  });
  const manifest: Manifest = { version, assets };
  writeFileSync(join(dir, "SHA256SUMS"), formatSha256Sums(assets));
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const latestPath = join(outRoot, "latest.json");
  const prev = readLatestVersion(latestPath);
  if (prev === null || compareVersions(version, prev) >= 0) writeFileSync(latestPath, `${JSON.stringify({ version })}\n`);
  return manifest;
}

function readPackageVersion(root: string): string {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
  return typeof pkg.version === "string" ? pkg.version : "";
}

export async function buildRelease(o: BuildOptions): Promise<{ dir: string; manifest: Manifest }> {
  validateDesktopTrust(o.desktopTrust);
  if (o.desktopTrust && (o.targets ?? TARGETS).some(t => t.os !== "darwin")) throw Error("Desktop trust requires macOS targets");
  const version = o.version ?? readPackageVersion(o.root);
  if (!isVersion(version)) throw new Error(`invalid version "${version}" (expected MAJOR.MINOR.PATCH[-PRERELEASE])`);
  const appAssets = join(o.root, "src", "app", "assets.generated.ts");
  if (o.version === undefined && existsSync(appAssets) && !readFileSync(appAssets, "utf8").includes(`APP_VERSION = ${JSON.stringify(version)};`)) {
    throw new Error(`the bundled app assets are not built for ${version}; run bun run app:build first`);
  }
  const outRoot = o.outRoot ?? join(o.root, "dist", "release");
  const targets = o.targets ?? TARGETS;
  const log = o.log ?? (() => {});
  const dir = join(outRoot, version);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const t of targets) {
    log(`building ${assetFile(t)} (${t.bunTarget})`);
    await compileTarget({ root: o.root, target: t, version, outfile: join(dir, assetFile(t)), bunExe: o.bunExe, desktopTrust: o.desktopTrust });
  }
  return { dir, manifest: writeRelease(outRoot, version, targets) };
}

if (import.meta.main) {
  const a = parseBuildArgs(process.argv.slice(2));
  if (typeof a === "string") {
    console.error(a);
    process.exit(2);
  }
  const host = hostTarget();
  if (a.host && !host) {
    console.error(`release: no release target for this host (${process.platform}-${process.arch})`);
    process.exit(2);
  }
  try {
    const root = resolve(import.meta.dir, "..", "..");
    const outRoot = a.out ? resolve(a.out) : join(root, "dist", "release");
    const version = a.version ?? readPackageVersion(root);
    if (!isVersion(version)) throw new Error(`invalid version "${version}"`);
    const targets = a.targets ?? (a.host && host ? [host] : TARGETS);
    const { dir, manifest } = a.writeOnly
      ? { dir: join(outRoot, version), manifest: writeRelease(outRoot, version, targets) }
      : await buildRelease({ root, outRoot, version: a.version, targets, desktopTrust: a.desktopProduction ? { appleTeamId: process.env.PACER_APPLE_TEAM_ID || null, signingCertSha1: process.env.PACER_SIGNING_CERT_SHA1 || null } : undefined, log: line => console.log(line) });
    console.log(`release ${manifest.version}: ${dir}`);
    for (const x of manifest.assets) console.log(`  ${x.file}  ${x.size} bytes  sha256 ${x.sha256}`);
  } catch (e) {
    console.error(`release: ${(e as Error).message}`);
    process.exit(1);
  }
}
