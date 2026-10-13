import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJson } from "../fsutil";
import { readManifest } from "../install/manifest";
import type { Ctx } from "../types";
import { PLUGIN_KEY } from "./envelope";
import type { LinkSnapshot } from "./envelope";
import { PLUGIN_RECORD, pluginDataDir } from "./paths";
export const BRIDGE_KEY="link";
const VALUE_MAX=256*1024, FILE_MAX=5*1024*1024;
const isObj=(v:unknown):v is Record<string,unknown>=>typeof v==="object"&&v!==null&&!Array.isArray(v);
export function pluginInstalled(ctx:Ctx):boolean { return Boolean(readManifest(ctx).planners[PLUGIN_RECORD]); }
function updateStore(file:string,mutate:(o:Record<string,unknown>)=>void):string|null {
  let obj:Record<string,unknown>={}; if(existsSync(file)) { const raw=readJson<unknown>(file); if(!isObj(raw))return `refusing to overwrite unreadable ${file}`; obj=raw; }
  mutate(obj); const text=JSON.stringify(obj,null,2); if(Buffer.byteLength(text,"utf8")>FILE_MAX)return `${file} would exceed ${FILE_MAX} bytes`;
  mkdirSync(dirname(file),{recursive:true,mode:0o700}); const tmp=`${file}.pacer-${process.pid}.tmp`; writeFileSync(tmp,text,{mode:0o600});
  try { renameSync(tmp,file); }
  catch (error) { try { rmSync(tmp,{force:true}); } catch { /* preserve the rename error */ } throw error; }
  return null;
}
export function writeBridge(ctx:Ctx,snap:LinkSnapshot,platform?:NodeJS.Platform):"written"|"skipped"|string {
  if(!pluginInstalled(ctx))return "skipped"; if(Buffer.byteLength(JSON.stringify(snap),"utf8")>VALUE_MAX)return `snapshot exceeds ${VALUE_MAX} bytes`;
  return updateStore(join(pluginDataDir(ctx,platform),"storage.json"),o=>{o[BRIDGE_KEY]=snap;})??"written";
}
export function clearBridge(ctx:Ctx,platform?:NodeJS.Platform,key = PLUGIN_KEY):"cleared"|"skipped"|string {
  const file=join(pluginDataDir(ctx,platform,key),"storage.json"); if(!existsSync(file))return "skipped"; return updateStore(file,o=>{delete o[BRIDGE_KEY];})??"cleared";
}
export function writePluginSetting(ctx:Ctx,key:string,value:unknown,platform?:NodeJS.Platform):void {
  const err=updateStore(join(pluginDataDir(ctx,platform),"settings.json"),o=>{o[key]=value;}); if(err)throw new Error(err);
}
