import { readFileSync } from "node:fs";
import { assetFile, hostPlatform, parseManifest, releaseUrl, sha256Hex, type Platform } from "../update/manifest";
import { fetchBytes, fetchText, releaseFetch } from "../update/fetch";
import { currentVersion } from "../update/version";
import type { HostCfg } from "../config/hosts";
import type { Ctx } from "../types";
import { SCRIPTS } from "./scripts";
import { runRemote } from "./ssh";

export function remotePlatform(os: string, arch: string): Platform {
  const platform = hostPlatform(os.toLowerCase(), ({x86_64:"x64",aarch64:"arm64"} as Record<string,string>)[arch] ?? arch);
  if (!platform) throw Error(`unsupported remote platform ${os}/${arch}`);
  return platform;
}

/** A local release file may be supplied by callers packaging their own release. */
export async function ensureRemoteBinary(ctx: Ctx, host: HostCfg, options: {binary?:string} = {}): Promise<string> {
  const probe = await runRemote(ctx,host,SCRIPTS.PROBE,[]);
  if (probe.code) throw Error(probe.stderr || "remote platform probe failed");
  const facts = Object.fromEntries(probe.stdout.trim().split("\n").map(line=>{const i=line.indexOf("=");return [line.slice(0,i),line.slice(i+1)];}));
  const platform = remotePlatform(facts.os,facts.arch);
  if (platform.os === "linux") {
    const libc = /^(\d+)\.(\d+)/.exec(facts.glibc ?? "");
    if (!libc || +libc[1]<2 || (+libc[1]===2 && +libc[2]<17)) throw Error("remote pacer binary requires glibc >= 2.17");
  }
  let bytes: Uint8Array;
  if (options.binary) bytes=readFileSync(options.binary);
  else if (platform.os === process.platform && platform.arch === process.arch && !/(^|\/)bun(?:\.exe)?$/.test(process.execPath)) bytes=readFileSync(process.execPath);
  else {
    const version=currentVersion();
    const manifest=parseManifest(JSON.parse(await fetchText(releaseFetch,releaseUrl(undefined,version,"manifest.json"))));
    if (manifest.version!==version) throw Error("remote release version mismatch");
    const asset=manifest.assets.find(a=>a.file===assetFile(platform));
    if (!asset) throw Error("remote release binary unavailable");
    bytes=await fetchBytes(releaseFetch,releaseUrl(undefined,version,asset.file),asset.size);
    if (bytes.length!==asset.size || sha256Hex(bytes)!==asset.sha256) throw Error("remote release hash mismatch");
  }
  const hash=sha256Hex(bytes);
  const existing=await runRemote(ctx,host,SCRIPTS.BINARY,[hash,"check"]);
  if (existing.code===0 && existing.stdout.trim()) return existing.stdout.trim();
  const uploaded=await runRemote(ctx,host,SCRIPTS.BINARY,[hash,"upload"],{stdin:Buffer.from(bytes).toString("base64"),timeoutMs:300_000});
  if (uploaded.code || !uploaded.stdout.trim()) throw Error(uploaded.stderr || "remote binary hash verification failed");
  return uploaded.stdout.trim();
}
