import { createHash } from "node:crypto";
import { readFileSync, lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";
export interface SourceFingerprint { head: string; dirty_fingerprint: string }
export function sourceFingerprint(root: string): SourceFingerprint {
  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" }).stdout.toString();
  const hash = createHash("sha256");
  hash.update(git(["diff", "--binary", "HEAD"]));
  for (const file of git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean).sort()) {
    const path = join(root, file);
    hash.update(file);
    hash.update(lstatSync(path).isSymbolicLink() ? readlinkSync(path) : readFileSync(path));
  }
  return { head: git(["rev-parse", "HEAD"]).trim(), dirty_fingerprint: hash.digest("hex") };
}
