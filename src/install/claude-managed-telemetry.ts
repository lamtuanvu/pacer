import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import type { AccountCfg } from "../config/accounts";
import type { Ctx } from "../types";
import { isObj } from "../util";
import { shellCommand } from "./fsx";
import { parseJsonc } from "./jsonc";

/** Add account-scoped passive quota capture without replacing a user's status line. */
export function ensureManagedClaudeStatusLine(ctx: Ctx, account: AccountCfg): boolean {
  if (account.kind !== "claude" || account.source !== "pacer") return false;
  const folder = account.home ? resolve(account.home.replace(/^~(?=\/|$)/, ctx.home)) : null;
  const stable = (value: string | null | undefined): value is string => !!value && isAbsolute(value)
    && !/(?:\/\.work\/|\/worktrees\/|\/\.worktrees\/|\/private\/tmp\/|\/var\/folders\/)/.test(resolve(value));
  const binary = [ctx.env.PACER_BIN, ctx.which("pacer")].find(stable);
  if (!folder || !binary || !existsSync(folder)) return false;
  const path = join(folder, "settings.json");
  if (existsSync(path) && !lstatSync(path).isFile()) return false;
  let settings: Record<string, unknown> = {};
  if (existsSync(path)) {
    try { settings = parseJsonc(readFileSync(path, "utf8")); }
    catch { return false; }
  }
  if (!isObj(settings) || settings.statusLine !== undefined) return false;
  const next = {...settings, statusLine: {type: "command", command: `${shellCommand([binary])} statusline`}};
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, {flag: "wx", mode: 0o600});
    renameSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return true;
}
