import type { Ctx } from "../../types";
import { OrcaClient, type TerminalRow } from "./client";

/** `caller.typing_quiet_s`: a ping types only after this much terminal silence. */
const TYPING_QUIET_MS = 30_000;
/** The caller's prompt box (`❯` for Claude Code, `>` elsewhere); the bottom-most line wins. */
const PROMPT_LINE = /^\s*[❯>]\s?(.*)$/;
/** Status glyphs agents prepend to their OSC title while they work. */
const WORKING_TITLE = /^(?:[✳✦⏲◇✋▲⠀-⣿◐-◓]+|[.*]\s)\s*/;

/** Text after the prompt glyph of the last prompt box on screen, or "" when no box is visible. */
function draft(preview: string): string {
  const lines = preview.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(PROMPT_LINE);
    if (m) return m[1].trim();
  }
  return "";
}

function busy(t: TerminalRow): boolean {
  if (t.agentWait) return true;
  // Orca evaluated and found no wait: the title is the only agent-state signal when it never looked.
  if (t.agentWait === undefined && typeof t.title === "string" && WORKING_TITLE.test(t.title)) return true;
  if (draft(t.preview ?? "")) return true;
  const out = t.lastOutputAt;
  return typeof out === "number" && Date.now() - out < TYPING_QUIET_MS;
}

/** Type one line into a caller terminal that is idle at an empty prompt; never over a draft or a working agent. */
export async function pingOrcaCaller(ctx: Ctx, handle: string, text: string): Promise<"sent" | "busy" | "gone"> {
  const c = new OrcaClient(ctx.run, ctx.env);
  const r = await c.terminalShow(handle);
  const t = r.ok ? r.result.terminal : undefined;
  if (!t || t.exitCause || t.connected === false || t.writable === false) return "gone";
  if (busy(t)) return "busy";
  return (await c.terminalSend(handle, text)).ok ? "sent" : "gone";
}
