import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../fsutil";
import { pluginDataDir } from "../link/paths";
import type { Ctx } from "../types";
import { CoreError, toCoreError } from "./errors";

export type NotificationLevel = "off" | "important" | "all";
const levels = ["off", "important", "all"];
export function getLevel(ctx: Ctx): {level: NotificationLevel} {
  const file=join(ctx.pacerHome,"settings.json");
  const settings=readJson<Record<string,unknown>>(file) ?? {};
  const own=settings.notifications;
  if(typeof own==='string' && levels.includes(own)) return {level:own as NotificationLevel};
  const legacy=readJson<{notifications?:NotificationLevel}>(join(pluginDataDir(ctx),"settings.json"))?.notifications;
  const value=legacy && levels.includes(legacy) ? legacy : "important";
  writeJsonAtomic(file,{...settings,notifications:value});
  return {level:value};
}
export function setLevel(ctx: Ctx, level: NotificationLevel) {
  if (!levels.includes(level)) throw new CoreError("invalid_input", "notifications must be off, important or all", `choose ${levels.join(', ')}`);
  try {
    const file=join(ctx.pacerHome,"settings.json");
    writeJsonAtomic(file,{...readJson<Record<string,unknown>>(file),notifications:level});
    return {level};
  } catch(e) { throw toCoreError(e); }
}
