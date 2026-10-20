import { renderUninstall } from "../install/index";
import type { Result } from "../commands/types";
import type { Ctx } from "../types";
import { uninstallPlugin } from "./install";

export const PLUGIN_REMOVED = "pacer no longer ships an Orca plugin; use the pacer desktop app or `pacer open`.";

/** Only cleanup remains: `pacer plugin uninstall` removes what an earlier version installed. */
export async function pluginCli(args: string[], ctx: Ctx): Promise<Result> {
  if (args.length !== 1 || args[0] !== "uninstall") return { code: 2, out: "", err: `pacer: ${PLUGIN_REMOVED} To remove an earlier install, run: pacer plugin uninstall` };
  try {
    const r = await uninstallPlugin(ctx);
    return r ? { code: 0, out: renderUninstall(r), err: "" } : { code: 1, out: "", err: "pacer: the Orca plugin is not installed" };
  } catch (e) { return { code: 1, out: "", err: `pacer: ${e instanceof Error ? e.message : String(e)}` }; }
}
