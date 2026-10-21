import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { arch, release } from "node:os";
import { atomicWrite, checkout, type Session } from "../core";
export function sourceFingerprint(): { head: string; dirty_fingerprint: string } {
  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: checkout, stdout: "pipe", stderr: "pipe" }).stdout.toString();
  const hash = createHash("sha256");
  hash.update(git(["diff", "--binary", "HEAD"]));
  for (const file of git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean).sort()) {
    hash.update(file); hash.update(readFileSync(join(checkout, file)));
  }
  return { head: git(["rev-parse", "HEAD"]).trim(), dirty_fingerprint: hash.digest("hex") };
}
export function recordProvenance(session: Session): void {
  const source = sourceFingerprint();
  const desktop = session.desktopExecutable;
  atomicWrite(join(session.root, "evidence", "provenance.json"), JSON.stringify({
    schema_version: 1, run_id: session.id, ...source, runtime: Bun.version,
    platform: process.platform, os_release: release(), architecture: arch(),
    data: session.seed ? "synthetic" : "real", captured_at: new Date().toISOString(),
    desktop_build: desktop?.includes("/debug/") ? "debug" : desktop ? "release-or-external" : "absent",
    desktop_sha256: desktop && existsSync(desktop) ? createHash("sha256").update(readFileSync(desktop)).digest("hex") : undefined,
  }, null, 2) + "\n");
}
