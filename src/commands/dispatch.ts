import { resolve } from "node:path";
import { connectClient } from "../api/client";
import { callOp } from "../api/ops";
import type { DispatchPreview } from "../dispatch/types";
import { commandArgs } from "./accounts";
import type { Command, Result } from "./types";
import type { Ctx } from "../types";

const USAGE = "usage: pacer dispatch preview --repo <repo> --goal <goal> [--kind <kind>] [--model <model>] [--min-tier small|medium|frontier] [--tools] [--json]";
export async function dispatchCmd(args: string[], ctx: Ctx): Promise<Result> {
  try {
    if (args[0] !== "preview") throw Error(USAGE);
    const {pos, flags} = commandArgs(args.slice(1), ["repo", "goal", "kind", "model", "min-tier"], ["json", "tools"]);
    if (pos.length || !flags.repo || !flags.goal) throw Error(USAGE);
    const repo = String(flags.repo);
    const input = {repo: repo === "." || repo.startsWith("./") || repo.startsWith("../") ? resolve(repo) : repo, goal: flags.goal, ...(flags.kind ? {kind: flags.kind} : {}), ...(flags.model ? {model: flags.model} : {}),
      requirements: {...(flags["min-tier"] ? {minTier: flags["min-tier"]} : {}), ...(flags.tools ? {tools: true} : {})}};
    const client = await connectClient(ctx, {protocol: 3});
    let preview: DispatchPreview;
    try { preview = client.kind === "inprocess" ? await callOp(ctx, "dispatch.preview", input) as DispatchPreview : await client.call<DispatchPreview>("dispatch.preview", input); }
    finally { client.close(); }
    if (flags.json) return {code: 0, out: JSON.stringify(preview, null, 2), err: ""};
    const lines = [`Engine: ${preview.engine.id}@${preview.engine.version} (${preview.validation})`];
    if (preview.proposal?.state === "ranked") {
      lines.push(`Step: ${preview.proposal.step}`, ...preview.proposal.choices.map((c, i) => `${i + 1}. ${c.id}: ${c.reason}`));
    } else lines.push(`${preview.recommendedAction}: ${preview.proposal?.reason ?? "Decision engine did not return a valid proposal"}`);
    lines.push(...preview.excluded.map(e => `Excluded ${e.id}: ${e.reason}`), ...preview.uncertainty);
    return {code: 0, out: lines.join("\n"), err: ""};
  } catch (e) { return {code: 2, out: "", err: `pacer: ${e instanceof Error ? e.message : String(e)}`}; }
}
export const COMMANDS: Command[] = [{name: "dispatch", usage: "dispatch preview --repo <repo> --goal <goal>    explain model selection without launching", run: dispatchCmd}];
