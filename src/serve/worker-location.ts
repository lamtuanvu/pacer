/**
 * Release entrypoints share src/ as Bun's common root. Compiled worker URLs
 * retain .ts and are relative to the bundle root; source URLs are module-relative.
 */
export function backgroundWorkerEntryURL(metaURL: string): URL {
  if (metaURL.includes("/$bunfs/")) return new URL("./serve/background-worker.ts", metaURL);
  return new URL("./background-worker.ts", metaURL);
}

export function supervisionWorkerEntryURL(metaURL: string): URL {
  if (metaURL.includes("/$bunfs/")) return new URL("./tasks/supervision-worker.ts", metaURL);
  return new URL("../tasks/supervision-worker.ts", metaURL);
}
