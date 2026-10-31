/** Per-device appearance preference, shared by every page on this origin. */
export const DENSITY_KEY = "pacer.density";
export type DensityChoice = "normal" | "compact";
export function savedDensity(): DensityChoice {
  try { return localStorage.getItem(DENSITY_KEY) === "compact" ? "compact" : "normal"; }
  catch { return "normal"; }
}
export function applyDensity(value: DensityChoice, root: HTMLElement = document.documentElement) {
  root.dataset.density = value;
}
