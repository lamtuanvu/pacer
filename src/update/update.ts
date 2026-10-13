import { realpathSync } from "node:fs";
import { restartConsoles } from "../console/restart";
import { restartAfterUpdate } from "../service";
import type { Result } from "../commands/types";
import type { Ctx } from "../types";
import { ReleaseError } from "./errors";
import { type FetchFn, fetchBytes, fetchText, normalizeBase, releaseFetch } from "./fetch";
import { type Platform, hostPlatform, latestUrl, parseLatest, parseManifest, parseSha256Sums, releaseUrl, sha256Hex } from "./manifest";
import { type SmokeFn, replaceBinary, runVersion } from "./replace";
import { compareVersions, currentVersion, isVersion } from "./version";

export const UPDATE_USAGE = "usage: pacer update [--check] [--to <version>] [--base <url>] [--no-restart]";

export interface UpdateOptions { check: boolean; noRestart?: boolean; to?: string; base?: string }

export interface UpdateDeps {
  env: Record<string, string | undefined>;
  fetch: FetchFn;
  execPath: string;
  standalone: boolean;
  version: string;
  platform: Platform | null;
  smoke?: SmokeFn;
  restartService?: (path: string) => Promise<boolean | { restarted: boolean; consoles: number; warning?: string }>;
}

export function parseUpdateArgs(args: string[]): UpdateOptions | string {
  const o: UpdateOptions = { check: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--check") {
      o.check = true;
    } else if (a === "--no-restart") {
      o.noRestart = true;
    } else if (a === "--to" || a === "--base") {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) return `pacer update: ${a} needs a value\n${UPDATE_USAGE}`;
      if (a === "--to") o.to = v.replace(/^v/, "");
      else o.base = v;
      i++;
    } else {
      return `pacer update: unknown argument "${a}"\n${UPDATE_USAGE}`;
    }
  }
  if (o.to !== undefined && !isVersion(o.to)) return `pacer update: invalid version "${o.to}" (expected MAJOR.MINOR.PATCH)`;
  return o;
}

export function defaultUpdateDeps(ctx: Ctx): UpdateDeps {
  return {
    env: ctx.env,
    fetch: releaseFetch,
    execPath: process.execPath,
    standalone: Bun.isStandaloneExecutable,
    version: currentVersion(),
    platform: hostPlatform(),
    restartService: async path => {
      let restarted = false, warning: string | undefined;
      try { restarted = await restartAfterUpdate(ctx, path); } catch (e) { warning = `could not restart pacer serve: ${(e as Error).message}`; }
      const warnings = warning ? [warning] : [];
      const consoles = await restartConsoles(ctx, undefined, message => warnings.push(message));
      return { restarted, warning: warnings.length ? warnings.join("; ") : undefined, consoles };
    },
  };
}

const ok = (out: string): Result => ({ code: 0, out, err: "" });
const fail = (code: number, msg: string): Result => ({ code, out: "", err: `pacer update: ${msg}` });

function installHint(d: UpdateDeps): string | undefined {
  if (d.env.PACER_INSTALL_METHOD === "npm") return "pacer was installed with npm; update with: npm install -g @lamtuanvu/pacer@latest";
  let real: string;
  try { real = realpathSync(d.execPath); } catch { return undefined; }
  const prefixes = [d.env.HOMEBREW_PREFIX, d.env.HOMEBREW_CELLAR].filter((p): p is string => !!p);
  if (real.includes("/Cellar/pacer/") || prefixes.some(p => {
    try { p = realpathSync(p); } catch { /* A configured prefix may not exist on this host. */ }
    return real.startsWith(`${p.replace(/\/+$/, "")}/`);
  })) {
    return "pacer was installed with Homebrew; update with: brew upgrade pacer";
  }
  return undefined;
}

export async function runUpdate(o: UpdateOptions, d: UpdateDeps): Promise<Result> {
  const hint = installHint(d);
  if (hint && !o.check) return fail(2, hint);
  const checked = (out: string): Result => ok(out + (hint ? `\n${hint}` : ""));
  const raw = o.base ?? (d.env.PACER_RELEASE_BASE || undefined);
  let base: string | undefined;
  try {
    base = raw === undefined ? undefined : normalizeBase(raw);
  } catch (e) {
    return fail(2, (e as Error).message);
  }
  if (!o.check && !d.standalone) {
    return fail(2, "this pacer runs from source (bun src/cli.ts), not from an installed binary, so there is nothing to replace. Update the checkout instead (git pull, then bun run build), or install a release with install.sh");
  }
  const plat = d.platform;
  if (!plat) return fail(2, "this OS/CPU is not supported (release builds exist for darwin and linux on arm64 and x64)");
  try {
    const target = o.to ?? parseLatest(JSON.parse(await fetchText(d.fetch, latestUrl(base))));
    const cmp = compareVersions(target, d.version);
    if (!o.to && cmp <= 0) return checked(cmp === 0 ? `pacer ${d.version} is up to date` : `pacer ${d.version} is up to date (latest release: ${target})`);
    if (o.to && cmp === 0) return checked(`pacer ${d.version} is already installed`);
    const manifest = parseManifest(JSON.parse(await fetchText(d.fetch, releaseUrl(base, target, "manifest.json"))));
    if (manifest.version !== target) throw new ReleaseError(`manifest.json is for ${manifest.version}, not ${target}`);
    const asset = manifest.assets.find((a) => a.os === plat.os && a.arch === plat.arch);
    if (!asset) throw new ReleaseError(`release ${target} has no build for ${plat.os}-${plat.arch}`);
    if (o.check) {
      return checked(cmp > 0
        ? `update available: ${d.version} -> ${target}${hint ? "" : `\nrun: pacer update${o.to ? ` --to ${target}` : ""}`}`
        : `${target} is older than the installed ${d.version}${hint ? "" : `; run pacer update --to ${target} to downgrade`}`);
    }
    const sums = parseSha256Sums(await fetchText(d.fetch, releaseUrl(base, target, "SHA256SUMS")));
    if (sums.get(asset.file) !== asset.sha256) throw new ReleaseError(`SHA256SUMS and manifest.json disagree about ${asset.file}; refusing to install`);
    const bytes = await fetchBytes(d.fetch, releaseUrl(base, target, asset.file), asset.size);
    const got = sha256Hex(bytes);
    if (got !== asset.sha256 || bytes.length !== asset.size) {
      throw new ReleaseError(`checksum mismatch for ${asset.file} (expected ${asset.sha256}, got ${got}); nothing was changed`);
    }
    const r = await replaceBinary(d.execPath, bytes, target, d.smoke ?? runVersion);
    let serviceNote = "";
    if (!o.noRestart && d.restartService) {
      try { const result = await d.restartService(r.path);
        if (typeof result === "boolean") { if (result) serviceNote = "\nrestarted pacer serve"; }
        else serviceNote = (result.restarted ? "\nrestarted pacer serve" : "") + `\nrestarted ${result.consoles} pacer consoles` + (result.warning ? `\nWARNING: ${result.warning}` : "");
      }
      catch (e) { serviceNote = `\nWARNING: could not restart pacer serve: ${(e as Error).message}`; }
    }
    return ok([`updated pacer ${d.version} -> ${target}`, `binary: ${r.path}`, `previous binary: ${r.backup}`].join("\n") + serviceNote);
  } catch (e) {
    if (e instanceof SyntaxError) return fail(1, `release metadata is not valid JSON (${e.message})`);
    return fail(1, (e as Error).message);
  }
}
