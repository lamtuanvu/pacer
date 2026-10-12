import { fileURLToPath } from "node:url";
import { ReleaseError } from "./errors";

/** Injectable network access: every release download goes through one of these. */
export type FetchFn = (url: string) => Promise<Response>;

const ALLOWED_BASE = /^(https:\/\/|file:\/\/|http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$))/;

export function normalizeBase(base: string): string {
  const b = base.trim().replace(/\/+$/, "");
  if (!ALLOWED_BASE.test(b) || b.includes("@")) {
    throw new ReleaseError(`release base must start with https://, file://, or http://127.0.0.1 / http://localhost (got "${base}")`);
  }
  return b;
}

/** Bun's fetch answers 200 for a missing file:// path, so file URLs are read directly. */
export const releaseFetch: FetchFn = async (url) => {
  if (url.startsWith("file://")) {
    const path = fileURLToPath(url);
    const f = Bun.file(path);
    if (!(await f.exists())) return new Response(`not found: ${path}`, { status: 404 });
    return new Response(await f.arrayBuffer());
  }
  return fetch(url, { signal: AbortSignal.timeout(300_000) });
};

export async function fetchBytes(fetchFn: FetchFn, url: string): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetchFn(url);
  } catch (e) {
    throw new ReleaseError(`download failed: ${url} (${(e as Error).message})`);
  }
  if (!res.ok) throw new ReleaseError(`download failed: ${url} (HTTP ${res.status})`);
  try {
    return new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    throw new ReleaseError(`download failed: ${url} (${(e as Error).message})`);
  }
}

export async function fetchText(fetchFn: FetchFn, url: string): Promise<string> {
  return new TextDecoder().decode(await fetchBytes(fetchFn, url));
}
