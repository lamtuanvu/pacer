import type { DesktopUpdateConnection as Connection } from "../../data/desktop";
import { desktopConnectionView } from "../../../../src/view-model/updates";
import { openDesktopTakeover } from "../../data/desktop";
import { Button } from "../../ds/Button";

export function DesktopUpdateConnection({ connection }: { connection: Connection | null }) {
  const view = desktopConnectionView(connection);
  return <div role="status" aria-live="polite"><strong>{view.label}</strong><p>{view.detail}</p>{connection?.terminalCommandDifferent && <p>The terminal command and the service run different builds.</p>}{connection?.reason === "service-takeover" && <Button onClick={() => { void openDesktopTakeover(); }}>Use the app's service</Button>}</div>;
}
