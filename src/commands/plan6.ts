import { linkCli } from "../link/cli";
import { pluginCli } from "../plugin/cli";
import type { Command } from "./types";

const usage = (cmd: string, desc: string): string => `${cmd.padEnd(47)}${desc}`;

/** CLI commands added by Plan 6. Only Plan 6 edits this file. */
export const COMMANDS: Command[] = [
  { name: "link", usage: usage("link status|probe", "show or test the brain -> Orca plugin link"), run: (args, ctx) => linkCli(args, ctx) },
  { name: "plugin", usage: usage("plugin install|uninstall|status|set <k> <v>", "manage pacer's Orca plugin"), run: (args, ctx) => pluginCli(args, ctx) },
];
