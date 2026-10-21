#!/usr/bin/env bun
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compileTarget } from "./release/build";
import { hostTarget } from "../src/update/manifest";
import { isVersion } from "../src/update/version";

/** Package version is authoritative; Git describes the local checkout only. */
export function localBuildVersion(root: string): string {
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (typeof version !== "string" || !isVersion(version)) throw Error("invalid package version");
  let description = "";
  try {
    const result = Bun.spawnSync([
      "git", "describe", "--tags", "--long", "--always", "--dirty", "--match", "v[0-9]*",
    ], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode === 0) description = result.stdout.toString().trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Source archives need no Git installation/history.
  return versionFromDescription(version, description);
}

export function versionFromDescription(version: string, description: string): string {
  const tagged = /-(\d+)-g([0-9a-f]+)(-dirty)?$/.exec(description);
  let metadata: string;
  if (tagged) {
    if (tagged[1] === "0" && !tagged[3]) return version;
    metadata = `${tagged[1]}.g${tagged[2]}${tagged[3] ? ".dirty" : ""}`;
  } else if (/^[0-9a-f]+(?:-dirty)?$/.test(description)) {
    metadata = `g${description.replace(/-dirty$/, ".dirty")}`;
  } else return version;
  return `${version}${version.includes("+") ? "." : "+"}${metadata}`;
}

export async function buildLocal(root: string): Promise<void> {
  const target = hostTarget();
  if (!target) throw Error(`unsupported build host: ${process.platform}-${process.arch}`);
  const version = localBuildVersion(root);
  mkdirSync(join(root, "dist"), { recursive: true });
  await compileTarget({ root, target, version, outfile: join(root, "dist", "pacer-core") });
  // The Rust front door execs dist/pacer-core as its sibling. Without cargo or the Cargo
  // workspace, the core alone is a complete CLI, so it also ships as dist/pacer.
  const skip = (why: string) => {
    copyFileSync(join(root, "dist", "pacer-core"), join(root, "dist", "pacer"));
    console.log(`rust front door skipped: ${why}; dist/pacer is the TypeScript core`);
  };
  if (!existsSync(join(root, "Cargo.toml"))) return skip("no Cargo workspace");
  try {
    const result = Bun.spawnSync(["cargo", "build", "--release", "-p", "pacer"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw Error(`cargo build failed (exit ${result.exitCode}):\n${result.stderr.toString().trim()}`);
    copyFileSync(join(root, "target", "release", "pacer"), join(root, "dist", "pacer"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    skip("cargo is not on PATH");
  }
}

if (import.meta.main) await buildLocal(resolve(import.meta.dir, ".."));
