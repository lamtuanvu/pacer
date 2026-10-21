import { nativeCommand } from "./desktop";
import { acquireLease, sameProcess } from "./lease";
import type { Session } from "../core";
import type { ControlResult } from "./contract";
export async function desktopDoctor(session: Session, requestAccessibility = false): Promise<ControlResult> {
  const result: ControlResult = { schema_version: 1, command_id: crypto.randomUUID(), command: "doctor", started_at: new Date().toISOString(), finished_at: "", outcome: "ok", artifacts: [] };
  try {
    let setup: { status?: string; accessibility?: boolean; target_pid?: number } | undefined;
    if (requestAccessibility) {
      if (!session.desktopIdentity || !await sameProcess(session.desktopIdentity)) throw new Error("Launch the sandbox desktop before requesting native validation access");
      const lease = await acquireLease("desktop", { run_id: session.id });
      try {
        setup = await nativeCommand({ command: "permission_setup", pid: session.desktopIdentity.pid, start_identity: session.desktopIdentity.start_identity, timeout_ms: 180000 });
      } finally { await lease.release(); }
    }
    const permissions = await nativeCommand({ command: "doctor" });
    const owned = session.desktopIdentity ? await sameProcess(session.desktopIdentity) : false;
    result.diagnostics = { ...permissions, owned_desktop_running: owned, platform: process.platform, setup };
    const setupVerified = !requestAccessibility || (setup?.status === "verified" && setup.accessibility === true && setup.target_pid === session.desktopIdentity?.pid);
    if (!permissions.accessibility || !permissions.screen_capture || !owned || !setupVerified) {
      result.outcome = "error"; result.verdict = "UNVERIFIED";
      result.error = { code: "observer_unavailable", message: "Native control requires Accessibility, screen capture and a running sandbox-owned desktop; requested setup must verify access to that desktop. See diagnostics" };
    } else result.verdict = "PASS";
  } catch (error) { result.outcome = "error"; result.verdict = "UNVERIFIED"; result.error = { code: "observer_unavailable", message: String(error) }; }
  result.finished_at = new Date().toISOString(); return result;
}
