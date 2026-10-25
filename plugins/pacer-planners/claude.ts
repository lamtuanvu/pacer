import { isAbsolute, join } from "node:path";
import {
  blockText,
  hasBlock,
  upsertBlock,
  removeHooks,
  upsertHooks,
  parseJsonc,
  shellCommand,
  type UndoOp,
} from "@pacer/plugin/install";
import { InstallError } from "../../packages/plugin-sdk/src/install/plan";
import { installSkill } from "./skill";
import { policyText } from "./policy";
import type { PlannerBuilder } from "./types";
function resolveScript(command: string, home: string): string | null {
  if (!command || /\s/.test(command)) return null;
  const path = command.replace(/^~(?=\/)/, home).replace(/^\$HOME(?=\/)/, home);
  return isAbsolute(path) ? path : null;
}
async function claudeLegacyFiles(tx: PlannerBuilder): Promise<string[]> {
  const root = tx.env.folder ?? join(tx.context.home, ".claude");
  return [
    ...["budget_status.py", "subagent_guard.py", "budget-status"].map((name) =>
      join(root, "scripts/budget", name),
    ),
    join(root, "rules/model-delegation.md"),
    ...(await tx.context.list(join(root, "agents/delegation"), "*.md")).sort(),
  ];
}
/** Legacy blocks end at the next column-zero fi, leaving surrounding shell intact. */
function legacyBlock(
  text: string,
  anchor: RegExp,
): { start: number; end: number } | null {
  const match = anchor.exec(text);
  if (!match) return null;
  const rest = text.slice(match.index + match[0].length);
  const end = /^fi[\t ]*(?:\r?\n|$)/m.exec(rest);
  return end
    ? {
        start: match.index,
        end: match.index + match[0].length + end.index + end[0].length,
      }
    : null;
}

function statuslineUndo(text: string): UndoOp {
  const restore: {
    text: string;
    anchor: string | null;
    spacing: string;
    atMarker: boolean;
  }[] = [];
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
      while (lines.length && !lines.at(-1)!.trim())
        spacing = lines.pop()! + spacing;
      const anchor =
        before
          .slice(0, before.length - spacing.length)
          .match(/[^\n]*\n$/)?.[0] ?? null;
      restore.push({
        text: text.slice(block.start, block.end),
        anchor,
        spacing,
        atMarker: text.slice(block.start).startsWith("# L4:"),
      });
    }
  }
  restore.sort((a, b) => text.indexOf(a.text) - text.indexOf(b.text));
  return { kind: "block", style: "hash", restore };
}

export function editStatuslineScript(
  text: string,
  command: string,
): string | null {
  if (!/^input=\$\(cat\)\s*$/m.test(text)) return null;
  const body = `printf '%s' "$input" | ${command} statusline 2>/dev/null`;
  if (hasBlock(text, "hash")) return upsertBlock(text, body, "hash");
  const a = legacyBlock(
    text,
    /^# Persist Claude's rate-limit windows for ~\/\.claude\/scripts\/budget\/budget-status[^\n]*\n/m,
  );
  if (a) text = text.slice(0, a.start) + text.slice(a.end);
  const b = legacyBlock(text, /^# L4: cross-subscription pacing[^\n]*\n/m);
  const block = blockText(body, "hash");
  if (b) return text.slice(0, b.start) + block + text.slice(b.end);
  const exit = /\nexit 0\s*$/.exec(text);
  if (exit)
    return text.slice(0, exit.index) + "\n" + block + text.slice(exit.index);
  return upsertBlock(text, body, "hash");
}

type ClaudeCommands = { session: string; guard: string; statusline: string };
export function editClaudeSettings(
  old: string | null,
  cmds: ClaudeCommands,
  home: string,
  automatic = false,
): {
  text: string;
  undo: UndoOp[];
  scriptPath: string | null;
  needsPipe: boolean;
} {
  const original = !old?.trim() ? {} : parseJsonc(old);
  const { doc, removed } = removeHooks(
    original,
    "claude",
    (command) =>
      !automatic &&
      typeof command === "string" &&
      command.includes("/.claude/scripts/budget/"),
  );
  const next = upsertHooks(
    doc,
    "claude",
    [
      {
        event: "SessionStart",
        command: cmds.session,
        timeout: 15,
        statusMessage: "Checking subscription budgets",
      },
      {
        event: "PreToolUse",
        matcher: "Agent|Task",
        command: cmds.guard,
        timeout: 15,
      },
    ],
    "claude-code",
  );
  const createdStatusLine = next.statusLine === undefined;
  let scriptPath: string | null = null;
  let needsPipe = false;
  if (createdStatusLine)
    next.statusLine = { type: "command", command: cmds.statusline };
  else {
    const command = next.statusLine?.command;
    if (
      typeof command === "string" &&
      /(?:pacer|cli\.(?:ts|js))/.test(command) &&
      /\sstatusline$/.test(command)
    ) {
      next.statusLine.command = cmds.statusline;
    } else {
      scriptPath =
        typeof command === "string" ? resolveScript(command, home) : null;
      needsPipe = scriptPath === null;
    }
  }
  return {
    text:
      old !== null && JSON.stringify(original) === JSON.stringify(next)
        ? old
        : JSON.stringify(next, null, 2) + "\n",
    undo: [
      {
        kind: "hooks",
        format: "claude",
        commands: [cmds.session, cmds.guard],
        restore: removed,
      },
      ...(createdStatusLine
        ? [{ kind: "json-key" as const, key: "statusLine" }]
        : []),
    ],
    scriptPath,
    needsPipe,
  };
}

export async function installClaude(tx: PlannerBuilder): Promise<void> {
  const { pacerArgv } = tx.env;
  const ctx = tx.context;
  const command = shellCommand(pacerArgv);
  const claude = ctx.binary;
  if (claude && tx.env.mcp === true) {
    const remove = [claude, "mcp", "remove", "-s", "user", "pacer"];
    await tx.run(remove, undefined, { quiet: true });
    const add = [
      claude,
      "mcp",
      "add",
      "-s",
      "user",
      "pacer",
      "--",
      ...pacerArgv,
      "mcp",
    ];
    await tx.run(add, remove, {
      successNote: `registered MCP server pacer (${shellCommand(add)})`,
    });
  } else if (tx.env.mcp === true)
    tx.notes.push(
      `claude CLI not found: register the MCP server yourself with \`claude mcp add -s user pacer -- ${command} mcp\``,
    );
  // ~/.claude.json is rewritten by running Claude sessions; let the claude CLI remove the entry.
  if (tx.env.mcp === false && tx.env.mode !== "reconcile") {
    if (claude)
      await removeClaudeMcp(tx, [
        claude,
        "mcp",
        "remove",
        "-s",
        "user",
        "pacer",
      ]);
    else
      tx.notes.push(
        "claude CLI not found: remove the MCP server yourself with `claude mcp remove -s user pacer`",
      );
  }
  for (const path of tx.env.mode === "reconcile"
    ? []
    : await claudeLegacyFiles(tx))
    if ((await tx.read(path)) !== null) await tx.moveAside(path);
  const root = tx.env.folder ?? join(ctx.home, ".claude");
  await installSkill(tx, root);
  await tx.edit(
    join(root, "rules/pacer.md"),
    () => policyText("claude-code"),
    [],
  );
  const settingsPath = join(root, "settings.json");
  let settings: ReturnType<typeof editClaudeSettings>;
  try {
    settings = editClaudeSettings(
      await tx.read(settingsPath),
      {
        session: `${command} status --hook claude-code`,
        guard: `${command} guard --planner claude-code`,
        statusline: `${command} statusline`,
      },
      ctx.home,
      tx.env.mode === "reconcile",
    );
  } catch (error) {
    throw new InstallError(
      `cannot update ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await tx.edit(settingsPath, () => settings.text, settings.undo);
  let needsPipe = settings.needsPipe;
  if (
    settings.scriptPath &&
    (tx.env.mode !== "reconcile" ||
      tx.record.files.some((file) => file.path === settings.scriptPath))
  ) {
    const old = await tx.read(settings.scriptPath);
    const next = old === null ? null : editStatuslineScript(old, command);
    if (next === null) needsPipe = true;
    else await tx.edit(settings.scriptPath, () => next, [statuslineUndo(old!)]);
  }
  if (needsPipe)
    tx.notes.push(
      `Pipe your status-line JSON to \`${command} statusline\` to include pacer budgets.`,
    );
}

export async function removeClaudeMcp(
  tx: Pick<PlannerBuilder, "runRaw" | "notes">,
  argv: string[],
): Promise<void> {
  let registered = false;
  try {
    registered =
      (await tx.runRaw([argv[0]!, "mcp", "get", "pacer"])).code === 0;
  } catch {}
  try {
    const result = await tx.runRaw(argv);
    if (!registered) tx.notes.push("MCP server pacer was not registered");
    if (result.code !== 0 && registered)
      tx.notes.push(
        `\`${shellCommand(argv)}\` failed (exit ${result.code}): ${(result.stderr || result.stdout).split(/\r?\n/)[0]}`,
      );
    else if (result.code === 0 && registered)
      tx.notes.push(`removed MCP server pacer (${shellCommand(argv)})`);
  } catch (error) {
    tx.notes.push(
      `\`${shellCommand(argv)}\` failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Preview reads use the ordinary read borrow; no builder or effect intent exists. */
export async function claudePreview(
  io: { read(path: string): Promise<{ text: string; mode: number } | null> },
  home: string,
  root: string,
): Promise<string> {
  const old = (await io.read(join(root, "settings.json")))?.text;
  let settings: Record<string, any>;
  try {
    settings = old?.trim() ? parseJsonc(old) : {};
  } catch {
    return "settings.json: cannot preview malformed settings; repair it before connecting";
  }
  if (settings.statusLine === undefined)
    return "settings.json: SessionStart + PreToolUse hooks, and the status line (pacer statusline) because none is set";
  const command = settings.statusLine?.command;
  if (
    typeof command === "string" &&
    /(?:pacer|cli\.(?:ts|js))/.test(command) &&
    /\sstatusline$/.test(command)
  )
    return "settings.json: SessionStart + PreToolUse hooks; refresh the existing pacer status line";
  const path =
    typeof command === "string" ? resolveScript(command, home) : null;
  if (
    path &&
    editStatuslineScript((await io.read(path))?.text ?? "", "pacer") !== null
  )
    return "settings.json: SessionStart + PreToolUse hooks; existing status line will be left alone. Its script will also pipe the input JSON to pacer statusline.";
  return "settings.json: SessionStart + PreToolUse hooks; existing status line will be left alone. Pipe its input JSON to pacer statusline to include pacer budgets.";
}
