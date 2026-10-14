import type { Mode } from "../engine/mode";
import type { Status } from "../engine/status";
import type { Verdict } from "../types";
import { accountGroups, runnerLabel } from "./accounts";

const C = { red: "\x1b[31m", yellow: "\x1b[33m", green: "\x1b[32m", dim: "\x1b[2m", bold: "\x1b[1m", reset: "\x1b[0m" };
type Color = keyof typeof C;

const VERDICT_TEXT: Record<Verdict, [string, Color]> = {
  ON_PACE: ["✓ on pace", "green"],
  BEHIND: ["▼ behind pace, use more", "green"],
  AHEAD: ["▲ ahead of pace, slow down", "yellow"],
  EXPIRING: ["↓ resets soon unused, use it", "yellow"],
  NEAR_LIMIT: ["! near limit", "yellow"],
  EXHAUSTED: ["✗ exhausted, avoid", "red"],
  OK: ["✓ ok", "green"],
  UNKNOWN: ["? no data yet", "dim"],
};
const MODE_SHORT: Record<Mode, string> = {
  strict: "plans + reviews only, delegate all edits",
  normal: "plans + tiny edits, delegate execution",
  relaxed: "may do small/medium edits, delegate bulk",
  emergency: "nearly out, delegate everything",
};
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number) => String(n).padStart(2, "0");
const paint = (text: string, color: Color) => `${C[color]}${text}${C.reset}`;

export function fmtReset(ts: number | null, now: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `↻ ${ts - now < 20 * 3600 ? hm : `${DAYS[d.getDay()]} ${hm}`}`;
}

export function renderLine(st: Status): string {
  const sep = `  ${paint("│", "dim")}  `;
  if (st.disabled) return `${paint("◆ Budget", "dim")}  pacer off (PACER=off)`;
  const parts = accountGroups(st.providers).flatMap(g=>g.rows).map((p) => {
    if(p.agent && p.unavailableReason) return `${runnerLabel(p)} ${paint(`usage-only · ${p.unavailableReason}`,"dim")}`;
    if(p.blockedReason) return `${runnerLabel(p)} ${paint("Blocked by you","dim")}`;
    if(p.brokenReason) return `${runnerLabel(p)} ${paint(`Not working · ${p.brokenReason}`,"red")}`;
    const b = p.binding;
    const [text, color] = VERDICT_TEXT[p.verdict];
    let seg = `${C.bold}${runnerLabel(p)}${C.reset} `;
    if (b?.usedPct != null) {
      seg += `${b.usedPct.toFixed(0)}% used`;
      if (b.pace !== undefined) seg += ` / ${b.pace.toFixed(0)}% pace`;
      seg += " ";
    }
    seg += paint(text, color);
    const reset = fmtReset(b?.resetsAt ?? null, st.generatedAt);
    if (reset) seg += ` ${paint(reset, "dim")}`;
    return seg;
  });
  const line1 = `${paint("◆ Budget", "dim")}  ${parts.join(sep)}`;
  const modeColor: Color = st.mode === "strict" ? "yellow" : st.mode === "emergency" ? "red" : "green";
  const ranked = st.executors.ranked;
  const label=(id:string)=>runnerLabel(st.providers.find(p=>p.id===id) ?? {id});
  const unavailable = st.executors.excluded.filter((e) => e.reason !== "planner").map((e) => label(e.id));
  let next = ranked.length ? `next executor: ${label(ranked[0].id)}` : "no executor budget left";
  if (ranked.length && unavailable.length) next += ` (${unavailable.join(", ")} unavailable)`;
  const line2 = `${paint("» Mode", "dim")}  ${paint(st.mode, modeColor)}: ${label(st.planner)} ${MODE_SHORT[st.mode]}${sep}${next}`;
  return `${line1}\n${line2}`;
}
