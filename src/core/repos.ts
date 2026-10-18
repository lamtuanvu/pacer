import { CoreError } from "./errors";
import { withLock } from "./lock";
import { existsSync, statSync } from "node:fs";
import { listTasks } from "../tasks/store";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { readJson, writeJsonAtomic } from "../fsutil";
import { repoKey } from "../config/hosts";
import { realpathSafe } from "./git";
import type { RepoRef } from "../api/read-model/types";
import type { Ctx } from "../types";

interface Entry { key: string; path: string; lastUsed: number }
interface Registry { [path: string]: Entry }
const file = (ctx: Ctx) => join(ctx.pacerHome,"state","repos.json");
const aliasesFile = (ctx: Ctx) => join(ctx.pacerHome,"state","repo-paths.json");
const registry = (ctx: Ctx): Registry => readJson<Registry>(file(ctx)) ?? {};
const canonical = (path: string): string => {
 const p=resolve(path), real=realpathSafe(p);
 if(real!==p || dirname(p)===p)return real;
 return join(canonical(dirname(p)),basename(p));
};
const fallback = (path: string): RepoRef => ({key:`local:${createHash("sha256").update(path).digest("hex").slice(0,12)}`,label:basename(path),path});
export function labelsFor(entries: {key: string; path: string}[]): Map<string,string> {
 const short=(e:{key:string;path:string})=>e.key.startsWith("local:")?basename(e.path):e.key.split("/").slice(1).join("/");
 return new Map(entries.map(e=>[e.key,entries.some(other=>other.key!==e.key && short(other)===short(e)) ? e.key.startsWith("local:")?`${short(e)} (${e.key})`:e.key : short(e)]));
}
// Cleanup is throttled per registry; filtering still applies to every read.
const lastPruned = new Map<string,number>();
function taskRepos(ctx: Ctx): RepoRef[] {
 return listTasks(ctx,Infinity).filter(t=>{
  const last=t.attempts.at(-1),updatedAt=Math.max(t.createdAt,last?.startedAt??0,last?.endedAt??0,t.attemptStartedAt??0);
  return ["queued","running"].includes(t.state)||(!t.dismissed&&updatedAt>=ctx.now-86400);
 }).map(t=>t.repo??repoFor(ctx,t.brief.repo));
}
export function listRepos(ctx: Ctx, snapshotRepos?: RepoRef[]): RepoRef[] {
 const reg=registry(ctx),recent=snapshotRepos??taskRepos(ctx),keys=new Set(recent.map(r=>r.key));
 const stale=Object.keys(reg).filter(path=>!existsSync(reg[path].path)&&!keys.has(reg[path].key));
 const previous=lastPruned.get(file(ctx));
 if(!ctx.readOnly&&(previous===undefined||ctx.now-previous>=60)){
  lastPruned.set(file(ctx),ctx.now);
  if(stale.length){for(const path of stale)delete reg[path];writeJsonAtomic(file(ctx),reg);}
 }
 const excluded=new Set(stale),entries=Object.entries(reg).filter(([path])=>!excluded.has(path)).map(([,entry])=>entry).sort((a,b)=>b.lastUsed-a.lastUsed),labels=labelsFor(entries);
 const seen=new Set<string>();
 return entries.filter(e=>!seen.has(e.key)&&!!seen.add(e.key)).map(e=>({key:e.key,path:e.path,label:labels.get(e.key)!}));
}
function registered(ctx: Ctx,path: string): Entry | undefined {
 const reg=registry(ctx), p=canonical(path),aliases=readJson<Record<string,string>>(aliasesFile(ctx))??{};
 const roots=[...Object.keys(reg),...Object.keys(aliases)].sort((a,b)=>b.length-a.length);
 const root=roots.find(root=>p===root || p.startsWith(root+sep));
 return root ? reg[aliases[root]??root] : undefined;
}
export function repoFor(ctx: Ctx,path: string): RepoRef {
 const e=registered(ctx,path);
 return e ? {key:e.key,path:e.path,label:labelsFor(Object.values(registry(ctx))).get(e.key)!} : fallback(canonical(path));
}
function isDirectory(path: string): boolean {
 try{return statSync(path).isDirectory();}catch{return false;}
}
export async function resolveRepo(ctx: Ctx,path: string): Promise<RepoRef> {
 // A deleted linked checkout can only be identified by the alias saved while it existed.
 if(!isDirectory(path))return repoFor(ctx,path);
 let main=canonical(path),top=main,key:string|null=null;
 try {
  // Identity does not depend on HEAD or status succeeding (e.g. an unborn branch).
  const info=await ctx.run(["git","-C",path,"rev-parse","--path-format=absolute","--show-toplevel","--git-common-dir"],10000);
  const [root,common]=info.stdout.trim().split("\n");
  if(info.code!==0||!root||!common)return repoFor(ctx,path);
  top=canonical(root);main=canonical(dirname(resolve(path,common)));
  const origin=await ctx.run(["git","-C",main,"remote","get-url","origin"],10000);
  if(origin.code===0)key=repoKey(origin.stdout.trim());
 } catch { return repoFor(ctx,path); /* Keep saved identities usable without recording unresolved paths. */ }
 const reg=registry(ctx),known=registered(ctx,top);
 if(top===main&&known&&known.path!==main)return repoFor(ctx,top);
 const entry={key:key??reg[main]?.key??fallback(main).key,path:main,lastUsed:ctx.now};
 reg[main]=entry;
 // Persist linked checkout aliases so arbitrary worktree locations need no git on reads.
 if(top!==main){
  writeJsonAtomic(aliasesFile(ctx),{...readJson<Record<string,string>>(aliasesFile(ctx)),[top]:main});
  delete reg[top];
 }
 writeJsonAtomic(file(ctx),reg);
 return repoFor(ctx,main);
}
export async function backfillRepos(ctx: Ctx,paths: string[]): Promise<void> {
 for(const path of new Set(paths))if(!registered(ctx,path)&&isDirectory(path))await resolveRepo(ctx,path);
}

/** Resolve a picker key without treating it as a relative filesystem path. */
export async function resolveRepoInput(ctx: Ctx, value: string): Promise<RepoRef> {
 if(isAbsolute(value))return resolveRepo(ctx,value);
 const known=listRepos(ctx).find(r=>r.key===value);
 if(known)return known;
 throw new CoreError("invalid_input","repo must be an absolute path or a registered repo key");
}

export async function listReposWithBranches(ctx: Ctx): Promise<(RepoRef & {branches:string[]})[]> {
 return Promise.all(listRepos(ctx).map(async ref=>{
  const current=await ctx.run(["git","-C",ref.path,"symbolic-ref","--quiet","--short","HEAD"],10000);
  const all=await ctx.run(["git","-C",ref.path,"for-each-ref","--format=%(refname:short)","refs/heads/"],10000);
  const branches=[...new Set([...(current.code===0?[current.stdout.trim()]:[]),...(all.code===0?all.stdout.trim().split("\n"):[])].filter(Boolean))].slice(0,50);
  return {...ref,branches};
 }));
}

export async function addRepo(ctx: Ctx, path: string): Promise<RepoRef> {
 if(!isAbsolute(path))throw new CoreError("invalid_input","path must be absolute");
 const result=await ctx.run(["git","-C",path,"rev-parse","--show-toplevel"],10000);
 if(result.code!==0)throw new CoreError("invalid_input","path is not a git repository");
 return withLock(ctx,"repos",async()=>resolveRepo(ctx,path));
}

export async function removeRepo(ctx: Ctx, key: string): Promise<{removed:true}> {
 return withLock(ctx,"repos",async()=>{
  const reg=registry(ctx),removed=new Set(Object.keys(reg).filter(path=>reg[path].key===key));
  for(const path of removed)delete reg[path];
  const aliases=readJson<Record<string,string>>(aliasesFile(ctx))??{};
  for(const [path,main] of Object.entries(aliases))if(removed.has(main))delete aliases[path];
  writeJsonAtomic(file(ctx),reg);writeJsonAtomic(aliasesFile(ctx),aliases);
  return {removed:true};
 });
}
