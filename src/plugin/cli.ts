import { renderUninstall } from "../install/index";
import type { Result } from "../commands/types";
import type { Ctx } from "../types";
import { uninstallPlugin } from "./install";
import {
  installOrcaPanel,
  resolveOrcaPanelDir,
  statusOrcaPanel,
  uninstallOrcaPanel,
  updateOrcaPanel,
} from "./orca-panel-cli";

const USAGE =
  "usage: pacer plugin install [--approve <fingerprint>] | update [--approve <fingerprint>] | status | uninstall\n" +
  "       (pacer's own Orca panel plugin)";

/** Parse `install|update [--approve <fp>]`; anything else is usage. */
function parseVerb(args: string[]): { verb: "install" | "update" | "status" | "uninstall"; approve?: string } | { error: string } {
  const [verb, ...rest] = args;
  if (verb !== "install" && verb !== "update" && verb !== "status" && verb !== "uninstall") {
    return { error: USAGE };
  }
  if (verb === "status" || verb === "uninstall") {
    return rest.length === 0 ? { verb } : { error: USAGE };
  }
  if (rest.length === 0) return { verb };
  if (rest.length === 2 && rest[0] === "--approve" && rest[1]) return { verb, approve: rest[1] };
  return { error: USAGE };
}

function formatApproval(r: { error: string; needsApprove?: string; grants?: { what: string; why: string; description?: string }[] }): string {
  const lines = [`pacer: orca plugin install needs approval: ${r.error}`];
  // Empty / unparseable grants: print Orca's own message only — never an empty list or a blind --approve.
  if (!r.grants?.length) return lines.join("\n");
  lines.push("Orca will let pacer:");
  for (const g of r.grants) lines.push(`  - ${g.what}${g.why && g.why !== g.what ? ` (${g.why})` : ""}`);
  if (r.needsApprove) {
    lines.push(`If you agree, run: pacer plugin install --approve ${r.needsApprove}`);
  }
  return lines.join("\n");
}

/** `pacer plugin install|update|status|uninstall` shells out to the `orca` CLI for pacer's bundled panel plugin only. */
export async function pluginCli(args: string[], ctx: Ctx): Promise<Result> {
  const parsed = parseVerb(args);
  if ("error" in parsed) return { code: 2, out: "", err: parsed.error };
  const { verb, approve } = parsed;
  try {
    if (verb === "install" || verb === "update") {
      const r = verb === "install"
        ? await installOrcaPanel(ctx.run, resolveOrcaPanelDir(ctx.env, ctx.env.PACER_BIN || process.execPath), approve)
        : await updateOrcaPanel(ctx.run, approve);
      if (r.ok) return { code: 0, out: `pacer panel plugin ${verb === "install" ? "installed in" : "updated in"} Orca`, err: "" };
      if (r.needsApprove) {
        return { code: 3, out: "", err: formatApproval(r) };
      }
      return { code: 1, out: "", err: `pacer: orca plugin ${verb} failed: ${r.error}` };
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
