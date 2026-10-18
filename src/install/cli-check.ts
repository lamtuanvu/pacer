import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ProviderCfg } from "../config/strategy";
import { launchFor } from "../exec/launch";
import { readJson, writeJsonAtomic } from "../fsutil";
import type { Ctx } from "../types";
import type { Check } from "./doctor";

/** Validate exactly the flags our launcher uses, against root and command help. */
export async function executorCliCheck(ctx: Ctx, cfg: ProviderCfg): Promise<Check> {
  const check: Check = {name:`CLI ${cfg.id}`,level:"fail",detail:""};
  try {
    const argv=launchFor(cfg,"PROMPT","/repo","/task-state","doctor").argv;
    const bin=argv[0], command=argv[1] && !argv[1].startsWith("-") ? argv[1] : null;
    const flags=[...new Set(argv.slice(1).filter(a=>/^--?[a-zA-Z][a-zA-Z-]*$/.test(a)))];
    const key=createHash("sha256").update(JSON.stringify([ctx.which(bin),command,flags])).digest("hex");
    const path=join(ctx.pacerHome,"cache",`cli-help-${key}.json`);
    const cached=readJson<{at:number;check:Check}>(path);
    if(cached && ctx.now-cached.at>=0 && ctx.now-cached.at<3600)return {...cached.check,name:check.name};
    const root=await ctx.run([bin,"--help"],5000);
    const sub=command ? await ctx.run([bin,command,"--help"],5000) : root;
    if(root.code!==0 || sub.code!==0) check.detail=`${bin} --help failed: ${(sub.stderr||root.stderr||`exit ${sub.code||root.code}`).slice(0,500)}`;
    else {
      const text=`${root.stdout}\n${root.stderr}\n${sub.stdout}\n${sub.stderr}`;
      const supported=new Set(text.match(/--?[a-zA-Z][a-zA-Z-]*/g)??[]);
      const missing=flags.filter(flag=>!supported.has(flag));
      check.level=missing.length?"fail":"ok";
      check.detail=missing.length?`${bin} help is missing launch flags: ${missing.join(", ")}`:`${bin} launch flags supported`;
    }
    if(!ctx.readOnly)writeJsonAtomic(path,{at:ctx.now,check});
  }catch(e){check.detail=String(e);}
  return check;
}
