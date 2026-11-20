import type { Ctx } from "../../types";
import { OrcaClient, type TerminalRow } from "./client";

/** `caller.typing_quiet_s`: a ping types only after this much terminal silence. */
const TYPING_QUIET_MS = 30_000;
/** Screen rows read per ping; enough to reach the prompt box above the status block. */
const SCREEN_LIMIT = 14;
/** Claude Code prefixes the OSC title with ✳ when idle at its prompt; a spinner glyph means it is working. */
const IDLE_TITLE = "✳";
/** The prompt box: a `❯` row boxed by `─` rules (Claude Code's input box). */
const RULE = /^─+$/;
const PROMPT = /^❯(?:\s(.*))?$/;
/** One line, no control characters: `terminal send --enter` appends Enter, so a newline would submit early. */
const ONE_LINE = /^[^\x00-\x1f\x7f]+$/;

/** Bottom-most boxed prompt row: "empty", "draft", or "unknown" when the screen shows no prompt box. */
function promptState(rows: string[]): "empty" | "draft" | "unknown" {
  for (let i = rows.length - 2; i > 0; i--) {
    const prev = (rows[i - 1] ?? "").trim();
    const row = (rows[i] ?? "").trim();
    if (!RULE.test(prev) || !PROMPT.test(row)) continue;
    const after = row.slice(1).trim();
    if (after) return "draft";
    return RULE.test((rows[i + 1] ?? "").trim()) ? "empty" : "draft";
  }
  return "unknown";
}

function busy(t: TerminalRow): boolean {
  if (t.agentWait) return true;
  if (typeof t.title !== "string" || !t.title.startsWith(IDLE_TITLE)) return true;
  const out = t.lastOutputAt;
  return typeof out === "number" && Date.now() - out < TYPING_QUIET_MS;
}

/**
 * Type one line into a caller terminal that is idle at an empty prompt; never over a draft or a
 * working agent. There is an unavoidable gap between the reads and the send: a keystroke in between
 * is lost or merged, so nothing awaits between the last read and `terminalSend`.
 */
export async function pingOrcaCaller(ctx: Ctx, handle: string, text: string): Promise<"sent" | "busy" | "gone"> {
  if (!ONE_LINE.test(text)) return "busy";
  const c = new OrcaClient(ctx.run, ctx.env);
  const r = await c.terminalShow(handle);
  const t = r.ok ? r.result.terminal : undefined;
  if (!t || t.exitCause || t.connected === false || t.writable === false) return "gone";
  if (busy(t)) return "busy";
  // The show preview is the bottom of the screen without the prompt box, so read the screen itself;
  // a missing box means we cannot prove the prompt is empty: fail safe.
  const s = await c.terminalScreen(handle, SCREEN_LIMIT);
  const rows = s.ok ? s.result.terminal?.tail : undefined;
  if (!rows || promptState(rows) !== "empty") return "busy";
  return (await c.terminalSend(handle, text)).ok ? "sent" : "gone";
}
