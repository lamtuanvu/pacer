import type { ApiEvent } from "../../src/api/protocol";
import { record, type Session } from "./core";

export function recordOtaEvent(session: Session, scenario: string, event: ApiEvent): void {
  if (event.type !== "desktop.update") return;
  // An observed event is context, not an asserted behavior outcome. Preserve it
  // in the evidence details; the driver's final checks supply the verdict.
  record(session, { kind: "note", surface: "API SSE", text: `OTA ${scenario} event: ${JSON.stringify(event)}` });
}
