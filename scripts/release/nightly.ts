#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareVersions, isVersion } from "../../src/update/version";
import { desktopNotes } from "./desktop-release";
import { bumpCargoVersion, bumpJsonVersion } from "./prepare";

/** `<next-minor>-nightly.<YYYYMMDDHHmm UTC>`; the stamp is one numeric identifier with no leading zero. */
export const NIGHTLY_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-nightly\.[1-9]\d{11}$/;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export type ReleaseChannel = "stable" | "nightly" | "prerelease";

/** The only files a nightly stamp commit may change, relative to the repository root. */
export const NIGHTLY_STAMP_FILES: readonly string[] = Object.freeze([
  "package.json",
  "desktop/src-tauri/tauri.conf.json",
  "desktop/src-tauri/Cargo.toml",
  "desktop/src-tauri/Cargo.lock",
  "src/app/assets.generated.ts",
]);

export function isNightlyVersion(version: string): boolean {
  return NIGHTLY_VERSION.test(version);
}

/** The release channel a version belongs to; throws on anything that is not SemVer. */
export function releaseChannel(version: string): ReleaseChannel {
  if (!isVersion(version)) throw new Error(`invalid version ${version}`);
  if (STABLE_VERSION.test(version)) return "stable";
  return isNightlyVersion(version) ? "nightly" : "prerelease";
}

/** The minor after `latestStable`, stamped with the UTC minute of `at`. */
export function nightlyVersion(latestStable: string, at: Date): string {
  const match = STABLE_VERSION.exec(latestStable);
  if (!match) throw new Error(`latest stable ${latestStable} is not X.Y.Z`);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}`;
  return `${match[1]}.${Number(match[2]) + 1}.0-nightly.${stamp}`;
}

/** Write a nightly version into the version files only. CHANGELOG.md is never touched. */
export async function stampNightly(root: string, version: string): Promise<void> {
  if (!isNightlyVersion(version)) throw new Error(`${version} is not a nightly version (X.Y.Z-nightly.YYYYMMDDHHmm)`);
  const packagePath = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  const desktopPath = join(root, "desktop", "src-tauri");
  const tauriPath = join(desktopPath, "tauri.conf.json");
  const cargoPath = join(desktopPath, "Cargo.toml");
  const lockPath = join(desktopPath, "Cargo.lock");
  // Compute every edit before writing so a malformed file leaves the tree unchanged.
  const tauri = bumpJsonVersion(readFileSync(tauriPath, "utf8"), version);
  const cargo = bumpCargoVersion(readFileSync(cargoPath, "utf8"), version, false);
  const lock = bumpCargoVersion(readFileSync(lockPath, "utf8"), version, true);
  pkg.version = version;
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(tauriPath, tauri);
  writeFileSync(cargoPath, cargo);
  writeFileSync(lockPath, lock);
  // The app embeds APP_VERSION, which the release build checks against package.json.
  const build = Bun.spawn([process.execPath, "run", "app:build"], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (await build.exited !== 0) throw new Error("app:build failed while stamping the nightly version");
}

/** Markdown release notes: a heading and one bullet per commit subject, cut to the desktop feed limit. */
export function nightlyNotes(subjects: string[], version: string): string {
  const lines = subjects.map(subject => subject.trim()).filter(Boolean).map(subject => `- ${subject}`);
  const body = lines.length > 0 ? lines.join("\n") : "- No changes since the previous nightly.";
  return desktopNotes(`## pacer ${version}\n\n${body}`, version);
}

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

/** The newest `vX.Y.Z` tag, the same selection as release-prepare.yml. */
function latestStableTag(root: string): string {
  const tags = git(root, ["tag", "-l", "v[0-9]*.[0-9]*.[0-9]*", "--sort=-v:refname"]).split("\n");
  const latest = tags.find(tag => tag && !tag.includes("-"));
  if (!latest) throw new Error("no stable vX.Y.Z tag found");
  return latest.slice(1);
}

function commitSubjects(root: string, from: string, to: string): string[] {
  return git(root, ["log", "-z", "--format=%s", `${from}..${to}`]).split("\0").filter(Boolean);
}

/** Paths a stamp commit changed outside NIGHTLY_STAMP_FILES. */
function unexpectedChanges(root: string, parent: string, tag: string): string[] {
  const allowed = new Set(NIGHTLY_STAMP_FILES);
  return git(root, ["diff", "-z", "--name-only", parent, tag]).split("\0").filter(path => path && !allowed.has(path));
}

export type NightlyRelease = { tag: string; createdAt: Date };

/**
 * Nightly tags to delete: everything except the newest `keepMin` by version, tags created within
 * `keepDays` of `now`, and tags a feed references. Non-nightly tags are never returned.
 */
export function prunable(nightlies: NightlyRelease[], referenced: Set<string>, now: Date, keepDays = 14, keepMin = 3): string[] {
  const cutoff = now.getTime() - keepDays * 86_400_000;
  return nightlies
    .filter(release => release.tag.startsWith("v") && isNightlyVersion(release.tag.slice(1)))
    .sort((a, b) => compareVersions(b.tag.slice(1), a.tag.slice(1)))
    .filter((release, index) => index >= keepMin && release.createdAt.getTime() < cutoff && !referenced.has(release.tag))
    .map(release => release.tag);
}

/** The nightly feeds on `desktop-updates` (DESKTOP_FEED_FILE.nightly and CLI_NIGHTLY_FEED_FILE; both import this module). */
export const NIGHTLY_FEED_FILES: readonly string[] = Object.freeze(["nightly.json", "cli-nightly.json"]);

export interface NightlyPruneClient {
  releases(): Promise<NightlyRelease[]>;
  /** The version a feed file references, or null when the feed does not exist yet. */
  feedVersion(file: string): Promise<string | null>;
  deleteRelease(tag: string): Promise<void>;
}

/** Delete old nightly releases and their tags. Every feed is read before anything is deleted. */
export async function pruneNightlies(client: NightlyPruneClient, now: Date, keepDays: number, keepMin: number, log = console.log): Promise<string[]> {
  const referenced = new Set<string>();
  for (const file of NIGHTLY_FEED_FILES) {
    const version = await client.feedVersion(file);
    if (version !== null) referenced.add(`v${version}`);
  }
  const doomed = prunable(await client.releases(), referenced, now, keepDays, keepMin);
  for (const tag of doomed) {
    log(`deleting nightly ${tag}`);
    await client.deleteRelease(tag);
  }
  if (doomed.length === 0) log("no nightly to prune");
  return doomed;
}

function gh(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function ghOk(args: string[]): string {
  const result = gh(args);
  if (result.code !== 0) throw new Error(`gh ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout;
}

export function githubPruneClient(repo: string): NightlyPruneClient {
  return {
    releases: async () => (JSON.parse(ghOk(["release", "list", "--repo", repo, "--limit", "1000", "--json", "tagName,createdAt"])) as { tagName: string; createdAt: string }[])
      .map(release => ({ tag: release.tagName, createdAt: new Date(release.createdAt) })),
    feedVersion: async file => {
      const result = gh(["api", "-H", "Accept: application/vnd.github.raw+json", `repos/${repo}/contents/${file}?ref=desktop-updates`]);
      if (result.code !== 0) {
        if (/HTTP 404/.test(result.stderr)) return null;
        throw new Error(`reading ${file} from desktop-updates: ${result.stderr.trim()}`);
      }
      const version = (JSON.parse(result.stdout) as { version?: unknown }).version;
      if (typeof version !== "string") throw new Error(`${file} on desktop-updates has no version`);
      return version;
    },
    deleteRelease: async tag => { ghOk(["release", "delete", tag, "--repo", repo, "--yes", "--cleanup-tag"]); },
  };
}

function pruneOptions(args: string[]): { keepDays: number; keepMin: number } {
  const options = { keepDays: 14, keepMin: 3 };
  for (let i = 0; i < args.length; i += 2) {
    const value = Number(args[i + 1]);
    if (args[i + 1] === undefined || !Number.isInteger(value) || value < 0) throw new Error(`${args[i]} needs a whole number`);
    if (args[i] === "--keep-days") options.keepDays = value;
    else if (args[i] === "--keep-min") options.keepMin = value;
    else throw new Error(USAGE);
  }
  return options;
}

const USAGE = "usage: nightly.ts version [--at <iso>] | stamp <version> | notes <version> <from-ref> <to-ref> | classify <version> | check-diff <parent> <tag> | prune [--keep-days <n>] [--keep-min <n>]";

if (import.meta.main) {
  try {
    // Git and stamp commands run in the current directory: the checkout being released.
    const root = process.cwd();
    const [command, ...args] = process.argv.slice(2);
    if (command === "version" && (args.length === 0 || (args.length === 2 && args[0] === "--at"))) {
      const at = args.length === 2 ? new Date(args[1]!) : new Date();
      if (!Number.isFinite(at.getTime())) throw new Error(`invalid --at time ${args[1]}`);
      console.log(nightlyVersion(latestStableTag(root), at));
    } else if (command === "stamp" && args.length === 1) {
      await stampNightly(root, args[0]!);
    } else if (command === "notes" && args.length === 3) {
      const [version, from, to] = args as [string, string, string];
      if (!isNightlyVersion(version)) throw new Error(`${version} is not a nightly version`);
      console.log(nightlyNotes(commitSubjects(root, from, to), version));
    } else if (command === "classify" && args.length === 1) {
      console.log(releaseChannel(args[0]!));
    } else if (command === "check-diff" && args.length === 2) {
      const unexpected = unexpectedChanges(root, args[0]!, args[1]!);
      if (unexpected.length > 0) throw new Error(`the nightly stamp commit changes files outside the version files: ${unexpected.join(", ")}`);
    } else if (command === "prune") {
      const { keepDays, keepMin } = pruneOptions(args);
      const repo = process.env.GITHUB_REPOSITORY;
      if (!repo) throw new Error("GITHUB_REPOSITORY is required");
      await pruneNightlies(githubPruneClient(repo), new Date(), keepDays, keepMin);
    } else {
      throw new Error(USAGE);
    }
  } catch (error) {
    console.error(`nightly: ${(error as Error).message}`);
    process.exit(1);
  }
}
