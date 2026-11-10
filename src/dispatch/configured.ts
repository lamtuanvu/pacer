import type { Strategy } from "../config/strategy";
import { dispatchConfigSchema } from "./types";

/** Model preferences alone do not opt ordinary delegates into managed work. */
export function managedDispatchConfigured(strategy: Pick<Strategy, "dispatch">): boolean {
  if (!strategy.dispatch) return false;
  const { tierTargets: _targets, ...configured } = dispatchConfigSchema.parse(strategy.dispatch);
  const { tierTargets: _defaults, ...defaults } = dispatchConfigSchema.parse({});
  return JSON.stringify(configured) !== JSON.stringify(defaults);
}
