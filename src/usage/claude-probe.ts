import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AccountCfg } from "../config/accounts";
import { defaultAccountFolder } from "../exec/account-folder";
import { execProcess, executorEnv, type ExecSpec, type ExecResult } from "../exec/process";
import { accountFolder } from "../install/role";
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import { captureClaudeStreamUsage } from "./claude";

/** Only native subscription auth may select billing for this probe. Keep the harness
 * coordinates and runtime essentials, never provider credentials, profiles, loaders
 * or routing overrides. Normal endpoint executor environments remain unchanged. */
function subscriptionProbeEnv(ctx: Ctx, folder: string): Record<string, string | undefined> {
  const keys = ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "USER", "LOGNAME", "SHELL",
    "SystemRoot", "WINDIR", "PATHEXT", "PACER_HOME", "PACER_PORT", "PACER_BIN", "PACER_BACKEND",
    "PACER_NO_UPDATE_CHECK", "PACER_ORCA_USER_DATA"];
  const base = Object.fromEntries(keys.filter(key => ctx.env[key] !== undefined).map(key => [key, ctx.env[key]]));
  return executorEnv(base, {HOME: ctx.home, CLAUDE_CONFIG_DIR: folder});
}

/** Explicitly consented, bounded turn. Claude owns authentication; pacer only captures public telemetry. */
export async function probeClaudeUsage(ctx: Ctx, account: AccountCfg,
  spawn: (spec: ExecSpec) => Promise<ExecResult> = execProcess): Promise<void> {
  const folder = account.source === "default" ? defaultAccountFolder(ctx, "claude") : accountFolder(ctx, account);
  let available = false;
  try { available = !!folder && statSync(folder).isDirectory(); } catch { /* No fallback to another native login. */ }
  if (!folder || !available) throw new CoreError("not_allowed", "Account folder unavailable. Reconnect this account and try again.");
  const binary = ctx.which("claude");
  if (!binary) throw new CoreError("not_allowed", "Claude Code is not installed. Install it and sign in to this account.");
  const root = join(ctx.pacerHome, "scratch");
  mkdirSync(root, {recursive: true, mode: 0o700});
  const cwd = mkdtempSync(join(root, "usage-"));
  try {
    const result = await spawn({argv: [binary, "-p", "--output-format", "stream-json", "--verbose", "--max-turns", "1", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "", "--no-session-persistence", "Reply with OK only."], cwd,
      env: subscriptionProbeEnv(ctx, folder), timeoutMs: 60000, maxStdoutBytes: 2 * 1024 * 1024});
    if (result.timedOut || result.code !== 0 || result.stdoutOverflow) throw new CoreError("not_allowed", "Claude Code usage check failed. Check this account’s sign-in and subscription, then try again.");
    if (!captureClaudeStreamUsage({...ctx, now: Math.max(ctx.now, Date.now()/1000)}, account, result.stdout)) {
      throw new CoreError("not_allowed", "No new usage observation from Claude Code. The previous reading is unchanged. Update Claude Code and check this account’s subscription.");
    }
  } finally { rmSync(cwd, {recursive: true, force: true}); }
}
