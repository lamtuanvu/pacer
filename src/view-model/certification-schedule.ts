/**
 * Certification schedule bounds the UI states when asking for consent.
 * This module is their single definition: src/dispatch/certification-schedule.ts
 * imports them from here, so the app can show them without importing the
 * scheduler and dragging jobs, status and launch code into the bundle.
 */

/** Successful probes allowed per certificate key per day. */
export const MAX_PROBES_PER_DAY = 2;

/** Observed account movement, in percentage points of the probed window,
 *  above which scheduling stops rather than keep paying that much. */
export const MAX_COST_PCT = 2;
