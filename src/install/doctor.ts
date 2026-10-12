import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadStrategy, MissingStrategyError, type Strategy } from "../config/strategy";
import { binaryFor, computeStatus, type Status } from "../engine/status";
import { readJson } from "../fsutil";
import type { ActivityProfile } from "../pace/activity";
import { isCalendar } from "../pace/clock";
import type { Ctx } from "../types";
import { isObj } from "../util";
import { readText, sha256 } from "./fsx";
import { piecesPresent, readManifest, type FileChange } from "./manifest";

export interface Check {
  name: string;
  level: "ok" | "warn" | "fail" | "info";
  detail: string;
  fix?: string;
}

export async function runDoctor(ctx: Ctx, deps: { status?: (ctx: Ctx) => Promise<Status> } = {}): Promise<Check[]> {
  const checks: Check[] = [];
  let strategy: Strategy | undefined;
  try {
    strategy = loadStrategy(ctx);
    checks.push({ name: "Strategy", level: "ok", detail: strategy.name });
  } catch (e) {
    checks.push({ name: "Strategy", level: "fail", detail: errorText(e),
      ...(e instanceof MissingStrategyError ? { fix: "pacer init" } : {}) });
  }

  if (strategy) {
    const logins = new Set<string>();
    for (const cfg of Object.values(strategy.providers)) {
      const bin = binaryFor(cfg);
      const installed = ctx.which(bin) !== null;
      checks.push({ name: `Binary ${cfg.id}`, level: installed ? "ok" : "fail",
        detail: installed ? `${bin} installed` : `${bin} missing`,
        ...(!installed ? { fix: `install ${bin} or remove providers.${cfg.id}` } : {}) });
      logins.add(cfg.via === "opencode" ? "opencode" : cfg.id);
      if (cfg.quotaSource === "arkcli") logins.add("arkcli");
    }
    // OpenCode may be the planner without being a provider itself.
    logins.add(strategy.planner);
    for (const id of logins) checks.push(loginCheck(ctx, id));

    try {
      const status = deps.status ? await deps.status(ctx) : await computeStatus(ctx, strategy);
      for (const cfg of Object.values(strategy.providers)) {
        const provider = status.providers.find(p => p.id === cfg.id);
        const detail = provider?.error || (provider?.stale ? "stale usage" : provider?.verdict ?? "UNKNOWN");
        const warn = !provider || !!provider.error || provider.stale || provider.verdict === "UNKNOWN";
        checks.push({ name: `Usage ${cfg.id}`, level: warn ? "warn" : "ok", detail,
          ...(cfg.id === "claude-code" && provider?.error?.startsWith("no Claude rate-limit data yet")
            ? { fix: "pacer install claude-code, then use Claude Code once" } : {}) });
      }
    } catch (e) {
      for (const id of Object.keys(strategy.providers)) {
        checks.push({ name: `Usage ${id}`, level: "warn", detail: errorText(e) });
      }
    }
  }

  if (ctx.which("orca") === null) {
    checks.push({ name: "Orca", level: "info", detail: "not installed" });
  } else {
    let reachable = false;
    try {
      const result = await ctx.run(["orca", "status", "--json"], 5000);
      reachable = result.code === 0 && JSON.parse(result.stdout)?.result?.runtime?.reachable === true;
    } catch { /* An unavailable runtime uses the direct backend. */ }
    checks.push({ name: "Orca", level: reachable ? "ok" : "warn",
      detail: reachable ? "runtime reachable" : "tasks use the direct backend" });
  }

  const profile = readJson<ActivityProfile>(join(ctx.pacerHome, "activity.json"));
  const usableProfile = profile && Array.isArray(profile.active) && Array.isArray(profile.bins)
    && profile.bins.length === 168 && !isCalendar(profile);
  checks.push({ name: "Activity", level: "info",
    detail: usableProfile ? `learned from ${profile.days} days` : "calendar pace" });

  try {
    const records = Object.values(readManifest(ctx).planners);
    if (!records.length) checks.push({ name: "Installs", level: "warn", detail: "no install records" });
    for (const record of records) {
      const broken = record.files.filter(file => !fileIntact(file));
      checks.push({ name: `Install ${record.planner}`, level: broken.length ? "warn" : "ok",
        detail: broken.length ? `missing or changed: ${broken.map(file => file.path).join(", ")}` : "installed files intact",
        ...(broken.length ? { fix: `pacer install ${record.planner}` } : {}) });
    }
  } catch (e) {
    checks.push({ name: "Installs", level: "warn", detail: errorText(e) });
  }
  if (existsSync(join(ctx.home, ".claude", "scripts", "budget", "subagent_guard.py"))) {
    checks.push({ name: "Legacy guard", level: "warn", detail: "legacy subagent_guard.py present",
      fix: "pacer install claude-code migrates it" });
  }
  return checks;
}

export function renderDoctor(checks: Check[]): string {
  return checks.map(check => `[${check.level === "fail" ? "FAIL" : check.level}] ${check.name}: ${check.detail}\n`
    + (check.fix ? `  fix: ${check.fix}\n` : "")).join("");
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function loginCheck(ctx: Ctx, id: string): Check {
  let loggedIn: boolean;
  let fix: string;
  switch (id) {
    case "claude-code": {
      const account = readJson<unknown>(join(ctx.home, ".claude.json"));
      loggedIn = !!ctx.env.ANTHROPIC_API_KEY || (isObj(account) && Object.hasOwn(account, "oauthAccount"));
      fix = "run claude and log in";
      break;
    }
    case "codex":
      loggedIn = existsSync(join(ctx.home, ".codex", "auth.json"));
      fix = "codex login";
      break;
    case "cursor": {
      const config = readJson<unknown>(join(ctx.home, ".cursor", "cli-config.json"));
      loggedIn = isObj(config) && isObj(config.authInfo);
      fix = "cursor-agent login";
      break;
    }
    case "opencode":
      loggedIn = existsSync(join(ctx.home, ".local", "share", "opencode", "auth.json"));
      fix = "opencode auth login";
      break;
    default:
      return { name: `Login ${id}`, level: "info", detail: "login not cheaply checkable" };
  }
  return { name: `Login ${id}`, level: loggedIn ? "ok" : "warn",
    detail: loggedIn ? "login indicator present" : "no login indicator", ...(!loggedIn ? { fix } : {}) };
}

function fileIntact(file: FileChange): boolean {
  if (file.action === "moved") return !existsSync(file.path) && !!file.backup && existsSync(file.backup);
  const text = readText(file.path);
  return text !== null && ((!!file.afterHash && sha256(text) === file.afterHash)
    || (file.undo.length > 0 && piecesPresent(text, file.undo)));
}
