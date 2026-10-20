import { pluginCli } from "../plugin/cli";
import type { Command } from "./types";

const usage = (cmd: string, desc: string): string => `${cmd.padEnd(47)}${desc}`;

/** CLI commands added by Plan 6. Only Plan 6 edits this file. */
export const COMMANDS: Command[] = [
  { name: "plugin", usage: usage("plugin uninstall", "remove the Orca plugin an earlier pacer installed"), run: (args, ctx) => pluginCli(args, ctx) },
];
