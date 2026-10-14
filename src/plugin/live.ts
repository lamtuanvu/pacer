import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export interface LiveHeartbeat { version: string; pid: number; at: number }
export function readLiveHeartbeat(pacerHome: string, now = Date.now() / 1000): LiveHeartbeat | null {
  try {
    const value = JSON.parse(readFileSync(join(pacerHome, "plugin-live.json"), "utf8"));
    return typeof value.version === "string" && Number.isInteger(value.pid) && typeof value.at === "number" && now >= value.at && now - value.at < 90 ? value : null;
  } catch { return null; }
}
export function writeLiveHeartbeat(pacerHome: string, heartbeat: LiveHeartbeat): void {
  mkdirSync(pacerHome, { recursive: true });
  const path = join(pacerHome, "plugin-live.json"), temp = `${path}.${heartbeat.pid}.tmp`;
  try { writeFileSync(temp, JSON.stringify(heartbeat)); renameSync(temp, path); }
  finally { try { unlinkSync(temp); } catch {} }
}
export function removeLiveHeartbeat(pacerHome: string, pid: number): void {
  try { const path = join(pacerHome, "plugin-live.json"); if (JSON.parse(readFileSync(path, "utf8")).pid === pid) unlinkSync(path); } catch {}
}
