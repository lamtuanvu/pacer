import type { Status } from "../engine/status";
import { agentInfo, runnerAgent } from "../view-model/agents";
import { backIn, meterText } from "../view-model/format";
import { counts, plannerMeter } from "../view-model/selectors";
import type { ClientSnapshot } from "../view-model/snapshot";
import { compactVerdictWords, modeWords, offlineWords, toneFor } from "../view-model/words";

export interface LineOptions { width?: number; color?: boolean }
export interface LineFields {
  online: boolean; planner: string | null; agent: string | null; usedPct: number | null; pacePct: number | null;
  verdict: string | null; resetsAt: number | null; running: number | null; attention: number | null; mode: string | null;
}

/** Status remains accepted for the installed agent status-bar capture path. */
export function lineFields(input: ClientSnapshot | Status | null): LineFields {
  const offline: LineFields = { online: false, planner: null, agent: null, usedPct: null, pacePct: null, verdict: null, resetsAt: null, running: null, attention: null, mode: null };
  if (!input) return offline;
  if ("generatedAt" in input) {
    const p = input.providers.find(p => p.id === input.planner);
    const agent = p?.agent ?? runnerAgent(input.planner);
    return { ...offline, online: true, planner: agentInfo(agent).name, agent, usedPct: p?.binding?.usedPct ?? null, pacePct: p?.binding?.pace ?? null, verdict: p?.verdict ?? "UNKNOWN", resetsAt: p?.binding?.resetsAt ?? null, mode: input.mode };
  }
  const p = plannerMeter(input), c = counts(input);
  const count = (n: number | undefined): number | null => n !== undefined && Number.isInteger(n) && n >= 0 ? n : null;
  const legacy = input.budget?.providers.find(p => p.id === input.budget!.planner);
  const agent = p?.agent ?? (input.budget ? legacy?.agent ?? runnerAgent(input.budget.planner) : null);
  if (!agent) return offline;
  return { online: true, planner: agentInfo(agent).name, agent, usedPct: p?.usedPct ?? legacy?.usedPct ?? null,
    pacePct: p?.pacePct ?? legacy?.pacePct ?? null, verdict: p?.verdict ?? legacy?.verdict ?? "unknown",
    resetsAt: p?.resetsAt ?? legacy?.resetsAt ?? null, running: count(c?.running), attention: count(c?.attention),
    mode: p?.mode ?? input.mode?.mode ?? input.budget?.mode ?? "normal" };
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Kept for consumers of the original reset formatter. */
export function fmtReset(ts: number | null, now: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000), hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `↻ ${ts - now < 20 * 3600 ? hm : `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${hm}`}`;
}

export function renderLine(input: ClientSnapshot | Status | null, options: LineOptions = {}): string {
  const f = lineFields(input);
  // The board keeps the mark, dimmed, so the slot stays recognisable while pacer is down.
  if (!f.online) return options.color ?? true ? `\x1b[2m▬┃\x1b[0m ${offlineWords}` : `▬┃ ${offlineWords}`;
  if (input && "disabled" in input && input.disabled) return "pacer off (PACER=off)";
  const color = options.color ?? true;
  const paint = (s: string, hex: string) => color ? `\x1b[38;2;${hex.replace("#", "").match(/../g)!.map(x => parseInt(x, 16)).join(";")}m${s}\x1b[0m` : s;
  const tone = toneFor(f.verdict ?? "unknown"), tick = tone === "bad" ? "fca5a5" : tone === "warn" ? "fcd34d" : tone === "neutral" ? "71717a" : "a3e635";
  const mark = paint("▬", "a3e635") + paint("┃", tick);
  const brand = agentInfo(f.agent!).color;
  const name = paint(f.planner!, brand === "ink" ? "fafafa" : brand);
  const verdict = compactVerdictWords(f.verdict!);
  const now = input && "at" in input ? input.at : (input as Status).generatedAt;
  const main = verdict === "out" ? `${verdict} · ${f.resetsAt === null ? backIn(null, now) : `back ${fmtReset(f.resetsAt, now).slice(2)}`}` : `${meterText(f.usedPct, f.pacePct, "compact")}${verdict ? ` ${verdict}` : ""}`;
  const used = f.usedPct === null ? "?" : String(Math.round(f.usedPct));
  const running = f.running === null ? "" : paint(`▸${f.running}`, "93c5fd");
  const attention = f.attention ? paint(`⚑${f.attention}`, "fcd34d") : "";
  const mode = f.mode && f.mode !== "normal" ? modeWords(f.mode).toLowerCase() : "";
  const stages = [
    [mark, name, main].join(" ") + [running, attention, mode].filter(Boolean).map(s => `  ${s}`).join(""),
    [mark, name, main].join(" ") + [running, attention].filter(Boolean).map(s => `  ${s}`).join(""),
    [mark, main, running, attention].filter(Boolean).join(" "),
    `${mark}${used}${attention ? ` ${attention}` : ""}`,
  ];
  const width = Number.isFinite(options.width) && options.width! > 0 ? Math.floor(options.width!) : 80;
  const start = width <= 20 ? 3 : width <= 40 ? 2 : width <= 60 ? 1 : 0;
  return stages.slice(start).find(s => s.replace(/\x1b\[[0-9;]*m/g, "").length <= width) ?? stages[3]!;
}
