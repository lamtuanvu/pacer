import { CoreError } from "./errors";
import { withLock } from "./lock";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { readJson, writeJsonAtomic } from "../fsutil";
import { repoKey } from "../config/hosts";
import { gitInfo, realpathSafe } from "./git";
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
export function listRepos(ctx: Ctx): RepoRef[] {
 const entries=Object.values(registry(ctx)).sort((a,b)=>b.lastUsed-a.lastUsed),labels=labelsFor(entries);
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
export async function resolveRepo(ctx: Ctx,path: string): Promise<RepoRef> {
 let main=canonical(path),top=main,key:string|null=null;
 try {
  const info=await gitInfo(ctx.run,path);
  if (!("error" in info)) { main=canonical(info.main); top=canonical(info.top); }
  const origin=await ctx.run(["git","-C",main,"remote","get-url","origin"],10000);
  if(origin.code===0)key=repoKey(origin.stdout.trim());
 } catch { /* Deleted checkouts retain a stable local identity. */ }
 const reg=registry(ctx), entry={key:key??fallback(main).key,path:main,lastUsed:ctx.now};
 reg[main]=entry;
 // Persist linked checkout aliases so arbitrary worktree locations need no git on reads.
 if(top!==main)writeJsonAtomic(aliasesFile(ctx),{...readJson<Record<string,string>>(aliasesFile(ctx)),[top]:main});
 writeJsonAtomic(file(ctx),reg);
 return repoFor(ctx,main);
}
export async function backfillRepos(ctx: Ctx,paths: string[]): Promise<void> {
 for(const path of new Set(paths))if(!registered(ctx,path))await resolveRepo(ctx,path);
}

/** Resolve a picker key without treating it as a relative filesystem path. */
export async function resolveRepoInput(ctx: Ctx, value: string): Promise<RepoRef> {
 const known=listRepos(ctx).find(r=>r.key===value);
 if(known)return known;
 if(!isAbsolute(value))throw new CoreError("invalid_input","repo must be an absolute path or a registered repo key");
 return resolveRepo(ctx,value);
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
