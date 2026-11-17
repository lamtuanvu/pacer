import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../fsutil";
import { pluginDataDir } from "../link/paths";
import type { Ctx } from "../types";
import { CoreError, toCoreError } from "./errors";

export type NotificationLevel = "off" | "important" | "all";
const levels = ["off", "important", "all"];
export type NotificationSound = "pacer" | "default" | "off";
const sounds = ["pacer", "default", "off"];
export type Notifications = {level: NotificationLevel; sound: NotificationSound};
function ownLevel(settings: Record<string,unknown>): NotificationLevel | undefined {
  const own = settings.notifications;
  return typeof own === "string" && levels.includes(own) ? own as NotificationLevel : undefined;
}
function ownSound(settings: Record<string,unknown>): NotificationSound | undefined {
  const own = settings.notificationSound;
  return typeof own === "string" && sounds.includes(own) ? own as NotificationSound : undefined;
}
export function getLevel(ctx: Ctx): Notifications {
  const file=join(ctx.pacerHome,"settings.json");
  const settings=readJson<Record<string,unknown>>(file) ?? {};
  const sound=ownSound(settings) ?? "pacer";
  const own=ownLevel(settings);
  if(own) return {level:own,sound};
  const legacy=readJson<{notifications?:NotificationLevel}>(join(pluginDataDir(ctx),"settings.json"))?.notifications;
  const value=legacy && levels.includes(legacy) ? legacy : "important";
  writeJsonAtomic(file,{...settings,notifications:value});
  return {level:value,sound};
}
/** Write only the present key(s); the absent one keeps its effective pre-write value. */
export function setNotifications(ctx: Ctx, {level, sound}:{level?:NotificationLevel; sound?:NotificationSound}): Notifications {
  if (level === undefined && sound === undefined) throw new CoreError("invalid_input", "provide level or sound", "set level, sound or both");
  if (level !== undefined && !levels.includes(level)) throw new CoreError("invalid_input", "notifications must be off, important or all", `choose ${levels.join(', ')}`);
  if (sound !== undefined && !sounds.includes(sound)) throw new CoreError("invalid_input", "notificationSound must be pacer, default or off", `choose ${sounds.join(', ')}`);
  try {
    const file=join(ctx.pacerHome,"settings.json");
    const settings=readJson<Record<string,unknown>>(file) ?? {};
    const next={...settings};
    if(level !== undefined) next.notifications=level;
    if(sound !== undefined) next.notificationSound=sound;
    writeJsonAtomic(file,next);
    return {level: level ?? ownLevel(settings) ?? "important", sound: sound ?? ownSound(settings) ?? "pacer"};
  } catch(e) { throw toCoreError(e); }
}
export function setLevel(ctx: Ctx, level: NotificationLevel): Notifications {
  return setNotifications(ctx,{level});
}
export function setSound(ctx: Ctx, sound: NotificationSound): Notifications {
  return setNotifications(ctx,{sound});
}
