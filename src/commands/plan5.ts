import { isExecutorSession } from "../install/role";
import { ownerRefusal } from "../install/owner";
import { releaseOwnership } from "../install/ownership-handback";
import { UPGRADE_CLI_REFUSAL } from "../service/upgrade";
import { checkUpdateReport } from "../update/check";
import { defaultUpdateDeps, parseUpdateArgs, runUpdate } from "../update/update";
import { currentVersion } from "../update/version";
import type { Command } from "./types";

const usage = (cmd: string, desc: string): string => `${cmd.padEnd(47)}${desc}`;
const printVersion: Command["run"] = () => ({ code: 0, out: `pacer ${currentVersion()}`, err: "" });

/** CLI commands added by Plan 5. Only Plan 5 edits this file. */
export const COMMANDS: Command[] = [
  { name: "version", usage: usage("version", "print the pacer version"), run: printVersion },
  { name: "--version", usage: usage("--version", "same as version"), run: printVersion },
  {
    name: "update",
    usage: usage("update [--check [--json]] [--to <v>] [--base <url>] [--no-restart] [--no-reinstall] [--release-ownership [--force]]", "update binary, refresh integrations, restart the service; running work keeps going"),
    run: async (args, ctx) => {
      const o = parseUpdateArgs(args);
      if (typeof o === "string") return { code: 2, out: "", err: o };
      // --release-ownership performs the handback itself; it must run instead of the deference guard below.
      if (o.releaseOwnership) return releaseOwnership(ctx, { force: !!o.force });
      if (o.check && !o.to) return checkUpdateReport(ctx, o.json, { base: o.base });
      // A guard against accidental self-upgrade from a delegated task, not an authorization boundary.
      if (!o.check && isExecutorSession(ctx)) return { code: 2, out: "", err: `pacer update: ${UPGRADE_CLI_REFUSAL}` };
      if (!o.check) { const refusal = ownerRefusal(ctx, "update"); if (refusal) return refusal; }
      return runUpdate(o, defaultUpdateDeps(ctx));
    },
  },
];
