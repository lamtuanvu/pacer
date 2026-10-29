/** Fixed managed-upgrade user flow; automatic downloading is a separate observation. */
import type { UpdateStatus } from "../../src/update/desktop/types";
interface CandidateDriver {
  mutate(action: "configure" | "check" | "download", extra?: Record<string, unknown>): Promise<void>;
  waitStatus(predicate: (status: UpdateStatus) => boolean, timeout: number): Promise<UpdateStatus>;
}
export async function prepareManualCandidate(driver: CandidateDriver): Promise<void> {
  // Each mutation still passes the normal public request and native ownership gates.
  await driver.mutate("configure", { autoDownload: false });
  await driver.waitStatus(value => value.actions.includes("check"), 60000);
  await driver.mutate("check");
  const checked = await driver.waitStatus(value => value.target === "0.2.4"
    && (value.phase === "ready" || value.actions.includes("download")), 60000);
  if (checked.phase !== "ready") {
    await driver.mutate("download");
    await driver.waitStatus(value => value.phase === "ready" && value.target === "0.2.4", 90000);
  }
}
