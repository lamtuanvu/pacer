import type { Backend } from "./backend";

/** Execution backends added by Plan 2b (e.g. Orca), tried in order before the direct backend. Only Plan 2b edits this file. */
export const EXTRA_BACKENDS: Backend[] = [];
