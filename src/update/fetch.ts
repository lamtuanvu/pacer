import { fileURLToPath } from "node:url";
import { ReleaseError } from "./errors";

/** Injectable network access: every release download goes through one of these. */
export type FetchFn = (url: string) => Promise<Response>;

const ALLOWED_BASE = /^(https:\/\/|file:\/\/|http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$))/;

export function normalizeBase(base: string): string {
  const b = base.trim().replace(/\/+$/, "");
  if (!ALLOWED_BASE.test(b) || b.includes("@") || b.includes("?") || b.includes("#")) {
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
    return new Response(f.stream());
  }
  return fetch(url, { redirect: "manual", signal: AbortSignal.timeout(300_000) });
};

export async function fetchBytes(fetchFn: FetchFn, url: string, maxBytes = Number.POSITIVE_INFINITY): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetchFn(url);
  } catch (e) {
    throw new ReleaseError(`download failed: ${url} (${(e as Error).message})`);
  }
  if (res.status >= 300 && res.status < 400) throw new ReleaseError(`download failed: ${url} (redirect HTTP ${res.status})`);
  if (!res.ok) throw new ReleaseError(`download failed: ${url} (HTTP ${res.status})`);
  const declaredLength = res.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    await res.body?.cancel();
    throw new ReleaseError(`download failed: ${url} (exceeds ${maxBytes} byte limit)`);
  }
  try {
    if (!res.body) return new Uint8Array();
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ReleaseError(`download failed: ${url} (exceeds ${maxBytes} byte limit)`);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (e) {
    if (e instanceof ReleaseError) throw e;
    throw new ReleaseError(`download failed: ${url} (${(e as Error).message})`);
  }
}

export async function fetchText(fetchFn: FetchFn, url: string): Promise<string> {
  return new TextDecoder().decode(await fetchBytes(fetchFn, url, 1024 * 1024));
}
