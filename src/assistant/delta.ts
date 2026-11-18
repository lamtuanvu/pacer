/** The kind of one `assistant.delta`: answer text, or an activity line such as "Reading tasks…". */
export type AssistantDeltaKind = "text" | "activity";
/** Where a forwarded delta goes: the turn's ephemeral stream, the frames `subscribeTurn` delivers. */
export type AssistantDeltaSink = (turnId: string, kind: AssistantDeltaKind, text: string) => void;

let sink: AssistantDeltaSink | null = null;

/** The assistant service registers its stream once, so the plugin registry never imports the service. */
export function setAssistantDeltaSink(next: AssistantDeltaSink): void {
  sink = next;
}

/**
 * Forward one `assistant.delta` notification of a plugin serving the assistant point. Ephemeral:
 * the frames reach the turn's stream only, and nothing is written to the event outbox. A turn that
 * is not running drops it, and the stored answer stays the one `finishTurn` recorded.
 */
export function forwardAssistantDelta(turnId: string, kind: AssistantDeltaKind, text: string): void {
  sink?.(turnId, kind, text);
}
