import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";

/**
 * The default account's folder (no folder of its own in the strategy): `~/.claude` / `~/.codex`, unless the user's
 * login profile sets CLAUDE_CONFIG_DIR / CODEX_HOME, in which case executor runs use the profile's folder. The last
 * local run records the folder it used so that trust, transcript lookup, usage readers and the enforcement canary
 * resolve the same one. Only these two folder paths are written; no other environment value is.
 */
export type DefaultKind = "claude" | "codex";
const VARIABLE: Record<DefaultKind, "CLAUDE_CONFIG_DIR" | "CODEX_HOME"> = {claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME"};
const file = (ctx: Pick<Ctx, "pacerHome">) => join(ctx.pacerHome, "state", "default-account-folders.json");

function read(ctx: Pick<Ctx, "pacerHome">): Partial<Record<DefaultKind, string>> {
  try {
    const data = JSON.parse(readFileSync(file(ctx), "utf8"));
    return Object.fromEntries((["claude", "codex"] as const).flatMap(kind => typeof data?.[kind] === "string" && data[kind].startsWith("/") ? [[kind, data[kind]]] : []));
  } catch { return {}; }
}

/** The default account's folder for `kind`: the one the profile set for the last run, else the home default. */
export function defaultAccountFolder(ctx: Pick<Ctx, "pacerHome" | "home">, kind: DefaultKind): string {
  return read(ctx)[kind] ?? join(ctx.home, kind === "codex" ? ".codex" : ".claude");
}

/**
 * Records the default account's folder after a run's environment is resolved: the profile's value when the account
 * env (a named account's folder) did not set the variable, else nothing changes. Best effort.
 */
export function recordDefaultFolder(ctx: Pick<Ctx, "pacerHome">, agent: string, account: Record<string, string>, env: Record<string, string | undefined>): void {
  const kind: DefaultKind | null = agent === "claude-code" ? "claude" : agent === "codex" ? "codex" : null;
  if (!kind || account[VARIABLE[kind]] !== undefined) return;
  const value = env[VARIABLE[kind]];
  const folders = read(ctx), next = value && value.startsWith("/") ? value : undefined;
  if (folders[kind] === next) return;
  if (next) folders[kind] = next; else delete folders[kind];
  try {
    mkdirSync(join(ctx.pacerHome, "state"), {recursive: true, mode: 0o700});
    const tmp = `${file(ctx)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(folders), {mode: 0o600});
    renameSync(tmp, file(ctx));
  } catch { /* readers fall back to the home default */ }
}

/** Fills the default account's folder variable into a lookup environment that has none. */
export function withDefaultFolder(ctx: Pick<Ctx, "pacerHome" | "home">, agent: string, env: Record<string, string | undefined>): Record<string, string | undefined> {
  const kind: DefaultKind | null = agent === "claude-code" ? "claude" : agent === "codex" ? "codex" : null;
  if (!kind || env[VARIABLE[kind]]) return env;
  const recorded = read(ctx)[kind];
  return recorded ? {...env, [VARIABLE[kind]]: recorded} : env;
}
