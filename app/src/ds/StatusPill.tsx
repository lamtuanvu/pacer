import type { Status } from "../../../src/view-model/words";
import { Pill } from "./Pill";
import { StatusGlyph } from "./StatusGlyph";
export function StatusPill({ status }: { status: Status }) {
  return <Pill tone={status.tone}><StatusGlyph status={status} />{status.label}</Pill>;
}
