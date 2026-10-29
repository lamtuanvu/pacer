import type { ComponentChildren } from "preact";
import { useId } from "preact/hooks";
import { Button } from "./Button";
import { classNames } from "./classNames";

export const unsavedCopy = (count: number) => `${count} unsaved change${count === 1 ? "" : "s"}`;

/**
 * Pending-changes bar: the count, Discard and the region's one primary Save. The live
 * region stays mounted while clean so the first change and a later notice are announced.
 */
export function SaveBar({ count, onSave, onDiscard, busy, saveLabel = "Save changes", blockedReason, notice, children, scope, statusDot = false, size = "md" }: {
  scope?: string;
  statusDot?: boolean;
  size?: "sm" | "md";
  count: number;
  onSave: () => void;
  onDiscard: () => void;
  busy?: boolean;
  saveLabel?: string;
  /** Visible reason shown beside a disabled Save (UI-13). */
  blockedReason?: string;
  /** Polite status shown after the bar is clean again, such as "Changes saved". */
  notice?: string;
  /** Errors or extra status for the pending save. */
  children?: ComponentChildren;
}) {
  const dirty = count > 0, reasonId = useId();
  const clean = !dirty && !notice && !children;
  // While clean the bar is visually hidden and is not a landmark; its status stays mounted to announce.
  return <div className={classNames("pc-save-bar", clean && "pc-save-bar--clean")} role={clean ? undefined : "region"} aria-label={clean ? undefined : dirty ? "Unsaved changes" : "Save status"}>
    <div className="pc-save-bar__summary">
      <p className="pc-save-bar__count" role="status" aria-live="polite">{statusDot && !clean && <span aria-hidden="true" className={classNames("pc-save-bar__dot", dirty && "pc-save-bar__dot--dirty")} />}<span>{busy ? "Saving…" : dirty ? unsavedCopy(count) : notice ?? ""}</span>{scope && !clean && <span className="pc-save-bar__scope"> · {scope}</span>}</p>
      {dirty && blockedReason && <p className="pc-save-bar__reason" id={reasonId}>{blockedReason}</p>}
      {children}
    </div>
    {dirty && <div className="pc-save-bar__actions">
      <Button size={size} variant={statusDot ? "ghost" : "secondary"} onClick={onDiscard} disabled={busy}>Discard</Button>
      <Button size={size} variant="primary" onClick={onSave} busy={busy} disabled={!!blockedReason} aria-describedby={blockedReason ? reasonId : undefined}>{saveLabel}</Button>
    </div>}
  </div>;
}
