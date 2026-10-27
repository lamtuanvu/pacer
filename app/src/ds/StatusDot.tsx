import type { Tone } from "../../../src/view-model/words";

/**
 * A status is never colour alone. The label is visible unless `paired` names the neighbour that states it:
 * "glyph" keeps a visually hidden label (StatusGlyph is aria-hidden); "pill" hides the dot from assistive tech,
 * because the StatusPill already announces the same status. Map tone and label from the src/view-model vocabulary.
 */
export function StatusDot({ tone, live = false, label, paired }: { tone: Tone; live?: boolean; label: string; paired?: "glyph" | "pill" }) {
  return <span className={`pc-status-dot pc-status-dot--${tone}`} {...(paired === "pill" ? { "aria-hidden": "true" as const } : {})}>
    <span className={`pc-status-dot__dot${live ? " pc-status-dot__dot--live" : ""}`} aria-hidden="true" />
    {paired === "pill" ? null : <span className={paired ? "pc-status-dot__label pc-status-dot__label--paired" : "pc-status-dot__label"} title={paired ? undefined : label}>{label}</span>}
  </span>;
}
