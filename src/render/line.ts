import type { Status } from "../engine/status";
import { agentInfo, runnerAgent } from "../view-model/agents";
import { backIn } from "../view-model/format";
import { counts, plannerMeter } from "../view-model/selectors";
import type { ClientSnapshot } from "../view-model/snapshot";
import { usageView } from "../view-model/usage";
import { compactPolicyWords, policyWords, type PolicySummary, compactVerdictWords, modeWords, offlineWords, toneFor } from "../view-model/words";

export interface LineOptions { width?: number; color?: boolean; policy?: PolicySummary }
export interface LineFields {
  policy?: PolicySummary; online: boolean; planner: string | null; agent: string | null; usedPct: number | null; pacePct: number | null;
  verdict: string | null; resetsAt: number | null; running: number | null; attention: number | null; mode: string | null;
  /** Present only while the planner's reading is historical. */
  stale?: boolean;
  /** usageView figure/meter when the planner row carries usageState (ADR 0030). */
  usageFigure?: string;
  usageMeter?: number | null;
}

/** Status remains accepted for the installed agent status-bar capture path. */
export function lineFields(input: ClientSnapshot | Status | null, policy?: PolicySummary): LineFields {
  const offline: LineFields = { online: false, planner: null, agent: null, usedPct: null, pacePct: null, verdict: null, resetsAt: null, running: null, attention: null, mode: null };
  if (!input) return offline;
  if ("generatedAt" in input) {
    const p = input.providers.find(p => p.id === input.planner);
    const agent = p?.agent ?? runnerAgent(input.planner);
    // A stale reading never shows a live-looking figure; the renderer's
    // "stale reading" marker replaces it (see renderLine). Any truthy service
    // stale flag marks the reading historical.
    const stale = !!p?.stale;
    return { ...offline, policy: policy ?? input.policy, online: true, planner: agentInfo(agent).name, agent,
      usedPct: stale ? null : p?.binding?.usedPct ?? null, pacePct: stale ? null : p?.binding?.pace ?? null,
      verdict: p?.verdict ?? "UNKNOWN", resetsAt: p?.binding?.resetsAt ?? null, mode: input.mode, ...(stale ? { stale: true } : {}) };
  }
  const p = plannerMeter(input), c = counts(input);
  const count = (n: number | undefined): number | null => n !== undefined && Number.isInteger(n) && n >= 0 ? n : null;
  const legacy = input.budget?.providers.find(p => p.id === input.budget!.planner);
  const agent = p?.agent ?? (input.budget ? legacy?.agent ?? runnerAgent(input.budget.planner) : null);
  if (!agent) return offline;
  // usageState wins through usageView; a historical record keeps the stale-reading marker.
  const view = p?.usageState ? usageView(p.usageState, input.at) : null;
  const stale = p?.usageState ? p.usageState.freshness === "historical" : !!p?.stale;
  const usedPct = stale ? null : (view ? view.meter : p?.usedPct ?? legacy?.usedPct ?? null);
  const pacePct = stale || (view && view.meter === null) ? null : p?.pacePct ?? legacy?.pacePct ?? null;
  return { policy: policy ?? input.policy, online: true, planner: agentInfo(agent).name, agent,
    usedPct, pacePct,
    verdict: p?.verdict ?? legacy?.verdict ?? "unknown",
    resetsAt: p?.resetsAt ?? legacy?.resetsAt ?? null, running: count(c?.running), attention: count(c?.attention),
    mode: p?.mode ?? input.mode?.mode ?? input.budget?.mode ?? "normal",
    ...(stale ? { stale: true } : {}),
    ...(view ? { usageFigure: view.figure, usageMeter: view.meter } : {}) };
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Kept for consumers of the original reset formatter. */
export function fmtReset(ts: number | null, now: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000), hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `↻ ${ts - now < 20 * 3600 ? hm : `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${hm}`}`;
}

export function renderLine(input: ClientSnapshot | Status | null, options: LineOptions = {}): string {
  const f = lineFields(input, options.policy);
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
  // Exhaustion with a known reset wins over staleness; a stale reading without
  // it shows the TUI's "stale reading" marker instead of any figure.
  // usageView figure wins when present; ·pace only for a measured percent (never "Unmetered·77").
  const compactFigure = f.usageFigure != null
    ? `${f.usageFigure}${f.usageMeter != null && f.usageFigure.endsWith("%") && f.pacePct !== null ? `·${Math.round(f.pacePct)}` : ""}`
    : f.usedPct === null ? "usage unknown" : `${Math.round(f.usedPct)}%${f.pacePct === null ? "" : `·${Math.round(f.pacePct)}`}`;
  const main = verdict === "out" && f.resetsAt !== null ? `${verdict} · back ${fmtReset(f.resetsAt, now).slice(2)}`
    : f.stale ? "stale reading"
    : verdict === "out" ? `${verdict} · ${backIn(null, now)}`
    : `${compactFigure}${verdict ? ` ${verdict}` : ""}`;
  const used = f.usedPct === null ? "?" : String(Math.round(f.usedPct));
  const running = f.running === null ? "" : paint(`▸${f.running}`, "93c5fd");
  const attention = f.attention ? paint(`⚑${f.attention}`, "fcd34d") : "";
  const mode = f.mode && f.mode !== "normal" ? modeWords(f.mode).toLowerCase() : "";
  const policy = policyWords(f.policy);
  const stages = [
    [mark, name, main].join(" ") + [policy, running, attention, mode].filter(Boolean).map(s => `  ${s}`).join(""),
    [mark, name, main].join(" ") + [policy, running, attention].filter(Boolean).map(s => `  ${s}`).join(""),
    [mark, main, policy, running, attention].filter(Boolean).join(" "),
    [mark, used, policy, attention].filter(Boolean).join(" "),
    [mark, used, compactPolicyWords(f.policy), attention].filter(Boolean).join(" "),
    [`${mark}${used}`, compactPolicyWords(f.policy), attention].filter(Boolean).join(" "),
    [compactPolicyWords(f.policy), attention].filter(Boolean).join(" "),
    [`${mark}${used}`, compactPolicyWords(f.policy)].join(" "),
    [mark, compactPolicyWords(f.policy)].join(" "),
    compactPolicyWords(f.policy),
  ];
  const width = Number.isFinite(options.width) && options.width! > 0 ? Math.floor(options.width!) : 80;
  const start = width <= 20 ? 3 : width <= 40 ? 2 : width <= 60 ? 1 : 0;
  return stages.slice(start).find(s => s.replace(/\x1b\[[0-9;]*m/g, "").length <= width) ?? stages.at(-1)!;
}
