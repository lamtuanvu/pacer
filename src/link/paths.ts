import { join } from "node:path";
import type { Ctx } from "../types";
import { PLUGIN_KEY } from "./envelope";
export const PLUGIN_RECORD = "orca-plugin";
export const linkDir = (ctx: Pick<Ctx,"pacerHome">) => join(ctx.pacerHome,"link");
export const latestPath = (ctx: Pick<Ctx,"pacerHome">) => join(linkDir(ctx),"latest.json");
export const outboxPath = (ctx: Pick<Ctx,"pacerHome">) => join(linkDir(ctx),"outbox.jsonl");
export const consolePath = (ctx: Pick<Ctx,"pacerHome">) => join(linkDir(ctx),"console.json");
export const channelPath = (ctx: Pick<Ctx,"pacerHome">) => join(linkDir(ctx),"channel.json");
/** Orca's Electron userData dir. F10: verified on darwin; linux/win32 follow the Electron default. */
export function orcaUserDataDir(ctx: Pick<Ctx,"home"|"env">, platform: NodeJS.Platform = process.platform): string {
  if(ctx.env.PACER_ORCA_USER_DATA) return ctx.env.PACER_ORCA_USER_DATA;
  if(platform==="darwin") return join(ctx.home,"Library","Application Support","orca");
  if(platform==="win32") return join(ctx.env.APPDATA??join(ctx.home,"AppData","Roaming"),"orca");
  return join(ctx.env.XDG_CONFIG_HOME??join(ctx.home,".config"),"orca");
}
export const pluginDataDir = (ctx: Pick<Ctx,"home"|"env">, platform?: NodeJS.Platform) => join(orcaUserDataDir(ctx,platform),"plugins-data",PLUGIN_KEY);
