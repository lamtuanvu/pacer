import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";
import type { TerminalEnv } from "./login-env";

/**
 * The default account's folder (no folder of its own in the strategy): `~/.claude` / `~/.codex`, unless the user's
 * login profile sets CLAUDE_CONFIG_DIR / CODEX_HOME, in which case executor runs use the profile's folder. Only a
 * profile value is recorded; per-folder tools (direnv, mise) never select it. Each run also records the folder it
 * used in its run directory, and transcript lookup for that run reads it from there. Only these folder paths are
 * written; no other environment value is.
 */
export type DefaultKind = "claude" | "codex";
const VARIABLE: Record<DefaultKind, "CLAUDE_CONFIG_DIR" | "CODEX_HOME"> = {claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME"};
const file = (ctx: Pick<Ctx, "pacerHome">) => join(ctx.pacerHome, "state", "default-account-folders.json");
const RUN_FILE = "account-folder.json";
const kindOf = (agent: string): DefaultKind | null => agent === "claude-code" ? "claude" : agent === "codex" ? "codex" : null;

function read(path: string): Partial<Record<DefaultKind, string>> {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return Object.fromEntries((["claude", "codex"] as const).flatMap(kind => typeof data?.[kind] === "string" && data[kind].startsWith("/") ? [[kind, data[kind]]] : []));
  } catch { return {}; }
}

/** SEC-7: a random temp name opened exclusively with mode 0600, then renamed; the temp never outlives the call. */
function writeAtomic(path: string, data: unknown): void {
  const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try { writeSync(fd, JSON.stringify(data)); } finally { closeSync(fd); }
    renameSync(tmp, path);
  } finally { rmSync(tmp, {force: true}); }
}

/** The default account's folder for `kind`: the one the login profile set, else the home default. */
export function defaultAccountFolder(ctx: Pick<Ctx, "pacerHome" | "home">, kind: DefaultKind): string {
  return read(file(ctx))[kind] ?? join(ctx.home, kind === "codex" ? ".codex" : ".claude");
}

/**
 * Records the default account's folder from a run's login environment: the profile's value when the account env
 * (a named account's folder) did not set the variable, else nothing changes. Without a login-shell environment
 * (disabled, failed, or strict work) the record stays as it is. Best effort.
 */
export function recordDefaultFolder(ctx: Pick<Ctx, "pacerHome">, agent: string, account: Record<string, string>, base: TerminalEnv): void {
  const kind = kindOf(agent);
  if (!kind || account[VARIABLE[kind]] !== undefined || base.source !== "login-shell") return;
  const value = base.profileKeys.includes(VARIABLE[kind]) ? base.env[VARIABLE[kind]] : undefined;
  const folders = read(file(ctx)), next = value && value.startsWith("/") ? value : undefined;
  if (folders[kind] === next) return;
  if (next) folders[kind] = next; else delete folders[kind];
  try {
    mkdirSync(join(ctx.pacerHome, "state"), {recursive: true, mode: 0o700});
    writeAtomic(file(ctx), folders);
  } catch { /* readers fall back to the home default */ }
}

/** Records the account folder this run's agent uses, so lookups for the run do not depend on later runs. */
export function recordRunFolder(dir: string, ctx: Pick<Ctx, "home">, agent: string, env: Record<string, string | undefined>): void {
  const kind = kindOf(agent);
  if (!kind) return;
  const value = env[VARIABLE[kind]];
  try { writeAtomic(join(dir, RUN_FILE), {[kind]: value && value.startsWith("/") ? value : join(ctx.home, kind === "codex" ? ".codex" : ".claude")}); }
  catch { /* lookups fall back to the default account's folder */ }
}

/** Fills the account folder variable into a lookup environment that has none: the run's own record, else the default's. */
export function withDefaultFolder(ctx: Pick<Ctx, "pacerHome" | "home">, agent: string, env: Record<string, string | undefined>, runDir?: string): Record<string, string | undefined> {
  const kind = kindOf(agent);
  if (!kind || env[VARIABLE[kind]]) return env;
  const recorded = (runDir ? read(join(runDir, RUN_FILE))[kind] : undefined) ?? read(file(ctx))[kind];
  return recorded ? {...env, [VARIABLE[kind]]: recorded} : env;
}
