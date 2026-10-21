import { realpathSync, statSync } from "node:fs";

/** A static signature verdict depends only on file bytes. Any rewrite or replacement changes this identity. */
export function fileIdentity(path: string): string {
  const real = realpathSync(path),
    stat = statSync(real, { bigint: true });
  return [real, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

/** Remembers successful verifications; it never stores a refusal. */
export class VerifiedOnce {
  private seen = new Set<string>();
  constructor(private readonly limit = 256) {}
  has(key: string): boolean {
    return this.seen.has(key);
  }
  add(key: string): void {
    if (this.seen.size >= this.limit) this.seen.clear();
    this.seen.add(key);
  }
}
