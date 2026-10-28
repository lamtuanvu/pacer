import type { Backend } from "./backend";
import { orcaBackend } from "./orca/backend";

/** Execution backends added by Plan 2b (e.g. Orca), tried in order before the direct backend. Only Plan 2b edits this file. */
export const EXTRA_BACKENDS: Backend[] = [];
export function defaultBackends(): Backend[] {
  if (!EXTRA_BACKENDS.includes(orcaBackend)) EXTRA_BACKENDS.push(orcaBackend);
  return EXTRA_BACKENDS;
}
