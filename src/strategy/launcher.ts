import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { openInTerminal } from "../terminal/open";
import { loadStrategy, PLANNERS } from "../config/strategy";
import { computeStatus } from "../engine/status";
import { renderText } from "../render/text";
import { show } from "./service";
import type { Ctx } from "../types";
import { withWork } from "../update/desktop/admission";
import { withLock } from "../core/lock";
function writeAtomic(path:string,contents:string) {
  const temporary=`${path}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary,contents,{mode:0o600,flag:"wx"});
    renameSync(temporary,path);
  } finally { rmSync(temporary,{force:true}); }
}
export async function build(ctx:Ctx,opts:{agent?:string;from?:string;brief?:string;worktree?:string;request_id?:string}={}, deps:{open?:typeof openInTerminal}={}) {
  if(opts.request_id&&!/^[A-Za-z0-9_-]{1,128}$/.test(opts.request_id)) throw new Error("invalid strategy request ID");
  return withWork(ctx, {kind:"operation", id:"strategy-build", label:"Opening strategy planning session"}, () => opts.request_id
    ? withLock(ctx,`strategy-build-${opts.request_id}`,()=>buildAdmitted(ctx,opts,deps))
    : buildAdmitted(ctx,opts,deps));
}
async function buildAdmitted(ctx:Ctx,opts:{agent?:string;from?:string;brief?:string;worktree?:string;request_id?:string}, deps:{open?:typeof openInTerminal}) {
  const strategy=loadStrategy(ctx), agent=opts.agent??strategy.planner.agent;
  if(!(PLANNERS as readonly string[]).includes(agent)) throw new Error("agent must be a configured planner: " + PLANNERS.join(", "));
  if((opts.brief?.length??0)>2000) throw new Error("brief must be at most 2000 characters");
  const base=show(ctx,opts.from??strategy.name), id=opts.request_id??`${Math.floor(ctx.now*1000)}-${randomBytes(2).toString("hex")}`, path=join(ctx.pacerHome,"link","sessions",`${id}.md`);
  const intentPath=join(ctx.pacerHome,"link","sessions",`${id}.json`);
  const request=JSON.stringify({agent,from:opts.from??strategy.name,brief:opts.brief??"",worktree:opts.worktree??""});
  mkdirSync(join(ctx.pacerHome,"link","sessions"),{recursive:true});
  for(const file of readdirSync(join(ctx.pacerHome,"link","sessions"),{withFileTypes:true})) {
    const old=join(ctx.pacerHome,"link","sessions",file.name);
    if(file.isFile() && file.name.endsWith(".md") && statSync(old).mtimeMs < (ctx.now-7*86400)*1000){rmSync(old);rmSync(old.slice(0,-3)+".json",{force:true});}
  }
  let prompt: string;
  if(opts.request_id&&existsSync(intentPath)) {
    const stored=JSON.parse(readFileSync(intentPath,"utf8")) as {request:string;prompt:string};
    if(stored.request!==request) throw new Error("strategy request ID was used with different details");
    if(typeof stored.prompt!=="string"||!stored.prompt) throw new Error("strategy request prompt is unavailable");
    prompt=stored.prompt;
    if(!existsSync(path)||readFileSync(path,"utf8")!==prompt) writeAtomic(path,prompt);
  } else prompt="";
  if(!prompt) {
    if(opts.request_id&&!existsSync(intentPath)) {
      // Recover an interrupted older write; no terminal was launched before the intent file.
      rmSync(path,{force:true});
    }
    prompt=`# Build a pacer strategy\n\n${opts.brief??"Ask what the user wants the strategy to do."}\n\nBase: ${opts.from??strategy.name}\n${base.summary}\n\n\`\`\`yaml\n${base.yaml}\n\`\`\`\n\nCurrent status:\n${renderText(await computeStatus(ctx,strategy))}\n\nUse the pacer MCP strategy tools. Preview first. Ask clarifying questions. Show the user the current and draft ranking change. Save only after explicit approval, with a reason and who: ${agent}. Never switch strategies.\n`;
    if(opts.request_id) writeAtomic(intentPath,JSON.stringify({request,prompt}));
    writeAtomic(path,prompt);
  }
  const argv=agent==='opencode'?['opencode','run','--standalone','--auto',prompt]
    : agent==='claude-code'?['claude','--dangerously-skip-permissions','--',prompt]
    : agent==='cursor'?['cursor-agent','--force','--sandbox','disabled','--',prompt]
    : ['codex','--no-daemon','--dangerously-bypass-approvals-and-sandbox','--',prompt];
  const result=await (deps.open ?? openInTerminal)(ctx,{argv,title:'pacer strategy',worktree:opts.worktree,requestId:opts.request_id});
  return {...result,path,message:result.opened?'Session opened in a new terminal':`Run: ${result.command}`};
}
