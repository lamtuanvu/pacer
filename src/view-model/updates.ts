import type { UpdateStatus } from "../update/desktop/types";
import type { Status } from "./words";

export type DesktopAction = Exclude<UpdateStatus["actions"][number], "retry">;
const labels: Record<DesktopAction, string> = { check: "Check for updates", download: "Download update", restart: "Restart to update", cancel: "Cancel update", configure: "Download updates automatically", adopt: "Use the desktop service" };
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
  const action = (["cancel", "restart", "download", "adopt", "check"] as DesktopAction[]).find(action => update.actions.includes(action)) ?? null;
  return { label, tone, glyph, detail, action, primary: action ? labels[action] : null, cancellable: update.actions.includes("cancel") };
}

export function desktopUpdateAction(status: UpdateStatus, action: DesktopAction, requestId: string, options: { autoDownload?: boolean } = {}) {
  if (!status.actions.includes(action)) throw new Error("This update action is no longer available. Refresh its status.");
  const params: Record<string, string | number | boolean> = { installationId: status.installationId, requestId, expectRevision: status.revision };
  if (action === "restart") { if (!status.target) throw new Error("No downloaded version is available."); params.version = status.target; }
  if (action === "configure") { if (typeof options.autoDownload !== "boolean") throw new Error("Choose whether to download updates automatically."); params.autoDownload = options.autoDownload; }
  return { label: labels[action], op: `desktop.update.${action}`, params };
}

/** An uncertain response may be retried with the same ID; changed intent gets a new ID. */
export function updateIntent(makeId: () => string = () => `ui_${crypto.randomUUID()}`) {
  let previous: { key: string; id: string } | undefined;
  return (status: UpdateStatus, action: DesktopAction, options: { autoDownload?: boolean } = {}) => {
    const key = JSON.stringify([status.installationId, status.revision, status.target, action, options.autoDownload]);
    if (previous?.key !== key) previous = { key, id: makeId() };
    return desktopUpdateAction(status, action, previous.id, options);
  };
}

export function desktopUpdateIndicator(updates: UpdateStatus[] = []) {
  const update = updates.find(item => ["recovery-failed", "error", "restored"].includes(item.phase)) ?? updates.find(item => !["idle", "complete"].includes(item.phase) || item.target);
  return update ? { ...desktopUpdateView(update), route: "/settings/updates" } : null;
}

/** Feedback describes one acknowledged revision, never a later transaction. */
export function desktopUpdateFeedback(action: DesktopAction, result: UpdateStatus, current: UpdateStatus): string | null {
  if (result.installationId !== current.installationId || result.revision !== current.revision) return null;
  if (action === "cancel") return ["idle", "ready", "error", "restored", "complete"].includes(result.phase) ? "Update cancelled. Any completed download is kept." : null;
  if (action === "configure") return "Download preference saved. Restart always needs your permission.";
  return "Request received. Status will update here.";
}
