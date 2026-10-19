import type { UpdateStatus } from "../update/desktop/types";
import type { Status } from "./words";

export type DesktopAction = Exclude<UpdateStatus["actions"][number], "retry">;
const labels: Record<DesktopAction, string> = { check: "Check for updates", download: "Download update", restart: "Restart to update", cancel: "Cancel update", configure: "Download updates automatically", adopt: "Use the desktop service", adoptCancel: "Cancel service change" };
export type DesktopUpdateView = Status & { detail: string; primary: string | null; action: DesktopAction | null; cancellable: boolean };

/** Presentation never grants authority: every control still needs an advertised action. */
export function desktopUpdateView(update: UpdateStatus): DesktopUpdateView {
  const states: Record<UpdateStatus["phase"], [string, Status["tone"], string, string]> = {
    idle: [update.target ? "Update available" : update.checkedAt === null ? "Not checked" : "Up to date", update.target ? "info" : "neutral", update.target ? "↓" : update.checkedAt === null ? "…" : "✓", update.target ? "An update is available to download." : "Check for a newer version of pacer."],
    checking: ["Checking for updates", "info", "…", "Looking for a new version."],
    downloading: ["Downloading update", "info", "↓", update.totalBytes && update.totalBytes > 0 ? `${Math.min(100, Math.max(0, Math.floor(update.downloadedBytes / update.totalBytes * 100)))}% downloaded. You can keep working.` : "Downloading the update. You can keep working."],
    ready: ["Update ready", "info", "↑", "The update is downloaded. Restart when you're ready."],
    waiting: ["Waiting for work to finish", "warn", "…", "The update will start after active work and sessions finish. You can cancel while it waits."],
    reserved: ["Preparing update", "info", "…", "Installation has started. Cancellation is no longer available."],
    installing: ["Installing update", "info", "…", "pacer will restart when installation finishes. Cancellation is no longer available."],
    verifying: ["Starting the updated app", "info", "…", "Checking that the updated app and service are ready."],
    complete: ["Updated", "good", "✓", "The updated app is ready."],
    "rolling-back": ["Restoring the previous version", "warn", "…", "The update couldn't start. Restoring your previous version."],
    restored: ["Previous version restored", "warn", "!", "The update couldn't start. Your previous version has been restored."],
    error: ["Update needs attention", "bad", "!", update.error?.message || "The update couldn't finish. Check again when you're ready."],
    "recovery-failed": ["Recovery needs attention", "bad", "!", "The previous version could not be restored automatically. Keep your data and update recovery files in place. Quit the desktop and report the failed update at github.com/lamtuanvu/pacer/issues."],
  };
  let [label, tone, glyph, detail] = states[update.phase] ?? ["Update status unavailable", "neutral", "?", "Refresh the status or use a compatible desktop app."];
  if (update.ownership === "attached" && update.phase === "idle" && update.actions.length === 0) detail = "This desktop is connected to an externally managed service. Update that service separately.";
  const adoption = update.adoption;
  if (update.ownership === "attached" && adoption && ["available", "cancelled"].includes(adoption.phase) && update.actions.includes("adopt")) {
    [label, tone, glyph, detail] = ["Externally managed service", "neutral", "…", "Use the bundled service to let the desktop manage this installation and enable desktop updates."];
  }
  if (adoption && adoption.phase !== "available" && adoption.phase !== "cancelled" && (!["committed", "restored"].includes(adoption.phase) || (["idle", "complete"].includes(update.phase) && !update.target))) {
    const states: Record<typeof adoption.phase, [string, Status["tone"], string, string]> = {
      waiting: ["Waiting to switch services", "warn", "…", "The service will change after active work and sessions finish. You can cancel while it waits."],
      reserved: ["Preparing service change", "info", "…", "The service change has started. Cancellation is no longer available."],
      installing: ["Switching services", "info", "…", "pacer is switching to the bundled desktop service."],
      verifying: ["Checking the desktop service", "info", "…", "Checking the new service and reconnecting this desktop."],
      committed: ["Desktop service is ready", "good", "✓", "The desktop now manages this service. Your tasks and settings are preserved."],
      restored: ["Previous service restored", "warn", "!", "The service change could not finish. The original service has been restored."],
      "recovery-failed": ["Service recovery needs attention", "bad", "!", "The original service could not be restored automatically. Keep your data and recovery files in place and report the problem at github.com/lamtuanvu/pacer/issues."],
    };
    [label, tone, glyph, detail] = states[adoption.phase] ?? ["Service status unavailable", "neutral", "?", "Refresh the service status."];
  }
  const action = (["adoptCancel", "cancel", "restart", "download", "adopt", "check"] as DesktopAction[]).find(action => update.actions.includes(action)) ?? null;
  return { label, tone, glyph, detail, action, primary: action ? labels[action] : null, cancellable: update.actions.includes("cancel") || update.actions.includes("adoptCancel") };
}

export function desktopUpdateAction(status: UpdateStatus, action: DesktopAction, requestId: string, options: { autoDownload?: boolean } = {}) {
  if (!status.actions.includes(action)) throw new Error("This update action is no longer available. Refresh its status.");
  const params: Record<string, string | number | boolean> = { installationId: status.installationId, requestId, expectRevision: status.revision };
  if (action === "adoptCancel") {
    if (!status.adoption) throw new Error("No service change is available to cancel.");
    params.expectRevision = status.adoption.revision;
  }
  if (action === "adopt") desktopAdoptionConfirmation(status);
  if (action === "restart") { if (!status.target) throw new Error("No downloaded version is available."); params.version = status.target; }
  if (action === "configure") { if (typeof options.autoDownload !== "boolean") throw new Error("Choose whether to download updates automatically."); params.autoDownload = options.autoDownload; }
  return { label: labels[action], op: `desktop.update.${action}`, params };
}

/** An uncertain response may be retried with the same ID; changed intent gets a new ID. */
export function updateIntent(makeId: () => string = () => `ui_${crypto.randomUUID()}`) {
  let previous: { key: string; id: string } | undefined;
  return (status: UpdateStatus, action: DesktopAction, options: { autoDownload?: boolean } = {}) => {
    const key = JSON.stringify([status.installationId, status.revision, status.target, action, options.autoDownload, status.adoption?.revision, status.adoption?.currentServiceExecutable, status.adoption?.replacementServiceExecutable]);
    if (previous?.key !== key) previous = { key, id: makeId() };
    return desktopUpdateAction(status, action, previous.id, options);
  };
}

export function desktopUpdateIndicator(updates: UpdateStatus[] = []) {
  const update = updates.find(item => ["recovery-failed", "error", "restored"].includes(item.phase) || item.adoption?.phase === "recovery-failed") ?? updates.find(item => !["idle", "complete"].includes(item.phase) || item.target || (item.adoption && !["available", "cancelled", "committed"].includes(item.adoption.phase)));
  return update ? { ...desktopUpdateView(update), route: "/settings/updates" } : null;
}

/** Feedback describes one acknowledged revision, never a later transaction. */
export function desktopUpdateFeedback(action: DesktopAction, result: UpdateStatus, current: UpdateStatus): string | null {
  if (result.installationId !== current.installationId || result.revision !== current.revision) return null;
  if (result.adoption?.revision !== current.adoption?.revision) return null;
  if (action === "adoptCancel") return result.adoption?.phase === "cancelled" ? "Service change cancelled." : null;
  if (action === "cancel") return ["idle", "ready", "error", "restored", "complete"].includes(result.phase) ? "Update cancelled. Any completed download is kept." : null;
  if (action === "configure") return "Download preference saved. Restart always needs your permission.";
  return "Request received. Status will update here.";
}

export function desktopAdoptionConfirmation(status: UpdateStatus): string {
  const adoption = status.adoption;
  if (!adoption || !status.actions.includes("adopt") || !["available", "cancelled", "restored"].includes(adoption.phase)) throw new Error("Service adoption is no longer available. Refresh its status.");
  return `Replace ${adoption.currentServiceExecutable} with ${adoption.replacementServiceExecutable} for service ${adoption.serviceLabel} on port ${adoption.port}? The desktop will manage this service. Active work finishes first; tasks, accounts and settings are preserved.`;
}
