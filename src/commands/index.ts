import { COMMANDS as PLAN2B } from "./plan2b";
import { COMMANDS as PLAN3 } from "./plan3";
import { COMMANDS as PLAN4 } from "./plan4";
import { COMMANDS as PLAN5 } from "./plan5";
import type { Command } from "./types";

export const EXTRA_COMMANDS: Command[] = [...PLAN2B, ...PLAN3, ...PLAN4, ...PLAN5];

export function findCommand(name: string): Command | undefined {
  return EXTRA_COMMANDS.find((c) => c.name === name);
}
