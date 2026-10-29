import { dashboardClient } from "../dashboard/client";
import type { ApiClient } from "../api/client-types";
import type { Ctx } from "../types";
import type { Command, Result } from "./types";

type MachineView = { id: string; name: string; rev: number; cloneSuspected: boolean };
type Rotated = { oldId: string; newId: string };

const usage = "usage: pacer machine show | rename <name> | rotate --yes [--json]";
const COPIED = "This home looks copied from another machine. Run pacer machine rotate --yes to give it its own identity.";
function format(value: MachineView | Rotated): string {
  if ("newId" in value) return `Machine key rotated.\nold id  ${value.oldId}\nnew id  ${value.newId}`;
  return [`name  ${value.name}`, `id    ${value.id}`, `rev   ${value.rev}`, ...(value.cloneSuspected ? [COPIED] : [])].join("\n");
}

export async function machineCmd(args: string[], ctx: Ctx, connect: (ctx: Ctx) => Promise<ApiClient> = dashboardClient): Promise<Result> {
  let client: ApiClient | undefined;
  try {
    const json = args.includes("--json"), yes = args.includes("--yes");
    const [verb = "show", ...rest] = args.filter(a => a !== "--json" && a !== "--yes");
    if (!["show", "rename", "rotate"].includes(verb) || (verb === "rename" ? !rest.length : rest.length) || (yes && verb !== "rotate")) throw Error(usage);
    if (verb === "rotate" && !yes) return { code: 2, out: "", err: "pacer: rotating the machine key replaces this machine's id; paired machines that cannot be told must pair again. Re-run with --yes." };
    client = await connect(ctx);
    let result: MachineView | Rotated;
    if (verb === "show") result = await client.call<MachineView>("machine.get", {});
    else if (verb === "rotate") result = await client.call<Rotated>("machine.rotate", {});
    else {
      const current = await client.call<MachineView>("machine.get", {});
      result = await client.call<MachineView>("machine.set", { name: rest.join(" "), expect_rev: current.rev });
    }
    return { code: 0, out: json ? JSON.stringify(result, null, 2) : format(result), err: "" };
  } catch (error) {
    const hint = error && typeof error === "object" && "hint" in error ? error.hint : undefined;
    return { code: 2, out: "", err: `pacer: ${error instanceof Error ? error.message : String(error)}${hint ? `\n${hint}` : ""}` };
  } finally { client?.close(); }
}

export const machineCommand: Command = { name: "machine", usage: `${"machine show|rename|rotate".padEnd(47)}show, rename or rotate this machine's identity`, run: machineCmd };
export const COMMANDS: Command[] = [machineCommand];
