import { mkdirSync, writeFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { openInTerminal } from "../terminal/open";
import { loadStrategy, PLANNERS } from "../config/strategy";
import { computeStatus } from "../engine/status";
import { renderText } from "../render/text";
import { show } from "./service";
import type { Ctx } from "../types";
import { withWork } from "../update/desktop/admission";
export async function build(ctx:Ctx,opts:{agent?:string;from?:string;brief?:string;worktree?:string}={}, deps:{open?:typeof openInTerminal}={}) {
  return withWork(ctx, {kind:"operation", id:"strategy-build", label:"Opening strategy planning session"}, () => buildAdmitted(ctx,opts,deps));
}
async function buildAdmitted(ctx:Ctx,opts:{agent?:string;from?:string;brief?:string;worktree?:string}, deps:{open?:typeof openInTerminal}) {
  const strategy=loadStrategy(ctx), agent=opts.agent??strategy.planner.agent;
  if(!(PLANNERS as readonly string[]).includes(agent)) throw new Error("agent must be a configured planner: " + PLANNERS.join(", "));
  if((opts.brief?.length??0)>2000) throw new Error("brief must be at most 2000 characters");
  const base=show(ctx,opts.from??strategy.name), id=`${Math.floor(ctx.now*1000)}-${randomBytes(2).toString("hex")}`, path=join(ctx.pacerHome,"link","sessions",`${id}.md`);
  mkdirSync(join(ctx.pacerHome,"link","sessions"),{recursive:true});
  for(const file of readdirSync(join(ctx.pacerHome,"link","sessions"),{withFileTypes:true})) {
    const old=join(ctx.pacerHome,"link","sessions",file.name);
    if(file.isFile() && file.name.endsWith(".md") && statSync(old).mtimeMs < (ctx.now-7*86400)*1000)rmSync(old);
  }
  const prompt=`# Build a pacer strategy\n\n${opts.brief??"Ask what the user wants the strategy to do."}\n\nBase: ${opts.from??strategy.name}\n${base.summary}\n\n\`\`\`yaml\n${base.yaml}\n\`\`\`\n\nCurrent status:\n${renderText(await computeStatus(ctx,strategy))}\n\nUse the pacer MCP strategy tools. Preview first. Ask clarifying questions. Show the user the current and draft ranking change. Save only after explicit approval, with a reason and who: ${agent}. Never switch strategies.\n`;
  writeFileSync(path,prompt,{mode:0o600,flag:"wx"});
  const argv=agent==='opencode'?['opencode','run',prompt]:[agent==='claude-code'?'claude':agent==='cursor'?'cursor-agent':'codex',prompt];
  const result=await (deps.open ?? openInTerminal)(ctx,{argv,title:'pacer strategy',worktree:opts.worktree});
  return {...result,path,message:result.opened?'Session opened in a new terminal':`Run: ${result.command}`};
}
