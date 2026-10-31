import { readFileSync } from "node:fs";
import { assetFile, hostPlatform, parseManifest, releaseUrl, sha256Hex, type Platform } from "../update/manifest";
import { fetchBytes, fetchText, releaseFetch } from "../update/fetch";
import { currentVersion } from "../update/version";
import type { HostCfg } from "../config/hosts";
import type { Ctx } from "../types";
import { issueConfiguredHostRuntimeProbe } from "../plugins/host-runtime-probe-issuer";
import { issueConfiguredHostBinaryCheck } from "../plugins/host-binary-check-issuer";
import { issueConfiguredHostBinaryUpload } from "../plugins/host-binary-upload-issuer";
import { pluginRegistry } from "../plugins";

export function remotePlatform(os: string, arch: string): Platform {
  const platform = hostPlatform(os.toLowerCase(), ({x86_64:"x64",aarch64:"arm64"} as Record<string,string>)[arch] ?? arch);
  if (!platform) throw Error(`unsupported remote platform ${os}/${arch}`);
  return platform;
}

/** A local release file may be supplied by callers packaging their own release. */
export async function ensureRemoteBinary(ctx: Ctx, host: HostCfg, remoteDir: string,
  localDir: string, options: {binary?:string} = {}): Promise<string> {
  const probeGrant = issueConfiguredHostRuntimeProbe(ctx, host.alias, remoteDir, localDir);
  const probe = await pluginRegistry(ctx).probeConfiguredHostRuntime(ctx, probeGrant);
  if (probe.code || probe.timedOut) throw Error(probe.stderr || "remote platform probe failed");
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
  const grant=issueConfiguredHostBinaryCheck(ctx,host.alias,remoteDir,localDir,hash);
  const existing=await pluginRegistry(ctx).checkConfiguredHostBinary(ctx,grant);
  if (existing.timedOut) throw Error("remote binary check timed out");
  if (existing.code===0) {
    const expected=`${facts.home}/.pacer-remote/bin/${hash}/pacer`;
    if (!facts.home?.startsWith("/") || /[\u0000-\u001f\u007f]/.test(facts.home) ||
      existing.stdout.trim()!==expected) throw Error("remote binary check returned an invalid path");
    return expected;
  }
  const uploadGrant=issueConfiguredHostBinaryUpload(ctx,host.alias,remoteDir,localDir,bytes);
  const uploaded=await pluginRegistry(ctx).uploadConfiguredHostBinary(ctx,uploadGrant);
  if (uploaded.code || uploaded.timedOut) throw Error(uploaded.stderr || "remote binary hash verification failed");
  const expected=`${facts.home}/.pacer-remote/bin/${hash}/pacer`;
  if (!facts.home?.startsWith("/") || /[\u0000-\u001f\u007f]/.test(facts.home) ||
    uploaded.stdout.trim()!==expected) throw Error("remote binary upload returned an invalid path");
  return expected;
}
