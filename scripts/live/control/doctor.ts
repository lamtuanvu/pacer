import { nativeCommand } from "./desktop";
import { sameProcess } from "./lease";
import type { Session } from "../core";
import type { ControlResult } from "./contract";
export async function desktopDoctor(session: Session, requestAccessibility = false): Promise<ControlResult> {
  const result: ControlResult = { schema_version: 1, command_id: crypto.randomUUID(), command: "doctor", started_at: new Date().toISOString(), finished_at: "", outcome: "ok", artifacts: [] };
  try {
    const permissions = await nativeCommand({ command: "doctor", request_accessibility: requestAccessibility });
    const owned = session.desktopIdentity ? await sameProcess(session.desktopIdentity) : false;
    result.diagnostics = { ...permissions, owned_desktop_running: owned, platform: process.platform };
    if (!permissions.accessibility || !permissions.screen_capture || !owned) {
      result.outcome = "error"; result.verdict = "UNVERIFIED";
      result.error = { code: "observer_unavailable", message: "Native control requires Accessibility, screen capture and a running sandbox-owned desktop; see diagnostics" };
    } else result.verdict = "PASS";
  } catch (error) { result.outcome = "error"; result.verdict = "UNVERIFIED"; result.error = { code: "observer_unavailable", message: String(error) }; }
  result.finished_at = new Date().toISOString(); return result;
}
