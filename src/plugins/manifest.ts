import { readFileSync } from "node:fs";
import { compareVersions, isVersion } from "../update/version";
import { type PluginManifest, manifestSchema } from "./protocol";

function fill(parts: string): string {
  const [a = "0", b = "0", c = "0"] = parts.split(".");
  return `${a}.${b}.${c}`;
}

/** `*`, `X.Y.Z`, `^X[.Y[.Z]]`, `~X.Y[.Z]` or `>=X.Y.Z`. Anything else never matches. */
export function hostRangeAccepts(range: string, version: string): boolean {
  if (!isVersion(version)) return false;
  if (range === "*") return true;
  const m = /^(\^|~|>=)?(\d+(?:\.\d+){0,2})$/.exec(range);
  if (!m) return false;
  const op = m[1] ?? "=", floor = fill(m[2]);
  const atLeast = compareVersions(version, floor) >= 0;
  const [vMajor, vMinor] = version.split(".").map(Number);
  const [rMajor, rMinor] = floor.split(".").map(Number);
  switch (op) {
    case "=": return compareVersions(version, floor) === 0;
    case ">=": return atLeast;
    case "^": return atLeast && vMajor === rMajor;
    case "~": return atLeast && vMajor === rMajor && vMinor === rMinor;
    default: return false;
  }
}

export type ManifestResult = { ok: true; manifest: PluginManifest } | { ok: false; error: string };

export function parseManifest(raw: unknown): ManifestResult {
  const parsed = manifestSchema.safeParse(raw);
  if (parsed.success) return { ok: true, manifest: parsed.data };
  return { ok: false, error: parsed.error.issues.map(i => `${i.path.join(".") || "manifest"}: ${i.message}`).join("; ") };
}

export function readManifestFile(path: string): ManifestResult {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (e) { return { ok: false, error: `cannot read ${path}: ${(e as Error).message}` }; }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { return { ok: false, error: `invalid JSON in ${path}: ${(e as Error).message}` }; }
  return parseManifest(raw);
}
