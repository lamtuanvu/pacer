import { paceStatus, type StatusTone } from "../../../src/view-model/words";
import { freshnessWords } from "../../../src/view-model/usage";

export interface UsageMeterProps {
  variant?: "board"; used: number | null; pace: number | null; tone: StatusTone; size: "top" | "bar" | "row" | "mini" | "slim"; label: string;
  verdict?: string; paceReason?: string; stale?: boolean; staleAt?: number; now?: number; text?: "full" | "compact" | "none";
}
const clamp = (n: number) => Math.max(0, Math.min(100, n));
/** The meter's own number words; a window-aware surface quotes usageView's summary instead. */
const meterWords = (used: number | null, pace: number | null, style: "full" | "compact"): string => {
  if (used === null) return "usage unknown";
  const u = Math.round(used), p = pace === null ? null : Math.round(pace);
  if (style === "compact") return p === null ? `${u}%` : `${u}%·${p}`;
  return p === null ? `${u}% used` : `${u}% used · pace ${p}%`;
};
/** The tone comes from the service's verdict; the meter never judges the numbers itself. */
export function UsageMeter({ variant, used, pace, tone, size, label, verdict, paceReason, stale, staleAt, now = Date.now() / 1000, text = "full" }: UsageMeterProps) {
  const reason = pace === null && used !== null && paceReason ? paceReason : null;
  // Staleness is stated in the record's own words: "Reading 26h old · refresh", never a bare "Historical usage".
  const freshness = stale ? freshnessWords({ freshness: "historical", observedAt: staleAt ?? null }, now) : null;
  const words = used === null ? "usage unknown" : [meterWords(used, pace, "full").replace(" · ", ", "), reason, verdict && paceStatus(verdict).label.toLowerCase(), freshness?.replace(" · ", ", ").toLowerCase()].filter(Boolean).join(", ");
  const caption = [meterWords(used, pace, text === "compact" ? "compact" : "full"), reason, freshness].filter(Boolean).join(" · ");
  return <span className={["pc-usage", `pc-usage--${size}`, stale && "pc-meter--stale"].filter(Boolean).join(" ")}>
    {/* ARIA meters need a value; with none, the bar is an image named in words. */}
    <span {...(used === null ? { role: "img" as const, "aria-label": `${label}: ${words}` } : { role: "meter" as const, "aria-label": label, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": clamp(used), "aria-valuetext": words })} className={`pc-meter pc-meter--${size}${variant ? ` pc-meter--${variant}` : ""}`}>
      {used !== null && <span className={`pc-meter__fill pc-meter__fill--${tone}`} style={{ "--used": clamp(used) }} />}
      {pace !== null && <span className="pc-meter__pace" style={{ "--pace": clamp(pace) }} />}
    </span>
    {text !== "none" && <span className="pc-usage__text">{caption}</span>}
  </span>;
}
