import { realpathSync } from "node:fs";
import { isBundledExecutable } from "./desktop/identity";
import { refreshIntegrations, refreshStrategy } from "../commands/update-refresh";
import { restartAfterUpdate } from "../service";
import type { Result } from "../commands/types";
import type { Ctx } from "../types";
import { ReleaseError } from "./errors";
import { type FetchFn, fetchBytes, fetchText, normalizeBase, releaseFetch } from "./fetch";
import { type Platform, hostPlatform, latestUrl, parseLatest, parseManifest, parseSha256Sums, releaseUrl, sha256Hex } from "./manifest";
import { type SmokeFn, replaceBinary, runVersion } from "./replace";
import { compareVersions, currentVersion, isVersion } from "./version";

export const UPDATE_USAGE = "usage: pacer update [--check [--json]] [--to <version>] [--base <url>] [--no-restart] [--no-reinstall]";

export interface UpdateOptions { check: boolean; json?: boolean; noRestart?: boolean; noReinstall?: boolean; to?: string; base?: string }

export interface UpdateDeps {
  progress?: (name: "Download" | "Verify" | "Replace" | "Refresh integrations" | "Restart", state: "running" | "passed" | "skipped", detail?: string) => void;
  env: Record<string, string | undefined>;
  fetch: FetchFn;
  execPath: string;
  standalone: boolean;
  version: string;
  platform: Platform | null;
  smoke?: SmokeFn;
  refreshIntegrations?: (path: string) => Promise<string[]>;
  migrateStrategy?: () => string[];
  restartService?: (path: string) => Promise<boolean | { restarted: boolean; warning?: string }>;
}

export function parseUpdateArgs(args: string[]): UpdateOptions | string {
  const o: UpdateOptions = { check: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") { o.json = true;
    } else if (a === "--check") {
      o.check = true;
    } else if (a === "--no-restart") {
      o.noRestart = true;
    } else if (a === "--no-reinstall") {
      o.noReinstall = true;
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
  if (o.json && !o.check) return `pacer update: --json requires --check\n${UPDATE_USAGE}`;
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
    refreshIntegrations: path => refreshIntegrations(ctx, path),
    migrateStrategy: () => refreshStrategy(ctx),
    restartService: async path => {
      let restarted = false, warning: string | undefined;
      try { restarted = await restartAfterUpdate(ctx, path); } catch (e) { warning = `could not restart pacer serve: ${(e as Error).message}`; }
      const warnings = warning ? [warning] : [];
      return { restarted, warning: warnings.length ? warnings.join("; ") : undefined };
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
  // The desktop app updates its own bundled CLI with the complete app.
  if (isBundledExecutable(d.execPath) || /\.app\/Contents\/(MacOS|Resources)\/pacer$/.test(real)) {
    return "this executable belongs to the desktop app; use Settings → Updates in the desktop to update the complete app";
  }
  return undefined;
}

export async function runUpdate(o: UpdateOptions, d: UpdateDeps): Promise<Result> {
  const migrationNote = () => {
    if (o.check || !d.migrateStrategy) return "";
    const lines = d.migrateStrategy(); return lines.length ? `\n${lines.join("\n")}` : "";
  };
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
    if(!o.check) d.progress?.("Download","running");
    const target = o.to ?? parseLatest(JSON.parse(await fetchText(d.fetch, latestUrl(base))));
    const cmp = compareVersions(target, d.version);
    if (!o.check && !o.to && cmp<=0) {
      d.progress?.("Download","passed");
      for(const name of ["Verify","Replace","Refresh integrations","Restart"] as const) d.progress?.(name,"skipped","Already up to date");
    }
    if (!o.to && cmp <= 0) return checked((cmp === 0 ? `pacer ${d.version} is up to date` : `pacer ${d.version} is up to date (latest release: ${target})`) + migrationNote());
    if (o.check && o.to && cmp === 0) return checked(`pacer ${d.version} is already installed`);
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
    d.progress?.("Download","passed");
    d.progress?.("Verify","running");
    const got = sha256Hex(bytes);
    if (got !== asset.sha256 || bytes.length !== asset.size) {
      throw new ReleaseError(`checksum mismatch for ${asset.file} (expected ${asset.sha256}, got ${got}); nothing was changed`);
    }
    d.progress?.("Verify","passed");
    d.progress?.("Replace","running");
    const r = await replaceBinary(d.execPath, bytes, target, d.smoke ?? runVersion);
    d.progress?.("Replace","passed");
    d.progress?.("Refresh integrations","running");
    let refreshNote = "";
    if (!o.noReinstall && d.refreshIntegrations) {
      try {
        const lines = await d.refreshIntegrations(r.path);
        if (lines.length) refreshNote = "\n" + lines.join("\n");
      } catch (e) { refreshNote = `\nWARNING: could not refresh integrations: ${(e as Error).message}`; }
    }
    refreshNote += migrationNote();
    d.progress?.("Refresh integrations",o.noReinstall ? "skipped" : "passed");
    let serviceNote = "";
    d.progress?.("Restart",o.noRestart || !d.restartService ? "skipped" : "running",target);
    if (!o.noRestart && d.restartService) {
      try { const result = await d.restartService(r.path);
        if(!(typeof result === "boolean" ? result : result.restarted)) d.progress?.("Restart","skipped","Service was not restarted");
        if (typeof result === "boolean") { if (result) serviceNote = "\nrestarted pacer serve"; }
        else serviceNote = (result.restarted ? "\nrestarted pacer serve" : "") + (result.warning ? `\nWARNING: ${result.warning}` : "");
      }
      catch (e) { d.progress?.("Restart","skipped",String(e)); serviceNote = `\nWARNING: could not restart pacer serve: ${(e as Error).message}`; }
    }
    return ok([`updated pacer ${d.version} -> ${target}`, `binary: ${r.path}`, `previous binary: ${r.backup}`].join("\n") + refreshNote + serviceNote);
  } catch (e) {
    if (e instanceof SyntaxError) return fail(1, `release metadata is not valid JSON (${e.message})`);
    return fail(1, (e as Error).message);
  }
}
