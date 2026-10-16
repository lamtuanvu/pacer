import { join } from "node:path";

export const PANEL_OWNER_MARKER = ".pacer-panel-serve.json";
/** The worker resumes rendering if serve disappears, even after an unclean exit. */
export function serveOwnsPanel(root: string, readText: (path: string) => string | null, nowS: number): boolean {
  try {
    const marker = JSON.parse(readText(join(root, PANEL_OWNER_MARKER)) ?? "null");
    return typeof marker?.at === "number" && Number.isFinite(marker.at) && nowS >= marker.at && nowS - marker.at < 60;
  } catch { return false; }
}
