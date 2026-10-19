import type { Status } from "../../../src/view-model/words";
/** Decorative only: callers print the shared label alongside it. */
export function StatusGlyph({ status }: { status: Status }) {
  return <span className={`pc-glyph pc-status--${status.tone}`} aria-hidden="true">{status.glyph}</span>;
}
