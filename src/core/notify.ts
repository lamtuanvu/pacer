import { join } from "node:path";
import { readJson } from "../fsutil";
import { pluginInstalled, writePluginSetting } from "../link/bridge";
import { pluginDataDir } from "../link/paths";
import type { Ctx } from "../types";
import { CoreError, toCoreError } from "./errors";

export type NotificationLevel = "off" | "important" | "all";
const levels = ["off", "important", "all"];
export function getLevel(ctx: Ctx): {level: NotificationLevel} {
  const settings = readJson<{notifications?: NotificationLevel}>(join(pluginDataDir(ctx), "settings.json"));
  const value = settings?.notifications;
  return {level: value && levels.includes(value) ? value : "important"};
}
export function setLevel(ctx: Ctx, level: NotificationLevel) {
  if (!levels.includes(level)) throw new CoreError("invalid_input", "notifications must be off, important or all", `choose ${levels.join(', ')}`);
  if (!pluginInstalled(ctx)) throw new CoreError("not_allowed", "the Orca plugin is not installed; run pacer plugin install first", "Call plugin.install first");
  try { writePluginSetting(ctx, "notifications", level); return {level}; } catch (e) { throw toCoreError(e); }
}
