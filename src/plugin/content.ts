import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_FILES } from "./assets.generated";

/** Hash only shipped assets; the live panel and ownership/installation metadata are mutable. */
function contentHash(read: (rel: string) => Uint8Array): string {
  const hash = createHash("sha256");
  for (const { rel } of [...PLUGIN_FILES].sort((a, b) => a.rel.localeCompare(b.rel))) {
    const bytes = read(rel);
    hash.update(JSON.stringify([rel, bytes.length]));
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export const BUNDLED_PLUGIN_HASH = contentHash(rel => Buffer.from(PLUGIN_FILES.find(f => f.rel === rel)!.text));

export function installedPluginHash(dir: string): string | null {
  try { return contentHash(rel => readFileSync(join(dir, rel))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
