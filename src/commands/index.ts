import { COMMANDS as DISPATCH } from "./dispatch";
import { watchCommand, WATCH_USAGE } from "./watch";
import { COMMANDS as DESKTOP_UPDATE } from "./desktop-update";
import { COMMANDS as PLAN2B } from "./plan2b";
import { COMMANDS as PLAN3 } from "./plan3";
import { COMMANDS as PLAN4 } from "./plan4";
import { COMMANDS as PLAN5 } from "./plan5";
import { COMMANDS as PLAN6 } from "./plan6";
import { COMMANDS as PLAN7 } from "./plan7";
import { COMMANDS as SERVICE } from "./service";
import { COMMANDS as OPEN } from "./open";
import { COMMANDS as PLUGINS } from "./plugins";
import { COMMANDS as SESSIONS } from "./session";
import type { Command } from "./types";

export const EXTRA_COMMANDS: Command[] = [...DISPATCH, ...PLAN2B, ...PLAN3, ...PLAN4, ...PLAN5, ...PLAN6, ...PLAN7, ...SERVICE, ...OPEN, ...DESKTOP_UPDATE, ...PLUGINS, ...SESSIONS, { name: "watch", usage: WATCH_USAGE, run: watchCommand }];

export function findCommand(name: string): Command | undefined {
  return EXTRA_COMMANDS.find((c) => c.name === name);
}
