#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildDesktopFeed, publishDesktopRelease, stableVersion } from "./desktop-feed";
import { githubDesktopPublisher } from "./desktop-publisher";

/** The native update feed carries at most this many bytes of notes (see desktop-feed.ts). */
export const DESKTOP_NOTES_MAX = 32768;

/**
 * Release notes that fit the desktop feed: long notes keep their leading entries, cut before the first entry that
 * would overflow, and end with a link to the full notes on the GitHub release.
 */
export function desktopNotes(notes: string, version: string): string {
  if (Buffer.byteLength(notes, "utf8") <= DESKTOP_NOTES_MAX) return notes;
  const repo = process.env.GITHUB_REPOSITORY || "lamtuanvu/pacer", server = process.env.GITHUB_SERVER_URL || "https://github.com";
  const tail = `\n\nThe full release notes are at ${server}/${repo}/releases/tag/v${version}.`;
  const budget = DESKTOP_NOTES_MAX - Buffer.byteLength(tail, "utf8"), lines = notes.split("\n");
  let kept = 0, size = 0, cut = 0;
  for (const [i, line] of lines.entries()) {
    // An entry starts at a bullet or a heading; never split one.
    if (/^(?:- |#{1,6} )/.test(line)) cut = i;
    size += Buffer.byteLength(line, "utf8") + 1;
    if (size > budget) break;
    kept = i + 1;
  }
  const body = lines.slice(0, kept === lines.length ? kept : cut).join("\n").trimEnd().replace(/\n#{1,6} [^\n]*$/, "");
  return body + tail;
}

export async function prepareDesktopManifest(root: string, out: string, version: string, date?: string): Promise<void> {
  stableVersion(version);
  const lines = readFileSync(join(root, "CHANGELOG.md"), "utf8").split("\n"), heading = `## [${version}]`;
  const start = lines.findIndex(s => s === heading || s.startsWith(heading + " - "));
  if (start < 0) throw Error("Missing desktop release notes");
  const rest = lines.slice(start + 1), end = rest.findIndex(s => s.startsWith("## "));
  const notes = desktopNotes(rest.slice(0, end < 0 ? undefined : end).join("\n").trim(), version);
  if (!date) {
    const child = Bun.spawn(["git", "show", "-s", "--format=%cI", "HEAD"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code) throw Error("Cannot identify desktop release commit date");
    date = new Date(stdout.trim()).toISOString();
  }
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(date) || !Number.isFinite(Date.parse(date))) throw Error("Invalid desktop release date");
  const path = join(out, `desktop-release-${version}.json`), bytes = JSON.stringify({ schema: 1, version, notes, pub_date: date }, null, 2) + "\n";
  if (existsSync(path)) { if (readFileSync(path, "utf8") !== bytes) throw Error("Desktop immutable manifest conflict"); }
  else writeFileSync(path, bytes, { flag: "wx" });
}
if (import.meta.main) {
  try {
    const [action, dir, version] = process.argv.slice(2);
    if (!["prepare", "validate", "publish"].includes(action) || !dir || !version || process.argv.length !== 5) throw Error("usage: desktop-release.ts <prepare|validate|publish> <release-directory> <version>");
    stableVersion(version);
    if (action === "prepare") await prepareDesktopManifest(resolve(import.meta.dir, "../.."), resolve(dir), version);
    else if (action === "validate") console.log(await buildDesktopFeed(resolve(dir), version));
    else {
      if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_EVENT_NAME !== "push" || process.env.GITHUB_REF !== `refs/tags/v${version}` || process.env.GITHUB_REPOSITORY !== "lamtuanvu/pacer" || process.env.PACER_DESKTOP_RELEASE_ENABLED !== "true") throw Error("Desktop publication requires an enabled tagged production release job");
      await publishDesktopRelease(resolve(dir), version, githubDesktopPublisher(version, process.env.GH_TOKEN ?? ""));
    }
  } catch (error) { console.error((error as Error).message); process.exit(1); }
}
