import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";
import { pluginRegistry } from "../plugins";
import { parseManifest } from "../plugins/manifest";
import { WRITE_DIRECTORY, WRITE_OPEN, writeNative } from "../plugins/write-native";

const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 32 * 1024;
const TICKET_SECONDS = 3600;
const TICKET = /^s1\.([a-z0-9]+)\.([a-f0-9]{32})\.([a-f0-9]{64})$/;
const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8", json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8", svg: "image/svg+xml",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2",
};

/** `sandbox` omits allow-same-origin, so plugin script cannot read the app's cookie or API. */
export const SURFACE_HEADERS = {
  "Content-Security-Policy": "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

const notFound = () => new Response("not found\n", { status: 404, headers: SURFACE_HEADERS });
const safeSegment = (raw: string): string | null => {
  try {
    const value = decodeURIComponent(raw);
    return value && value !== "." && value !== ".." && !/[/\\\x00-\x1f\x7f]/.test(value) ? value : null;
  } catch { return null; }
};

function routeParts(pathname: string): { prefix: string; ticket: string | null; assets: string[] } | null {
  if (pathname.length > 512 || !pathname.startsWith("/app/plugins/")) return null;
  const parts = pathname.slice("/app/plugins/".length).split("/");
  const prefix = safeSegment(parts.shift() ?? "");
  if (!prefix || !/^[a-z0-9-]{1,32}$/.test(prefix)) return null;
  const ticket = parts[0] === "_s" ? parts.splice(0, 2)[1] ?? "" : null;
  if (parts.length === 1 && parts[0] === "") parts[0] = "index.html";
  const assets = parts.map(safeSegment);
  if (!assets.length || assets.some(part => part === null)) return null;
  return { prefix, ticket, assets: assets as string[] };
}

function signature(secret: string, prefix: string, pluginId: string, expiry: string, nonce: string): string {
  return createHmac("sha256", secret).update(`surface\0${prefix}\0${pluginId}\0${expiry}\0${nonce}`).digest("hex");
}

/** A URL ticket reads only one plugin's static files; it never authorizes service operations. */
export function validSurfaceTicket(ctx: Ctx, pathname: string, secret: string): boolean {
  const parsed = routeParts(pathname);
  if (!parsed?.ticket) return false;
  const match = TICKET.exec(parsed.ticket);
  if (!match) return false;
  const expiry = Number.parseInt(match[1]!, 36);
  if (!Number.isSafeInteger(expiry) || expiry < Date.now() / 1000 || expiry > Date.now() / 1000 + TICKET_SECONDS) return false;
  const selected = pluginRegistry(ctx).surface(ctx, parsed.prefix);
  if (!selected) return false;
  const expected = Buffer.from(signature(secret, parsed.prefix, selected.pluginId, match[1]!, match[2]!), "hex");
  const provided = Buffer.from(match[3]!, "hex");
  return timingSafeEqual(expected, provided);
}

function issueSurfaceTicket(secret: string, prefix: string, pluginId: string): string {
  const expiry = Math.floor(Date.now() / 1000 + TICKET_SECONDS).toString(36);
  const nonce = randomBytes(16).toString("hex");
  return `s1.${expiry}.${nonce}.${signature(secret, prefix, pluginId, expiry, nonce)}`;
}

/** Read a regular file from an opened directory, never a pathname after validation. */
function readPinned(parent: number, name: string, limit: number): Buffer {
  const fd = writeNative().openAt(parent, name, WRITE_OPEN);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > limit || before.size < 0 || before.nlink !== 1)
      throw Error("unsafe surface file");
    const body = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < body.length) {
      const count = readSync(fd, body, offset, body.length - offset, offset);
      if (!count) throw Error("surface file changed");
      offset += count;
    }
    const after = fstatSync(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
      throw Error("surface file changed");
    return body;
  } finally { closeSync(fd); }
}

/** Caller authenticates before reaching this route. Invalid and changed files fail closed. */
export function serveSurface(ctx: Ctx, req: Request, pathname: string, secret: string): Response {
  if (req.method !== "GET" && req.method !== "HEAD")
    return new Response("method not allowed\n", { status: 405, headers: SURFACE_HEADERS });
  const parsedPath = routeParts(pathname);
  if (!parsedPath) return notFound();
  const { prefix, ticket, assets: assetParts } = parsedPath;
  const leaf = assetParts.at(-1)!;
  const type = MIME[leaf.slice(leaf.lastIndexOf(".") + 1).toLowerCase()];
  if (!type) return notFound();
  const selected = pluginRegistry(ctx).surface(ctx, prefix);
  if (!selected) return notFound();
  if (ticket === null) {
    const issued = issueSurfaceTicket(secret, prefix, selected.pluginId);
    return new Response(null, { status: 302, headers: {
      ...SURFACE_HEADERS, Location: `/app/plugins/${prefix}/_s/${issued}/${assetParts.map(encodeURIComponent).join("/")}`,
    } });
  }
  if (!validSurfaceTicket(ctx, pathname, secret)) return notFound();
  const opened: number[] = [];
  try {
    const native = writeNative();
    const root = openSync(ctx.pacerHome, WRITE_DIRECTORY);
    opened.push(root);
    const descend = (name: string) => {
      const fd = native.openAt(opened.at(-1)!, name, WRITE_DIRECTORY);
      opened.push(fd);
    };
    descend("plugins");
    descend(selected.pluginId);
    const rawManifest = readPinned(opened.at(-1)!, "pacer-plugin.json", MAX_MANIFEST_BYTES);
    const parsed = parseManifest(JSON.parse(rawManifest.toString("utf8")));
    if (!parsed.ok || parsed.manifest.id !== selected.pluginId ||
      parsed.manifest.contributes.surface?.prefix !== prefix ||
      parsed.manifest.contributes.surface.dir !== selected.dir) return notFound();
    for (const segment of selected.dir.split("/")) descend(segment);
    for (const segment of assetParts.slice(0, -1)) descend(segment!);
    const body = readPinned(opened.at(-1)!, leaf, MAX_ASSET_BYTES);
    // The selected plugin folder must still be the one rooted below PACER_HOME.
    const named = join(ctx.pacerHome, "plugins", selected.pluginId);
    const fd = opened[2]!;
    const current = fstatSync(fd);
    const resolved = openSync(named, WRITE_DIRECTORY);
    try {
      const linked = fstatSync(resolved);
      if (linked.dev !== current.dev || linked.ino !== current.ino) return notFound();
    } finally { closeSync(resolved); }
    return new Response(req.method === "HEAD" ? null : new Uint8Array(body), { headers: {
      ...SURFACE_HEADERS, "Content-Type": type, "Content-Length": String(body.length),
    } });
  } catch { return notFound(); }
  finally { for (const fd of opened.reverse()) closeSync(fd); }
}
