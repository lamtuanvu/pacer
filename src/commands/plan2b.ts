import { orcaStatus, renderOrcaStatus } from "../exec/orca/status";
import type { Command } from "./types";

const USAGE = "usage: pacer orca status [--json]";

const orcaCommand: Command = {
  name: "orca",
  usage: `${"orca status [--json]".padEnd(47)}Orca runtime, bound run and live pacer workers`,
  run: async (args, ctx) => {
    if (args[0] !== "status") return { code: 2, out: "", err: USAGE };
    const r = await orcaStatus(ctx);
    return { code: 0, out: args.includes("--json") ? JSON.stringify(r, null, 1) : renderOrcaStatus(r), err: "" };
  },
};

/** CLI commands added by Plan 2b. Only Plan 2b edits this file. */
export const COMMANDS: Command[] = [orcaCommand];
