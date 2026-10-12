import { currentVersion } from "../update/version";
import type { Command } from "./types";

const usage = (cmd: string, desc: string): string => `${cmd.padEnd(47)}${desc}`;
const printVersion: Command["run"] = () => ({ code: 0, out: `pacer ${currentVersion()}`, err: "" });

/** CLI commands added by Plan 5. Only Plan 5 edits this file. */
export const COMMANDS: Command[] = [
  { name: "version", usage: usage("version", "print the pacer version"), run: printVersion },
  { name: "--version", usage: usage("--version", "same as version"), run: printVersion },
];
