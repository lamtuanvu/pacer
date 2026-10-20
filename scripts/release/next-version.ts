#!/usr/bin/env bun
/** Picks the next release version from Conventional Commit titles since the last tag. */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isVersion } from "../../src/update/version";

export type Bump = "major" | "minor" | "patch";
export const BUMPS = ["auto", "major", "minor", "patch"] as const;

const title = /^(?<type>[a-z]+)(?:\([^)]*\))?(?<breaking>!)?: /;
/** Types that change what users get; the rest (docs, test, chore, ci...) don't cut a release. */
const releasing: Record<string, Bump> = { feat: "minor", fix: "patch", perf: "patch", revert: "patch" };
const order: Bump[] = ["patch", "minor", "major"];

/** A breaking change is a major bump from 1.0 on; during 0.x it is a minor bump (REL-1). */
export function bumpFor(subjects: string[], current: string): Bump | null {
  let bump: Bump | null = null;
  for (const subject of subjects) {
    const m = title.exec(subject);
    if (!m?.groups) continue;
    const next: Bump | undefined = m.groups.breaking ? (current.startsWith("0.") ? "minor" : "major") : releasing[m.groups.type];
    if (next && (!bump || order.indexOf(next) > order.indexOf(bump))) bump = next;
  }
  return bump;
}

export function applyBump(current: string, bump: Bump): string {
  if (!/^\d+\.\d+\.\d+$/.test(current)) throw new Error(`current version ${current} is not MAJOR.MINOR.PATCH`);
  const [major, minor, patch] = current.split(".").map(Number) as [number, number, number];
  return bump === "major" ? `${major + 1}.0.0` : bump === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

/** Unreleased must say what ships; an empty section means the CHANGELOG was not kept up. */
export function unreleasedNotes(changelog: string): string {
  const m = /^## \[Unreleased\][ \t]*\n([\s\S]*?)(?=^## \[|(?![\s\S]))/m.exec(changelog);
  if (!m) throw new Error("CHANGELOG.md has no Unreleased section");
  return m[1]!.trim();
}

export function nextVersion(o: { current: string; subjects: string[]; requested: (typeof BUMPS)[number]; changelog: string }): { version: string; bump: Bump } {
  if (!isVersion(o.current)) throw new Error(`package.json version ${o.current} is not a version`);
  if (!unreleasedNotes(o.changelog)) throw new Error("CHANGELOG.md Unreleased is empty; add the changes before releasing");
  const bump = o.requested === "auto" ? bumpFor(o.subjects, o.current) : o.requested;
  if (!bump) throw new Error("no feat, fix, perf, revert or breaking commits since the last release; pick a bump explicitly to release anyway");
  return { version: applyBump(o.current, bump), bump };
}

function git(root: string, args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString().trim()}`);
  return p.stdout.toString();
}

if (import.meta.main) {
  try {
    const requested = (process.argv[2] ?? "auto") as (typeof BUMPS)[number];
    if (process.argv.length > 3 || !BUMPS.includes(requested)) throw new Error(`usage: bun scripts/release/next-version.ts [${BUMPS.join("|")}]`);
    const root = resolve(import.meta.dir, "..", "..");
    const current = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
    const tag = `v${current}`;
    if (!git(root, ["tag", "--list", tag]).trim()) throw new Error(`the current version ${current} has no ${tag} tag; release it before preparing the next one`);
    const subjects = git(root, ["log", "--format=%s", `${tag}..HEAD`]).split("\n").filter(Boolean);
    const { version, bump } = nextVersion({ current, subjects, requested, changelog: readFileSync(join(root, "CHANGELOG.md"), "utf8") });
    console.error(`${current} -> ${version} (${bump}; ${subjects.length} commits since ${tag})`);
    console.log(version);
  } catch (e) {
    console.error(`next-version: ${(e as Error).message}`);
    process.exit(1);
  }
}
