import type { ComponentChildren } from "preact";
import { forwardRef } from "preact/compat";

/**
 * The polite result line beside a control. It stays mounted while empty so a later message is
 * announced, and a caller may focus it when its action removes the control that had focus.
 */
export const ActionStatus = forwardRef<HTMLParagraphElement, { children?: ComponentChildren }>(function ActionStatus({ children }, ref) {
  return <p ref={ref} tabIndex={-1} role="status" aria-live="polite" className={children ? "pc-action-status" : "sr-only"}>{children}</p>;
});
