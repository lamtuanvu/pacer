import type { Backend } from "./backend";
import { orcaBackend } from "../plugins/executor-orca";

/** Execution backends tried in order before the direct backend; Orca runs through the bundled pacer-exec-orca provider. */
export const EXTRA_BACKENDS: Backend[] = [orcaBackend];
export function defaultBackends(): Backend[] {
  return EXTRA_BACKENDS;
}
