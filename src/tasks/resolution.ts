import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";
import { loadStrategy } from "../config/strategy";
import { validateExecution } from "../config/execution";
import { readTask, updateTask } from "./store";
import type { TaskRecord } from "./types";

/** Compare bytes, including committed worker changes and untracked paths. Failed git reads never resolve work. */
export function resolutionReason(ctx: Ctx, t: TaskRecord): string | null {
  if(t.review)return "reviewed";
  const worktree=t.result?.worktree??t.worktree;
  if(!worktree)return null;
  if(!existsSync(worktree))return "worktree removed";
  // In-place runs have no worker worktree to compare: only a review or dismiss settles them.
  if(t.placement?.mode==="current")return null;
  try{if(realpathSync(worktree)===realpathSync(t.brief.repo))return null;}catch{return null;}
  let root=worktree;
  const git=(...args:string[])=>execFileSync("git",["-C",root,...args],{stdio:["ignore","pipe","ignore"],maxBuffer:16*1024*1024});
  try {
    root=git("rev-parse","--show-toplevel").toString().trim();
    let base=t.baseBranch;
    if(!base){try{base=validateExecution(loadStrategy(ctx).execution).baseBranch??undefined;}catch{}}
    base??=execFileSync("git",["-C",t.brief.repo,"symbolic-ref","--short","HEAD"],{stdio:["ignore","pipe","ignore"]}).toString().trim();
    const tip=git("rev-parse","--verify",`${base}^{commit}`).toString().trim();
    const ancestor=git("merge-base","HEAD",tip).toString().trim();
    const paths=new Set([...git("diff","--name-only","-z",ancestor,"--").toString().split("\0"),...git("ls-files","--others","--exclude-standard","-z").toString().split("\0")].filter(Boolean));
    // An empty diff is a run that produced nothing, not work that landed.
    if(!paths.size)return null;
    for(const path of paths){
      let expected:Buffer|null=null;
      try{expected=git("show",`${tip}:${path}`);}catch{if(git("ls-tree","-z",tip,"--",path).length)return null;}
      const file=join(root,path);
      if(!existsSync(file)){if(expected!==null)return null;continue;}
      if(expected===null||!readFileSync(file).equals(expected))return null;
    }
    return `already on ${base}`;
  }catch{return null;}
}
export function resolveTask(ctx: Ctx, t: TaskRecord): TaskRecord {
  if(t.resolved||!["partial","failed"].includes(t.state))return t;
  if(!t.review && t.resolutionCheckedAt!==undefined && ctx.now-t.resolutionCheckedAt<60)return t;
  const reason=resolutionReason(ctx,t);
  if(!readTask(ctx,t.id))return {...t,resolutionCheckedAt:ctx.now,...(reason?{resolved:reason}:{})};
  updateTask(ctx,t.id,x=>{x.resolutionCheckedAt=ctx.now;if(reason)x.resolved=reason;});
  return {...t,resolutionCheckedAt:ctx.now,...(reason?{resolved:reason}:{})};
}
