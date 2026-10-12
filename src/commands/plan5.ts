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
    usage: usage("update [--check] [--to <v>] [--base <url>]", "replace this binary with a newer release"),
    run: async (args, ctx) => {
      const o = parseUpdateArgs(args);
      if (typeof o === "string") return { code: 2, out: "", err: o };
      return runUpdate(o, defaultUpdateDeps(ctx));
    },
  },
];
