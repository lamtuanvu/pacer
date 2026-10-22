import { nativeCommand } from "./desktop";
import { acquireLease } from "./lease";
import { resolveDesktopControlBinding, assertSameControlBinding } from "./ota-binding";
import { operationContext } from "./deadline";
import type { Session } from "../core";
import { ControlError, type ControlResult } from "./contract";
export async function desktopDoctor(session: Session, requestAccessibility = false, timeoutMs = 10000): Promise<ControlResult> {
  const result: ControlResult = { schema_version: 1, command_id: crypto.randomUUID(), command: "doctor", started_at: new Date().toISOString(), finished_at: "", outcome: "ok", artifacts: [] };
  // Explicit permission setup retains its existing 190s observer ceiling (180s
  // native prompt). Normal doctor honors the ordinary command's request budget.
  const clock = operationContext(requestAccessibility ? 190000 : timeoutMs), context = clock.context;
  const resolve = () => context.read(() => resolveDesktopControlBinding(session, context));
  try {
    const binding = await resolve();
    let setup: { status?: string; accessibility?: boolean; target_pid?: number } | undefined;
    if (requestAccessibility) {
      context.check();
      const lease = await acquireLease("desktop", { run_id: session.id });
      try {
        assertSameControlBinding(binding, await resolve());
        setup = await context.read(() => nativeCommand({ command: "permission_setup", pid: binding.identity.pid, start_identity: binding.identity.start_identity, timeout_ms: 180000 }, context));
      } finally { await lease.release(); }
    }
    const permissions = await context.read(() => nativeCommand({ command: "doctor" }, context));
    assertSameControlBinding(binding, await resolve());
    result.diagnostics = { ...permissions, owned_desktop_running: true, platform: process.platform, setup };
    const setupVerified = !requestAccessibility || (setup?.status === "verified" && setup.accessibility === true && setup.target_pid === binding.identity.pid);
    if (!permissions.accessibility || !permissions.screen_capture || !setupVerified) {
      result.outcome = "error"; result.verdict = "UNVERIFIED";
      result.error = { code: "observer_unavailable", message: "Native control requires Accessibility, screen capture and a running sandbox-owned desktop; requested setup must verify access to that desktop. See diagnostics" };
    } else result.verdict = "PASS";
  } catch (error) {
    result.outcome = "error"; result.verdict = "UNVERIFIED";
    result.error = { code: error instanceof ControlError ? error.code : "observer_unavailable", message: String(error) };
  } finally { clock.close(); }
  result.finished_at = new Date().toISOString(); return result;
}
