import type { UpdateStatus } from "../../../src/update/desktop/types";
export function desktopStatus(overrides: Partial<UpdateStatus> = {}): UpdateStatus {
  return { installationId: "desktop-fixture", revision: 1, phase: "idle", transactionId: null, autoDownload: true, checkedAt: null, blockers: [], downloadedBytes: 0, totalBytes: null, error: null, current: "0.2.3", target: null, releaseNotes: null, ownership: "managed", actions: ["check"], ...overrides };
}
export function adoptionStatus(overrides: Partial<NonNullable<UpdateStatus["adoption"]>> = {}): NonNullable<UpdateStatus["adoption"]> {
  return { phase: "available", revision: 0, previousInstallationId: "desktop-fixture", resultingInstallationId: null, currentServiceExecutable: "/opt/pacer/bin/pacer", replacementServiceExecutable: "/Applications/pacer.app/Contents/Resources/pacer", serviceLabel: "com.pacer.serve", port: 7433, blockers: [], error: null, ...overrides };
}
