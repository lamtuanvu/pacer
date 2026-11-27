/** Says a verdict's outcome politely, and keeps focus on the page when the decided item leaves it. */
import type { Action } from "../../../src/attention/types";
import { verdictAnnouncement } from "../../../src/view-model/run-gate";

const REGION = "pc-announce", WATCH_MS = 200, WATCHES = 50;

function announce(text: string, doc: Document): void {
  let region = doc.getElementById(REGION);
  if (!region) {
    region = doc.createElement("div");
    region.id = REGION;
    region.className = "sr-only";
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    doc.body.append(region);
  }
  // A region speaks on change: clear it first, so the same words are said again.
  region.textContent = "";
  const spoken = region;
  setTimeout(() => { spoken.textContent = text; }, 50);
}

/** Moves focus that fell to the body to the page's main region; true when it did. */
export function keepFocus(doc: Document): boolean {
  const active = doc.activeElement as (Element & { isConnected?: boolean }) | null;
  if (active && active !== doc.body && active.isConnected !== false) return false;
  const main = doc.querySelector<HTMLElement>("main");
  if (!main) return false;
  if (!main.hasAttribute("tabindex")) main.tabIndex = -1;
  main.focus({ preventScroll: true });
  return true;
}

/** After a verdict the service recorded. The item can leave the page a little later. */
export function afterVerdict(action: Pick<Action, "label" | "op" | "params">): void {
  const text = verdictAnnouncement(action);
  if (!text || typeof document === "undefined") return;
  const doc = document;
  announce(text, doc);
  let checks = 0;
  const watch = setInterval(() => { if (keepFocus(doc) || ++checks >= WATCHES) clearInterval(watch); }, WATCH_MS);
}
