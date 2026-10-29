import { isObj } from "../util";
import type { Ctx } from "../types";
import { installSkill } from "./skill";
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { blockText, hasBlock, upsertBlock } from "./blocks";
import { readText, shellCommand } from "./fsx";
import { removeHooks, upsertHooks } from "./hookjson";
import { parseJsonc } from "./jsonc";
import type { UndoOp } from "./manifest";
import { policyText } from "./policy";
import { InstallError, type Txn } from "./txn";

export function claudeLegacyFiles(home: string, folder?: string): string[] {
  const root = folder ?? join(home, ".claude");
  const delegation = join(root, "agents/delegation");
  return [
    ...["budget_status.py", "subagent_guard.py", "budget-status"].map(name => join(root, "scripts/budget", name)),
    join(root, "rules/model-delegation.md"),
    ...(existsSync(delegation) ? readdirSync(delegation).filter(name => name.endsWith(".md")).sort().map(name => join(delegation, name)) : []),
  ];
}

export function resolveScript(command: string, home: string): string | null {
  if (!command || /\s/.test(command)) return null;
  const path = command.replace(/^~(?=\/)/, home).replace(/^\$HOME(?=\/)/, home);
  return isAbsolute(path) && existsSync(path) ? path : null;
}

/** Legacy blocks end at the next column-zero fi, leaving surrounding shell intact. */
function legacyBlock(text: string, anchor: RegExp): { start: number; end: number } | null {
  const match = anchor.exec(text);
  if (!match) return null;
  const rest = text.slice(match.index + match[0].length);
  const end = /^fi[\t ]*(?:\r?\n|$)/m.exec(rest);
  return end ? { start: match.index, end: match.index + match[0].length + end.index + end[0].length } : null;
}

function statuslineUndo(text: string): UndoOp {
  const restore: { text: string; anchor: string | null; spacing: string; atMarker: boolean }[] = [];
  if (!hasBlock(text, "hash")) {
    for (const pattern of [
      /^# Persist Claude's rate-limit windows for ~\/\.claude\/scripts\/budget\/budget-status[^\n]*\n/m,
      /^# L4: cross-subscription pacing[^\n]*\n/m,
    ]) {
      const block = legacyBlock(text, pattern);
      if (!block) continue;
      const before = text.slice(0, block.start);
      const lines = before.split(/(?<=\n)/);
      let spacing = "";
      while (lines.length && !lines.at(-1)!.trim()) spacing = lines.pop()! + spacing;
      const anchor = before.slice(0, before.length - spacing.length).match(/[^\n]*\n$/)?.[0] ?? null;
      restore.push({ text: text.slice(block.start, block.end), anchor, spacing,
        atMarker: text.slice(block.start).startsWith("# L4:") });
    }
  }
  restore.sort((a, b) => text.indexOf(a.text) - text.indexOf(b.text));
  return { kind: "block", style: "hash", restore };
}

export function editStatuslineScript(text: string, command: string): string | null {
  if (!/^input=\$\(cat\)\s*$/m.test(text)) return null;
  const body = `printf '%s' "$input" | ${command} statusline 2>/dev/null`;
  if (hasBlock(text, "hash")) return upsertBlock(text, body, "hash");
  const a = legacyBlock(text, /^# Persist Claude's rate-limit windows for ~\/\.claude\/scripts\/budget\/budget-status[^\n]*\n/m);
  if (a) text = text.slice(0, a.start) + text.slice(a.end);
  const b = legacyBlock(text, /^# L4: cross-subscription pacing[^\n]*\n/m);
  const block = blockText(body, "hash");
  if (b) return text.slice(0, b.start) + block + text.slice(b.end);
  const exit = /\nexit 0\s*$/.exec(text);
  if (exit) return text.slice(0, exit.index) + "\n" + block + text.slice(exit.index);
  return upsertBlock(text, body, "hash");
}

type ClaudeCommands = { session: string; guard: string; statusline: string };
export function editClaudeSettings(old: string | null, cmds: ClaudeCommands, home: string, automatic = false): {
  text: string; undo: UndoOp[]; scriptPath: string | null; needsPipe: boolean;
} {
  const original = !old?.trim() ? {} : parseJsonc(old);
  const { doc, removed } = removeHooks(original, "claude", command => !automatic && typeof command === "string" && command.includes("/.claude/scripts/budget/"));
  const next = upsertHooks(doc, "claude", [
    { event: "SessionStart", command: cmds.session, timeout: 15, statusMessage: "Checking subscription budgets" },
    { event: "PreToolUse", matcher: "Agent|Task|Bash", command: cmds.guard, timeout: 15 },
  ], "claude-code");
  const createdStatusLine = next.statusLine === undefined;
  let scriptPath: string | null = null;
  let needsPipe = false;
  if (createdStatusLine) next.statusLine = { type: "command", command: cmds.statusline };
  else {
    const command = next.statusLine?.command;
    if (typeof command === "string" && /(?:pacer|cli\.(?:ts|js))/.test(command) && /\sstatusline$/.test(command)) {
      next.statusLine.command = cmds.statusline;
    } else {
      scriptPath = typeof command === "string" ? resolveScript(command, home) : null;
      needsPipe = scriptPath === null;
    }
  }
  return {
    text: old !== null && JSON.stringify(original) === JSON.stringify(next)
      ? old : JSON.stringify(next, null, 2) + "\n",
    undo: [
      { kind: "hooks", format: "claude", commands: [cmds.session, cmds.guard], restore: removed },
      ...(createdStatusLine ? [{ kind: "json-key" as const, key: "statusLine" }] : []),
    ],
    scriptPath, needsPipe,
  };
}

/** Describe the actual settings/script edits before connecting Claude Code. */
export function claudeConnectPreview(home: string, root = join(home, ".claude")): string {
  const old = readText(join(root, "settings.json"));
  let settings: Record<string, unknown>;
  try { settings = old?.trim() ? parseJsonc(old) : {}; }
  catch { return "settings.json: cannot preview malformed settings; repair it before connecting"; }
  if (settings.statusLine === undefined) return "settings.json: SessionStart + PreToolUse hooks, and the status line (pacer statusline) because none is set";
  const command = isObj(settings.statusLine) ? settings.statusLine.command : undefined;
  if (typeof command === "string" && /(?:pacer|cli\.(?:ts|js))/.test(command) && /\sstatusline$/.test(command))
    return "settings.json: SessionStart + PreToolUse hooks; refresh the existing pacer status line";
  const path = typeof command === "string" ? resolveScript(command, home) : null;
  if (path && editStatuslineScript(readText(path) ?? "", "pacer") !== null)
    return "settings.json: SessionStart + PreToolUse hooks; existing status line will be left alone. Its script will also pipe the input JSON to pacer statusline.";
  return "settings.json: SessionStart + PreToolUse hooks; existing status line will be left alone. Pipe its input JSON to pacer statusline to include pacer budgets.";
}

export async function installClaude(tx: Txn): Promise<void> {
  const { ctx, pacerArgv } = tx.env;
  const command = shellCommand(pacerArgv);
  const claude = ctx.which("claude");
  if (claude && tx.env.mcp===true) {
    const remove = [claude, "mcp", "remove", "-s", "user", "pacer"];
    await tx.run(remove, undefined, { quiet: true });
    const add = [claude, "mcp", "add", "-s", "user", "pacer", "--", ...pacerArgv, "mcp"];
    await tx.run(add, remove, { successNote: `registered MCP server pacer (${shellCommand(add)})` });
  } else if(tx.env.mcp===true)tx.notes.push(`claude CLI not found: register the MCP server yourself with \`claude mcp add -s user pacer -- ${command} mcp\``);
  // ~/.claude.json is rewritten by running Claude sessions; let the claude CLI remove the entry.
  if(tx.env.mcp===false && tx.env.mode !== "reconcile"){
    if(claude) await removeClaudeMcp(ctx, [claude, "mcp", "remove", "-s", "user", "pacer"], tx.notes, tx.env.configEnv);
    else tx.notes.push("claude CLI not found: remove the MCP server yourself with `claude mcp remove -s user pacer`");
  }
  for (const path of tx.env.mode === "reconcile" ? [] : claudeLegacyFiles(ctx.home, tx.env.folder)) if (existsSync(path)) tx.moveAside(path);
  const root = tx.env.folder ?? join(ctx.home, ".claude");
  installSkill(tx,root);
  tx.edit(join(root, "rules/pacer.md"), () => policyText("claude-code"), []);
  const settingsPath = join(root, "settings.json");
  let settings: ReturnType<typeof editClaudeSettings>;
  try {
    settings = editClaudeSettings(tx.read(settingsPath), {
      session: `${command} status --hook claude-code`,
      guard: `${command} guard --planner claude-code`,
      statusline: `${command} statusline`,
    }, ctx.home, tx.env.mode === "reconcile");
  } catch (error) {
    throw new InstallError(`cannot update ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  tx.edit(settingsPath, () => settings.text, settings.undo);
  let needsPipe = settings.needsPipe;
  if (settings.scriptPath && (tx.env.mode !== "reconcile" || tx.record.files.some(file => file.path === settings.scriptPath))) {
    const old = tx.read(settings.scriptPath);
    const next = old === null ? null : editStatuslineScript(old, command);
    if (next === null) needsPipe = true;
    else tx.edit(settings.scriptPath, () => next, [statuslineUndo(old!)]);
  }
  if (needsPipe) tx.notes.push(`Pipe your status-line JSON to \`${command} statusline\` to include pacer budgets.`);
}

/** Probe before removing so an absent server is not reported as a change. */
export async function removeClaudeMcp(ctx: Ctx, argv: string[], notes: string[], env?: Record<string, string>): Promise<void> {
  let registered = false;
  try { registered = (await ctx.run([argv[0]!, "mcp", "get", "pacer"], 30000, env ? {env: {...ctx.env, ...env}} : undefined)).code === 0; } catch {}
  try {
    const result = await ctx.run(argv, 30000, env ? {env: {...ctx.env, ...env}} : undefined);
    if (!registered) notes.push("MCP server pacer was not registered");
    if (result.code !== 0 && registered) notes.push(`\`${shellCommand(argv)}\` failed (exit ${result.code}): ${(result.stderr || result.stdout).split(/\r?\n/)[0]}`);
    else if (result.code === 0 && registered) notes.push(`removed MCP server pacer (${shellCommand(argv)})`);
  } catch (error) { notes.push(`\`${shellCommand(argv)}\` failed: ${error instanceof Error ? error.message : String(error)}`); }
}
