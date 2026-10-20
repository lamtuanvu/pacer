import { dashboardClient } from "../dashboard/client";
import type { ApiClient } from "../api/client-types";
import type { ProjectStrategyView } from "../core/project-strategies";
import type { Ctx } from "../types";
import { commandArgs } from "./accounts";
import type { Result } from "./types";

const usage = "usage: pacer project strategy list | show --repo <path-or-key> | set --repo <path-or-key> --executors <id,id> | remove --repo <path-or-key> [--json]";
function format(value: ProjectStrategyView): string {
  return [`${value.repo.label} (${value.repo.key}) · revision ${value.rev}`,
    ...(value.executors ? value.executors.map((id, i) => `${i + 1}. ${id}`) : ["Using global strategy"])].join("\n");
}
export async function projectStrategyCmd(args: string[], ctx: Ctx, connect: (ctx: Ctx) => Promise<ApiClient> = dashboardClient): Promise<Result> {
  let client: ApiClient | undefined;
  try {
    const [section, verb, ...rest] = args;
    if (section !== "strategy" || !["list", "show", "set", "remove"].includes(verb)) throw Error(usage);
    const { pos, flags } = commandArgs(rest, ["repo", "executors"], ["json"]);
    if (pos.length || (verb !== "list" && typeof flags.repo !== "string") || (verb === "set" && typeof flags.executors !== "string")) throw Error(usage);
    client = await connect(ctx);
    let result: ProjectStrategyView | ProjectStrategyView[];
    if (verb === "list") result = await client.call("project.strategy.list", {});
    else {
      const current = await client.call<ProjectStrategyView>("project.strategy.get", { repo: flags.repo });
      result = verb === "show" ? current : await client.call(`project.strategy.${verb}`, {
        repo: flags.repo, expect_rev: current.rev,
        ...(verb === "set" ? { executors: String(flags.executors).split(",").map(id => id.trim()).filter(Boolean) } : {}),
      });
    }
    return { code: 0, out: flags.json ? JSON.stringify(result, null, 2) : Array.isArray(result) ? result.map(format).join("\n\n") || "No project overrides; repositories use the global strategy." : format(result), err: "" };
  } catch (error) {
    const hint = error && typeof error === "object" && "hint" in error ? error.hint : undefined;
    return { code: 2, out: "", err: `pacer: ${error instanceof Error ? error.message : String(error)}${hint ? `\n${hint}` : ""}` };
  } finally { client?.close(); }
}
