/** Ordinary sandbox desktop control authority. The OTA-sourced variant was retired with the TS desktop stack. */
import { sameProcess, type ProcessIdentity } from "./lease";
import { ControlError } from "./contract";
import type { OperationContext } from "./deadline";
import type { Session } from "../core";

export interface ControlWindow {
  pid: number;
  window_id: string;
  label: "main" | "tray";
  client_id: string;
}
export interface DesktopControlBinding {
  source: "ordinary";
  identity: ProcessIdentity;
  appSha256: string;
  version?: string;
  windows?: ControlWindow[];
}

function unavailable(): never {
  throw new ControlError("target_unavailable", "owned desktop identity could not be established");
}

export function assertSameControlBinding(before: DesktopControlBinding, after: DesktopControlBinding): void {
  const key = (b: DesktopControlBinding) => JSON.stringify([b.source, b.identity, b.appSha256, b.windows?.[0]?.client_id]);
  if (key(before) !== key(after)) throw new ControlError("stale_reference", "desktop control authority changed; resolve a fresh command", "not_delivered");
}

/** Every invocation is a fresh observation; no authority cache or session writes. */
export async function resolveDesktopControlBinding(session: Session, clock?: OperationContext): Promise<DesktopControlBinding> {
  clock?.check();
  if (session.desktopPid || session.desktopIdentity) {
    if (!session.desktopIdentity || session.desktopPid !== session.desktopIdentity.pid) unavailable();
    if (!await sameProcess(session.desktopIdentity)) throw new ControlError("stale_reference", "owned desktop process exited or restarted", "not_delivered");
    return { source: "ordinary", identity: { ...session.desktopIdentity }, appSha256: session.desktopSha256 ?? "" };
  }
  unavailable();
}
