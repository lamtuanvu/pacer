import type { ComponentChildren } from "preact";
import { Button } from "./Button";
import { classNames } from "./classNames";

export const unsavedCopy = (count: number) => `${count} unsaved change${count === 1 ? "" : "s"}`;

/**
 * Pending-changes bar: the count, Discard and the region's one primary Save. The live
 * region stays mounted while clean so the first change and a later notice are announced.
 */
export function SaveBar({ count, onSave, onDiscard, busy, saveLabel = "Save changes", blockedReason, notice, children }: {
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
  const dirty = count > 0;
  return <div className={classNames("pc-save-bar", !dirty && !notice && !children && "pc-save-bar--clean")} role="region" aria-label="Unsaved changes">
    <div className="pc-save-bar__summary">
      <p className="pc-save-bar__count" role="status" aria-live="polite">{dirty ? unsavedCopy(count) : notice ?? ""}</p>
      {dirty && blockedReason && <p className="pc-save-bar__reason">{blockedReason}</p>}
      {children}
    </div>
    {dirty && <div className="pc-save-bar__actions">
      <Button onClick={onDiscard} disabled={busy}>Discard</Button>
      <Button variant="primary" onClick={onSave} busy={busy} disabled={!!blockedReason}>{saveLabel}</Button>
    </div>}
  </div>;
}
