import type { DesktopUpdateConnection as Connection } from "../../data/desktop";
import { desktopConnectionView } from "../../../../src/view-model/updates";

export function DesktopUpdateConnection({ connection }: { connection: Connection | null }) {
  const view = desktopConnectionView(connection);
  return <div role="status" aria-live="polite"><strong>{view.label}</strong><p>{view.detail}</p></div>;
}
