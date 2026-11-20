import { renderUninstall } from "../install/index";
import type { Result } from "../commands/types";
import type { Ctx } from "../types";
import { uninstallPlugin } from "./install";
import { installOrcaPanel, resolveOrcaPanelDir, statusOrcaPanel, uninstallOrcaPanel, updateOrcaPanel } from "./orca-panel-cli";

const USAGE = "usage: pacer plugin install | update | status | uninstall   (pacer's own Orca panel plugin; no arguments)";

/** `pacer plugin install|update|status|uninstall` shells out to the `orca` CLI for pacer's bundled panel plugin only. */
export async function pluginCli(args: string[], ctx: Ctx): Promise<Result> {
  const [verb] = args;
  if (args.length !== 1 || (verb !== "install" && verb !== "update" && verb !== "status" && verb !== "uninstall")) {
    return { code: 2, out: "", err: USAGE };
  }
  try {
    if (verb === "install" || verb === "update") {
      const r = verb === "install" ? await installOrcaPanel(ctx.run, resolveOrcaPanelDir()) : await updateOrcaPanel(ctx.run);
      if (r.ok) return { code: 0, out: `pacer panel plugin ${verb === "install" ? "installed in" : "updated in"} Orca`, err: "" };
      const approve = "needsApprove" in r && r.needsApprove
        ? ` Approve the plugin in Orca (fingerprint ${r.needsApprove}), then retry.`
        : "";
      return { code: approve ? 3 : 1, out: "", err: `pacer: orca plugin ${verb} failed: ${r.error}${approve}` };
    }
    if (verb === "status") {
      const s = await statusOrcaPanel(ctx.run);
      const out = s.installed
        ? `pacer panel plugin: installed${s.enabled === false ? " (disabled)" : ""}${s.version ? ` (version ${s.version})` : ""}`
        : "pacer panel plugin: not installed in Orca";
      return { code: s.installed ? 0 : 1, out, err: "" };
    }
    // Uninstall: best-effort `orca plugin uninstall` first, then the legacy cleanup always
    // runs, so pre-0.5.0 leftovers and a current install go in one command.
    const lines: string[] = [];
    const orca = await uninstallOrcaPanel(ctx.run);
    lines.push(orca.ok ? "Orca: the Pacer panel plugin is uninstalled (or was not installed)" : `orca plugin uninstall failed: ${orca.error}`);
    const legacy = await uninstallPlugin(ctx);
    if (legacy) lines.push(renderUninstall(legacy));
    if (orca.ok || legacy) return { code: 0, out: lines.join("\n"), err: "" };
    return { code: 1, out: "", err: "pacer: the Orca plugin is not installed" };
  } catch (e) { return { code: 1, out: "", err: `pacer: ${e instanceof Error ? e.message : String(e)}` }; }
}
