// Engine-owned task kinds stay out of ordinary task lists. Orchestrate turns
// still occupy local capacity while they run; workflow-root never does (it is
// not an executor process).

export const ENGINE_OWNED_KINDS = ["orchestrate", "workflow-root"] as const;
export type EngineOwnedKind = (typeof ENGINE_OWNED_KINDS)[number];

export function isEngineOwnedKind(kind: string | null | undefined): boolean {
  return kind === "orchestrate" || kind === "workflow-root";
}

/** Whether a hidden engine-owned task still counts toward machine.used / slots. */
export function occupiesLocalCapacity(kind: string | null | undefined): boolean {
  return kind === "orchestrate";
}
