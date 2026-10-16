import { lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Ctx } from "../types";
import type { LinkSnapshot } from "../link/envelope";
import { renderStatusPage, type StatusView } from "../../orca-plugin/src/panel";
import { LIVE_PANEL, MANAGED_MARKER, pluginDir } from "../plugin/install";
import { PANEL_OWNER_MARKER } from "../plugin/panel-owner";

function managedRoot(ctx: Pick<Ctx, "pacerHome">): string {
  const root = resolve(pluginDir(ctx));
  if (!existsSync(join(root, MANAGED_MARKER)) || lstatSync(root).isSymbolicLink()) throw Error("refused panel write: unmanaged root");
  return root;
}
function atomic(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, text, { encoding: "utf8", flag: "wx" }); renameSync(temporary, path); }
  finally { try { unlinkSync(temporary); } catch { /* renamed or never written */ } }
}
/** No caller may select another destination, including through a panel directory symlink. */
export function writeManagedPanel(ctx: Pick<Ctx, "pacerHome">, path: string, html: string): void {
  const root = managedRoot(ctx), expected = join(root, LIVE_PANEL);
  if (resolve(path) !== expected) throw Error("refused panel write: unexpected path");
  const panel = dirname(expected);
  if (existsSync(panel) && (!lstatSync(panel).isDirectory() || lstatSync(panel).isSymbolicLink())) throw Error("refused panel write: unexpected panel folder");
  mkdirSync(panel, { recursive: true });
  atomic(expected, html);
}

export function createManagedPanelWriter(ctx: Pick<Ctx, "pacerHome">, opts: { nowMs?: () => number; log?: (line: string) => void } = {}) {
  const nowMs = opts.nowMs ?? Date.now, log = opts.log ?? console.log;
  let lastHtml: string | null = null, lastAttempt = -Infinity, lastMarker = -Infinity;
  return { refresh(snapshot: LinkSnapshot, view: StatusView): void {
    if (!existsSync(join(pluginDir(ctx), MANAGED_MARKER))) return;
    const now = nowMs();
    if (now - lastAttempt < 2000) return;
    try {
      // Freeze date formatting to the snapshot: wall-clock ticks must never reload the iframe.
      const html = renderStatusPage(snapshot, { ...view, nowS: snapshot.at });
      if (html !== lastHtml) {
        lastAttempt = now;
        writeManagedPanel(ctx, join(pluginDir(ctx), LIVE_PANEL), html);
        lastHtml = html;
      }
      // Keep ownership alive without touching the panel when its content is unchanged.
      if (now - lastMarker >= 15000) {
        atomic(join(managedRoot(ctx), PANEL_OWNER_MARKER), JSON.stringify({ at: now / 1000 }));
        lastMarker = now;
      }
    } catch (error) {
      lastAttempt = now;
      log(`pacer: could not refresh the Orca panel: ${String(error instanceof Error ? error.message : error).split(/\r?\n/)[0]}`);
    }
  } };
}
