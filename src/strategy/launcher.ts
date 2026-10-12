import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { parseOrcaOutput } from "../exec/orca/client";
import { isObj } from "../util";
import { loadStrategy } from "../config/strategy";
import { computeStatus } from "../engine/status";
import { renderText } from "../render/text";
import { show } from "./service";
import type { Ctx } from "../types";
export async function build(ctx:Ctx,opts:{agent?:string;from?:string;brief?:string;worktree?:string}={}) {
  if(!/^[A-Za-z0-9/._-]+$/.test(ctx.pacerHome))throw new Error("brief path contains unsafe characters; use a safe pacerHome");
  const strategy=loadStrategy(ctx), agent=opts.agent??strategy.planner;
  if(!["claude-code","codex"].includes(agent) || !(agent===strategy.planner || Object.hasOwn(strategy.providers,agent))) throw new Error("agent must be a configured planner: claude-code or codex");
  if((opts.brief?.length??0)>2000) throw new Error("brief must be at most 2000 characters");
  const base=show(ctx,opts.from??strategy.name), id=`${Math.floor(ctx.now*1000)}-${randomBytes(2).toString("hex")}`, path=join(ctx.pacerHome,"link","sessions",`${id}.md`);
  if(!/^[A-Za-z0-9/._-]+$/.test(path))throw new Error("brief path contains unsafe characters; use a pacerHome containing only A-Za-z0-9/._-");
  mkdirSync(join(ctx.pacerHome,"link","sessions"),{recursive:true});
  writeFileSync(path,`# Build a pacer strategy\n\n${opts.brief??"Ask what the user wants the strategy to do."}\n\nBase: ${opts.from??strategy.name}\n${base.summary}\n\n\`\`\`yaml\n${base.yaml}\n\`\`\`\n\nCurrent status:\n${renderText(await computeStatus(ctx,strategy))}\n\nUse the pacer MCP strategy tools. Preview first. Ask clarifying questions. Show the user the current and draft ranking change. Save only after explicit approval, with a reason and who: ${agent}. Never switch strategies.\n`);
  const command=`${agent==="claude-code"?"claude":"codex"} "$(cat '${path}')"`;
  if(!ctx.which("orca"))return {opened:false,path,command,message:`Orca unavailable. Run: ${command}`};
  const r=await ctx.run(["orca","terminal","create","--worktree",opts.worktree??"active","--title","pacer strategy","--command",command,"--json"],30000);
  const reply=parseOrcaOutput(r.stdout);
  if(r.code!==0 || !isObj(reply) || reply.ok!==true)throw new Error(`could not open strategy session: ${r.stderr||r.stdout}`);
  return {opened:true,path,command,message:"Session opened in a new terminal"};
}
