/** The one presentation function for account and runner usage (ADR 0030, spec section 5).
 * Every app surface, the tray and the narrow top bar render `usageView(state, now)` over the
 * service's `usageState` record; no surface formats a reading itself. */
import { ago, clockParts } from "./time";
import { verdictLabels, verdictWords, type StatusTone } from "./words";
import type { UsageSource, UsageState, UsageWindowState, Verdict } from "../types";

export interface UsageView {
  figure: string;       // "68%", "Out of quota", "No usage figure", "Unmetered", "Usage unknown"
  meter: number | null; // 0..100 or null
  window: string;       // "week", "5 h", "limit", "" — from the window, never assumed
  reset: string;        // one format: "resets 14:00", "resets Fri 14:00", "resets 11 Dec"
  freshness: string;    // "Updated 3m ago", "Reading 26h old · refresh", ""
  source: string;       // "Status line", "Provider reading", "Observed limits", ...
  tone: StatusTone;
  verdictLabel: string; // from the one verdict table
  summary: string;      // figure and window composed once: "68% of week", "Out of quota", "No usage figure", "Unmetered", "Usage unknown"
  summaryUsed: string;  // the metered summary marked used: "68% of week used"; a limit or a missing figure is not "used"
}

/** Source labels, moved here from the Usage popover so every surface spells them once. */
export const usageSources: Record<UsageSource, string> = {
  "status-line": "Status line", "session-log": "Session logs", "provider-cli": "Provider reading",
  metered: "Measured spend", reactive: "Observed limits", unmetered: "No quota limit",
};
export const usageSourceWords = (source: UsageSource | "unknown" | undefined): string =>
  source && source !== "unknown" && Object.hasOwn(usageSources, source) ? usageSources[source]! : "Source unknown";

/** Window words from the window's own name; a name the service does not standardise shows as written. */
export const windowWords = (window: string | null | undefined): string => {
  const name = window?.toLowerCase() ?? "";
  if (name === "weekly" || name === "week" || name === "7d") return "week";
  if (name === "monthly" || name === "month") return "month";
  if (name === "daily" || name === "day") return "day";
  if (name === "5h") return "5 h";
  return window ?? "";
};

/** Age in compact words: "40s", "3m", "26h", "2d". Hours carry the age until a week, like the spec's example. */
const ageWords = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 7 * 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};

/** Freshness text over the record's own observation time; "" when nothing is known. */
export function freshnessWords(state: Pick<UsageState, "freshness" | "observedAt">, now: number): string {
  if (state.freshness === "fresh") return state.observedAt != null ? `Updated ${ago(state.observedAt, now)}` : "";
  if (state.freshness === "historical") return state.observedAt != null
    ? `Reading ${ageWords(now - state.observedAt)} old · refresh` : "Reading of unknown age · refresh";
  return "";
}

/** The one reset format: same day "resets 14:00", within 7 days "resets Fri 14:00", else "resets 11 Dec". */
export function resetWords(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return "reset unknown";
  const { days, time, weekday, date } = clockParts(resetsAt, now);
  // clockParts counts backwards (now − at); a reset sits in the future, so the distance is −days.
  const ahead = -days;
  if (ahead <= 0) return `resets ${time}`;
  if (ahead < 7) return `resets ${weekday} ${time}`;
  return `resets ${date}`;
}

/** The record's figure in words: absence of a figure is a state, never a number (spec section 5). */
export function figureWords(state: UsageState | null | undefined): { figure: string; meter: number | null } {
  if (!state) return { figure: "Usage unknown", meter: null };
  if (state.limit) return { figure: "Out of quota", meter: Math.round(state.figure?.usedPct ?? 100) };
  if (!state.figure) return { figure: state.verdict === "UNMETERED" ? "Unmetered" : "No usage figure", meter: null };
  return { figure: `${Math.round(state.figure.usedPct)}%`, meter: Math.round(state.figure.usedPct) };
}

const verdictTone = (verdict: Verdict | "unknown"): StatusTone => {
  const entry = verdictLabels[verdict] ?? verdictLabels[verdict.toLowerCase()];
  return entry ? entry.tone : "neutral";
};

/** One usage view over the service's usageState record; every surface renders exactly this. */
export function usageView(state: UsageState | null | undefined, now: number): UsageView {
  const { figure, meter } = figureWords(state);
  const window = state?.limit ? windowWords(state.figure?.window ?? "limit") : windowWords(state?.figure?.window ?? null);
  const reset = state?.figure ? resetWords(state.figure.resetsAt, now) : "";
  const freshness = state ? freshnessWords(state, now) : "";
  const source = usageSourceWords(state?.source ?? "unknown");
  const tone: StatusTone = state ? verdictTone(state.verdict) : "neutral";
  const verdictLabel = state ? verdictWords(state.verdict) : "Usage unknown";
  // A measured figure states its window once; a limit, a missing figure or an unknown record is a state on its own.
  const metered = figure.endsWith("%");
  const summary = metered && window ? `${figure} of ${window}` : figure;
  const summaryUsed = metered ? (window ? `${figure} of ${window} used` : `${figure} used`) : figure;
  return { figure, meter, window, reset, freshness, source, tone, verdictLabel, summary, summaryUsed };
}

/** One window of a record's `windows` list, quoted with the same words as the record itself. */
export function usageWindowView(window: UsageWindowState, now: number): { label: string; figure: string; meter: number | null; reset: string } {
  return {
    label: windowWords(window.name),
    figure: window.usedPct === null ? "Usage unknown" : `${Math.round(window.usedPct)}%`,
    meter: window.usedPct === null ? null : Math.round(window.usedPct),
    reset: resetWords(window.resetsAt, now),
  };
}
