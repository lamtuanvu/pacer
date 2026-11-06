import { existsSync } from "node:fs";
import { join } from "node:path";
import * as config from "../core/config";
import type { Ctx } from "../types";

const terminalApps: Record<string, string> = {
  ghostty: "Ghostty",
  iterm: "iTerm",
  "terminal-app": "Terminal",
};

/** Host-dependent `config.get` fields for native read-model composition. */
export function configHostParts(ctx: Ctx) {
  const result = config.get(ctx);
  const terminalChoices = result.terminalChoices.filter(
    choice =>
      choice.value === "auto"
      || (process.platform === "darwin"
        ? ["/Applications", join(ctx.home, "Applications"), "/System/Applications/Utilities"].some(root =>
          existsSync(join(root, `${terminalApps[choice.value]}.app`)))
        : !!ctx.which(choice.value)),
  );
  return { terminalChoices, machine: result.machine, planners: result.planners };
}
