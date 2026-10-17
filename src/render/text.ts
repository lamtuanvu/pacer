import { pauseLine } from "../core/pause";
import type { Mode } from "../engine/mode";
import type { Status } from "../engine/status";
import type { WindowStatus } from "../engine/verdict";
import { accountGroups, runnerLabel } from "./accounts";

export function modeGuidance(mode: Mode, p: string): string {
  switch (mode) {
    case "strict":
      return `${p} is AHEAD of its weekly pace. Delegate ALL implementation, test runs, refactors, searches and bulk edits to executors. ${p} only plans, decides and reviews; keep turns short.`;
    case "normal":
      return `${p} is on pace. Delegate execution (multi-file edits, test/fix loops, boilerplate, migrations). ${p} may do tiny edits (about 20 lines, one file) itself.`;
    case "relaxed":
      return `${p} is BEHIND pace or its window resets soon with quota unused. ${p} may do small and medium edits itself; still delegate bulk or mechanical work.`;
    case "emergency":
      return `${p}'s quota is EXHAUSTED or nearly so. Delegate everything possible; keep ${p} to one-line decisions.`;
  }
}

function fmtWindow(w: WindowStatus): string {
  if (w.usedPct === null) return `${w.name} ?`;
  let s = `${w.name} ${w.usedPct.toFixed(0)}%`;
  if (w.pace !== undefined) s += ` (pace ${w.pace.toFixed(0)}%, ${(w.activeHoursLeft ?? 0).toFixed(0)} active-h left)`;
  if (w.rolled) s += " [reset since last reading]";
  return `${s} ${w.verdict}`;
}

export function renderText(st: Status): string {
  const lines = accountGroups(st.providers).flatMap(group => [...(group.account ? [`Account ${group.account}`] : []), ...group.rows.map((p) => {
    const name = runnerLabel(p);
    if(p.agent && p.unavailableReason) return `- ${name}: usage-only · ${p.unavailableReason}${p.windows.length ? ` · ${p.windows.map(fmtWindow).join("; ")}` : ""}`;
    if(p.brokenReason) return `- ${name}: Not working · ${p.brokenReason}`;
    if(p.blockedReason) return `- ${name}: Blocked by you`;
    if (p.usage === "unmetered") return `- ${name}: local, unmetered OK`;
    if (!p.windows.length) return `- ${name}: unavailable (${p.error ?? "no data"})`;
    const stale = p.stale ? " [stale]" : "";
    return `- ${name}: ${p.windows.map(fmtWindow).join("; ")}${stale}`;
  })]);
  const planner = runnerLabel(st.providers.find(p=>p.id===st.planner) ?? {id:st.planner});
  if (st.paused) lines.push(pauseLine(st.paused));
  lines.push(`Mode: ${st.mode.toUpperCase()} - ${modeGuidance(st.mode, planner)}`);
  const ex = st.executors;
  const excluded = ex.excluded.filter((e) => e.reason !== "planner").map((e) => `${e.id}: ${e.reason}`);
  lines.push(ex.ranked.length
    ? `Executor preference: ${ex.ranked.map((e) => e.id).join(" > ")}${excluded.length ? ` (excluded: ${excluded.join(", ")})` : ""}`
    : `No executor available${excluded.length ? ` (${excluded.join(", ")})` : ""}. ${planner} does the work; keep it lean.`);
  lines.push(`Pace clock: ${st.calendarPace ? "calendar (not enough activity history yet)" : "learned activity"}`);
  return lines.join("\n");
}
