import { clock, meterText } from "../../../src/view-model/format";
import { paceStatus, type StatusTone } from "../../../src/view-model/words";

export interface UsageMeterProps {
  used: number | null; pace: number | null; tone: StatusTone; size: "top" | "bar" | "row"; label: string;
  verdict?: string; paceReason?: string; stale?: boolean; staleAt?: number; now?: number; text?: "full" | "compact" | "none";
}
const clamp = (n: number) => Math.max(0, Math.min(100, n));
/** The tone comes from the service's verdict; the meter never judges the numbers itself. */
export function UsageMeter({ used, pace, tone, size, label, verdict, paceReason, stale, staleAt, now = Date.now() / 1000, text = "full" }: UsageMeterProps) {
  const reason = pace === null && used !== null && paceReason ? paceReason : null;
  const words = used === null ? "usage unknown" : [meterText(used, pace, "full").replace(" · ", ", "), reason, verdict && paceStatus(verdict).label.toLowerCase()].filter(Boolean).join(", ");
  const caption = [meterText(used, pace, text === "compact" ? "compact" : "full"), reason, stale && staleAt !== undefined ? `as of ${clock(staleAt, now)}` : null].filter(Boolean).join(" · ");
  return <span className={["pc-usage", `pc-usage--${size}`, stale && "pc-meter--stale"].filter(Boolean).join(" ")}>
    {/* ARIA meters need a value; with none, the bar is an image named in words. */}
    <span {...(used === null ? { role: "img" as const, "aria-label": `${label}: ${words}` } : { role: "meter" as const, "aria-label": label, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": clamp(used), "aria-valuetext": words })} className={`pc-meter pc-meter--${size}`}>
      {used !== null && <span className={`pc-meter__fill pc-meter__fill--${tone}`} style={{ "--used": clamp(used) }} />}
      {pace !== null && <span className="pc-meter__pace" style={{ "--pace": clamp(pace) }} />}
    </span>
    {text !== "none" && <span className="pc-usage__text">{caption}</span>}
  </span>;
}
