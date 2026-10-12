import { ReleaseError } from "./errors";
import { isVersion } from "./version";

export type ReleaseOs = "darwin" | "linux";
export type ReleaseArch = "arm64" | "x64";
export interface Platform { os: ReleaseOs; arch: ReleaseArch }
export interface Target extends Platform { bunTarget: string }
export interface ReleaseAsset extends Platform { file: string; sha256: string; size: number }
export interface Manifest { version: string; assets: ReleaseAsset[] }

/** Release platforms, in manifest order. Names verified against Bun 1.4.2 Bun.Build.CompileTarget. */
export const TARGETS: Target[] = [
  { os: "darwin", arch: "arm64", bunTarget: "bun-darwin-arm64" },
  { os: "darwin", arch: "x64", bunTarget: "bun-darwin-x64" },
  { os: "linux", arch: "x64", bunTarget: "bun-linux-x64" },
  { os: "linux", arch: "arm64", bunTarget: "bun-linux-arm64" },
];

export function assetFile(p: Platform): string {
  return `pacer-${p.os}-${p.arch}`;
}

/** Maps Node-style platform/arch names to a release platform; null when there is no build for it. */
export function hostPlatform(platform: string = process.platform, arch: string = process.arch): Platform | null {
  const os = platform === "darwin" || platform === "linux" ? platform : null;
  const a = arch === "arm64" || arch === "x64" ? arch : null;
  return os && a ? { os, arch: a } : null;
}

export function hostTarget(): Target | null {
  const h = hostPlatform();
  return TARGETS.find((t) => h !== null && t.os === h.os && t.arch === h.arch) ?? null;
}

export function sha256Hex(data: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

export function formatSha256Sums(assets: { file: string; sha256: string }[]): string {
  return assets.map((a) => `${a.sha256}  ${a.file}\n`).join("");
}

/** file -> lowercase sha256, from `sha256sum` output ("<hex>  <file>" or "<hex> *<file>"); other lines are ignored. */
export function parseSha256Sums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if (m) out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

export function parseLatest(raw: unknown): string {
  const v = typeof raw === "object" && raw !== null ? (raw as { version?: unknown }).version : undefined;
  const s = typeof v === "string" ? v.replace(/^v/, "") : "";
  if (!isVersion(s)) throw new ReleaseError(`latest.json has no valid "version" (got ${JSON.stringify(v ?? null)})`);
  return s;
}

export function parseManifest(raw: unknown): Manifest {
  const p: string[] = [];
  const o = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const version = typeof o.version === "string" && isVersion(o.version) ? o.version : null;
  if (!version) p.push(`version must be MAJOR.MINOR.PATCH (got ${JSON.stringify(o.version ?? null)})`);
  const assets: ReleaseAsset[] = [];
  if (!Array.isArray(o.assets) || o.assets.length === 0) {
    p.push("assets must be a non-empty list");
  } else {
    o.assets.forEach((a: unknown, i: number) => {
      const x = (typeof a === "object" && a !== null ? a : {}) as Record<string, unknown>;
      const plat = hostPlatform(String(x.os), String(x.arch));
      if (!plat) {
        p.push(`assets[${i}]: unsupported os/arch ${String(x.os)}-${String(x.arch)}`);
        return;
      }
      const file = assetFile(plat);
      const shaOk = typeof x.sha256 === "string" && /^[0-9a-f]{64}$/.test(x.sha256);
      const sizeOk = typeof x.size === "number" && Number.isInteger(x.size) && x.size > 0;
      if (x.file !== file) p.push(`assets[${i}]: file must be "${file}" (got ${JSON.stringify(x.file ?? null)})`);
      if (!shaOk) p.push(`assets[${i}]: sha256 must be 64 lowercase hex characters`);
      if (!sizeOk) p.push(`assets[${i}]: size must be a positive integer`);
      if (x.file === file && shaOk && sizeOk) assets.push({ os: plat.os, arch: plat.arch, file, sha256: x.sha256 as string, size: x.size as number });
    });
  }
  if (p.length) throw new ReleaseError(`invalid manifest.json: ${p.join("; ")}`);
  return { version: version as string, assets };
}

export function latestUrl(base: string): string {
  return `${base}/latest.json`;
}

export function releaseUrl(base: string, version: string, file: string): string {
  return `${base}/${version}/${file}`;
}
