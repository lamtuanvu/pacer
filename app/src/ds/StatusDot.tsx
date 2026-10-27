import type { Tone } from "../../../src/view-model/words";

/** A status is never colour alone: the label is visible unless `paired` marks an adjacent StatusPill or StatusGlyph that states it. */
export function StatusDot({ tone, live = false, label, paired = false }: { tone: Tone; live?: boolean; label: string; paired?: boolean }) {
  return <span className={`pc-status-dot pc-status-dot--${tone}`}>
    <span className={`pc-status-dot__dot${live ? " pc-status-dot__dot--live" : ""}`} aria-hidden="true" />
    <span className={paired ? "pc-status-dot__label pc-status-dot__label--paired" : "pc-status-dot__label"}>{label}</span>
  </span>;
}
