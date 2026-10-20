import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJson } from "../fsutil";
import type { Ctx } from "../types";
import { PLUGIN_KEY } from "./envelope";
import { pluginDataDir } from "./paths";
export const BRIDGE_KEY="link";
const FILE_MAX=5*1024*1024;
const isObj=(v:unknown):v is Record<string,unknown>=>typeof v==="object"&&v!==null&&!Array.isArray(v);
function updateStore(file:string,mutate:(o:Record<string,unknown>)=>void):string|null {
  let obj:Record<string,unknown>={}; if(existsSync(file)) { const raw=readJson<unknown>(file); if(!isObj(raw))return `refusing to overwrite unreadable ${file}`; obj=raw; }
  mutate(obj); const text=JSON.stringify(obj,null,2); if(Buffer.byteLength(text,"utf8")>FILE_MAX)return `${file} would exceed ${FILE_MAX} bytes`;
  mkdirSync(dirname(file),{recursive:true,mode:0o700}); const tmp=`${file}.pacer-${process.pid}.tmp`; writeFileSync(tmp,text,{mode:0o600});
  try { renameSync(tmp,file); }
  catch (error) { try { rmSync(tmp,{force:true}); } catch { /* preserve the rename error */ } throw error; }
  return null;
}
export function clearBridge(ctx:Ctx,platform?:NodeJS.Platform,key = PLUGIN_KEY):"cleared"|"skipped"|string {
  const file=join(pluginDataDir(ctx,platform,key),"storage.json"); if(!existsSync(file))return "skipped"; return updateStore(file,o=>{delete o[BRIDGE_KEY];})??"cleared";
}
