/**
 * Resolves the background worker entrypoint for both source and compiled runs.
 *
 * In a compiled binary import.meta.url is /$bunfs/root/<entry>, and a worker
 * file passed as an extra entrypoint (COMPILED_WORKERS in scripts/release/build.ts)
 * is embedded at /$bunfs/root/<repo-root-relative-source-path>.js — e.g.
 * src/serve/background-worker.ts lands at /$bunfs/root/src/serve/background-worker.js.
 * The .ts source relative path only exists before bundling, so the two branches
 * differ. Verified by test/compiled-workers.test.ts ("starts inside a compiled
 * binary"); the source-relative .ts URL is what that test also cross-checks as a
 * compile entrypoint. Callers pass their own module's import.meta.url.
 */
export function backgroundWorkerEntryURL(metaURL: string): URL {
  if (metaURL.includes("/$bunfs/")) return new URL("./src/serve/background-worker.js", metaURL);
  return new URL("./background-worker.ts", metaURL);
}