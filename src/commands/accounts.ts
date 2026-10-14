import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join, resolve, sep, parse } from "node:path";
import { createInterface } from "node:readline/promises";
import { allowedPair, parseSize } from "../config/accounts";
import { isNode, isSeq, type Node } from "yaml";
import { StrategyDoc, editStrategy } from "../config/edit";
import { formatRunnerId, parseRunnerId, resolveRunner, runnerDefaults } from "../config/runner-id";
import { loadStrategy, strategyPath, type Strategy } from "../config/strategy";
import { accountFolder } from "../install/role";
import { readOrcaAccounts } from "../orca/accounts";
import { readAccountUsage } from "../usage";
import type { Ctx } from "../types";
import type { Result } from "./types";

export interface AccountDeps {
  login?: (argv: string[], env: Record<string, string>) => Promise<number>;
  confirm?: (question: string) => Promise<boolean>;
  print?: (line: string) => void;
}
const ok = (out: string): Result => ({code: 0, out, err: ""});
const fail = (e: unknown): Result => ({code: 2, out: "", err: `pacer: ${e instanceof Error ? e.message : String(e)}`});
export function commandArgs(args: string[], values: string[], booleans: string[]) {
  const pos: string[] = [], flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const key = a.slice(2);
    if (Object.hasOwn(flags, key)) throw Error(`duplicate option: ${a}`);
    if (booleans.includes(key)) flags[key] = true;
    else if (values.includes(key) && args[i + 1] && !args[i + 1].startsWith("--")) flags[key] = args[++i];
    else throw Error(`unknown option or missing value: ${a}`);
  }
  return {pos, flags};
}
function docValue(doc: StrategyDoc, path: (string | number)[]): any {
  const value=doc.getIn(path); return isNode(value) ? value.toJSON() : value;
}
export function requireAccounts(strategy: Strategy): void {
  if (strategy.legacy) throw Error("Run pacer config migrate before editing accounts or runners.");
}
export function applyEdit(ctx: Ctx, change: Parameters<typeof editStrategy>[1]): string {
  const result = editStrategy(strategyPath(ctx), change);
  if (!result.ok) throw Error(result.error);
  return result.diff;
}
async function confirmDeletion(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({input: process.stdin, output: process.stdout});
  try { return /^y(?:es)?$/i.test((await rl.question(`${question} [y/N] `)).trim()); }
  finally { rl.close(); }
}
async function loginAgent(ctx: Ctx, argv: string[], env: Record<string,string>): Promise<number> {
  const child = Bun.spawn(argv, {env: {...ctx.env, ...env}, stdin: "inherit", stdout: "inherit", stderr: "inherit"});
  return child.exited;
}
/** A delete-home operation must never remove a shared, default, or symlinked folder. */
function deletionHome(ctx: Ctx, s: Strategy, name: string): string {
  const account = s.accounts[name];
  if (account.source !== "pacer") throw Error("--delete-home is only available for pacer-managed accounts");
  const folder = accountFolder(ctx, account)!;
  if (existsSync(folder) && lstatSync(folder).isSymbolicLink()) throw Error("refusing to delete a symlinked account home");
  const canonical = (p: string) => existsSync(p) ? realpathSync(p) : resolve(p);
  const target = canonical(folder);
  if (target === parse(target).root) throw Error("refusing to delete a protected account home");
  const protectedPaths = [ctx.home, ctx.pacerHome, join(ctx.home,'.claude'), join(ctx.home,'.codex'), ...Object.values(s.accounts).filter(a => a.name !== name).map(a => accountFolder(ctx,a)).filter((p):p is string=>!!p)];
  if (protectedPaths.some(p => {const c=canonical(p); return c===target || c.startsWith(target+sep);})) throw Error("refusing to delete a protected or shared account home");
  return folder;
}

export async function accountCmd(args: string[], ctx: Ctx, deps: AccountDeps = {}): Promise<Result> {
  try {
    const [verb, ...rest] = args;
    const {pos, flags} = commandArgs(rest, verb === "add" ? ["home","orca","usage","quota-source","weekly-tokens"] : [], verb === "list" ? ["json"] : verb === "add" ? ["no-login"] : ["delete-home"]);
    const s = loadStrategy(ctx);
    if (verb === "list" && !pos.length) {
      const orca = await readOrcaAccounts(ctx);
      const rows = await Promise.all(Object.values(s.accounts).map(async a => {
        const runners = Object.values(s.runners).filter(r=>r.account===a.name);
        const identity = a.orcaAccount && (a.kind === "claude" || a.kind === "codex") ? orca?.[a.kind].find(v=>v.id===a.orcaAccount) : undefined;
        const folder = accountFolder(ctx,a);
        const usageReading = await readAccountUsage({...ctx,readOnly:true},a,runners);
        return {...a, label: identity?.label ?? a.name, folder, runners:runners.map(r=>r.id), signedIn: identity ? true : null,
          runnable: a.source !== "orca" || folder !== null, usageReading};
      }));
      return ok(flags.json ? JSON.stringify(rows,null,2) : rows.map(a=>`${a.name} · ${a.kind} · ${a.source} · ${a.folder ?? a.orcaAccount ?? 'default'} · ${a.runners.join(', ') || 'no runners'}${!a.runnable ? ' · usage-only: account folder not found' : ''} · ${a.usageReading.windows.map(w=>`${w.name}: ${w.usedPct ?? '?'}%`).join(', ') || a.usage}`).join('\n'));
    }
    requireAccounts(s);
    if (verb === "add" && pos.length === 2) {
      const [kind,name] = pos;
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw Error("account name must contain lowercase letters, digits and hyphens");
      if (s.accounts[name]) throw Error(`account ${name} already exists`);
      if (!['claude','codex','endpoint'].includes(kind)) throw Error("only claude, codex and endpoint accounts can be added");
      const value: Record<string,unknown> = {kind}; let folder: string | null = null;
      if (flags.orca) {
        if (kind !== 'claude' && kind !== 'codex') throw Error("Orca links require claude or codex");
        if (Object.keys(flags).some(k=>k!=='orca')) throw Error("--orca cannot be combined with home, login or endpoint options");
        const data = await readOrcaAccounts(ctx);
        if (!data?.[kind].some(a=>a.id===flags.orca)) throw Error("Orca account id not found for that kind");
        value.orca_account=flags.orca;
      } else if (kind === 'endpoint') {
        if (flags.home || flags['no-login']) throw Error("endpoint accounts do not have a home or login");
        if (!['quota','metered','unmetered'].includes(String(flags.usage))) throw Error("endpoint requires --usage quota, metered or unmetered");
        value.usage = flags.usage;
        if (flags['quota-source']) {
          if (flags['quota-source'] !== 'arkcli' || flags.usage !== 'quota') throw Error("--quota-source arkcli requires quota usage");
          value.quota_source=flags['quota-source'];
        }
        if (flags['weekly-tokens']) {
          const n=parseSize(flags['weekly-tokens']); if (n===null || !Number.isFinite(n) || n<=0 || flags.usage !== 'metered') throw Error("--weekly-tokens requires a positive metered budget");
          value.budget={weekly_tokens:n};
        }
      } else {
        if (flags.usage || flags['quota-source'] || flags['weekly-tokens']) throw Error("usage options are only supported for endpoints");
        folder=resolve(typeof flags.home==='string' ? flags.home.replace(/^~(?=\/|$)/,ctx.home) : join(ctx.pacerHome,'accounts',name));
        if (existsSync(folder)) throw Error("account home already exists; choose a new folder");
        value.home=folder;
      }
      // Validate before creating a folder; the edit writes no bytes on refusal.
      const diff=applyEdit(ctx,doc=>doc.addMappingEntry('accounts',name,value));
      if (folder) {
        try { mkdirSync(folder,{recursive:true,mode:0o700}); chmodSync(folder,0o700); }
        catch(e) {applyEdit(ctx,doc=>doc.removeMappingEntry('accounts',name)); throw e;}
      }
      const lines=[`Added account ${name}.`, diff];
      if (folder && !flags['no-login']) {
        const message=kind==='claude' ? 'Starting Claude; run /login to sign in, then exit to return to pacer.' : 'Starting codex login.';
        (deps.print ?? console.log)(message); lines.push(message);
        const code=await (deps.login ?? ((argv,env)=>loginAgent(ctx,argv,env)))(kind==='codex'?['codex','login']:['claude'],{[kind==='codex'?'CODEX_HOME':'CLAUDE_CONFIG_DIR']:folder});
        if (code!==0) return {code,out:lines.join('\n'),err:`Login exited ${code}; account ${name} remains configured.`};
      }
      return ok(lines.join('\n'));
    }
    if (verb === 'rm' && pos.length === 1) {
      const name=pos[0],a=s.accounts[name]; if (!a) throw Error(`unknown account: ${name}`);
      if (s.planner.account===name || Object.values(s.runners).some(r=>r.account===name)) throw Error(`account ${name} is in use`);
      const folder=flags['delete-home'] ? deletionHome(ctx,s,name) : null;
      if (folder && !await (deps.confirm ?? confirmDeletion)(`Delete account home ${folder}?`)) throw Error('account removal cancelled');
      const diff=applyEdit(ctx,doc=>doc.removeMappingEntry('accounts',name));
      if(folder) rmSync(folder,{recursive:true,force:true});
      return ok(`Removed account ${name}.\n${diff}`);
    }
    throw Error('usage: pacer account list [--json] | add <kind> <name> [options] | rm <name> [--delete-home]');
  } catch(e) {return fail(e);}
}

export async function runnerCmd(args: string[], ctx: Ctx): Promise<Result> {
  try {
    const [verb,...rest]=args;
    const {pos,flags}=commandArgs(rest,verb==='add'?['model']:[],verb==='list'?['json']:[]);
    const s=loadStrategy(ctx);
    if(verb==='list' && !pos.length) return ok(flags.json ? JSON.stringify(Object.values(s.runners),null,2) : Object.values(s.runners).map(r=>`${r.id} · ${r.account} · ${r.model ?? 'default model'}`).join('\n'));
    requireAccounts(s);
    if(pos.length!==1) throw Error('a runner id is required');
    const parsed=parseRunnerId(pos[0]); if(!parsed) throw Error('invalid runner id');
    if(parsed.host) throw Error("remote runners aren't supported yet");
    const defaults=runnerDefaults(s.accounts); delete defaults.opencode;
    const name=parsed.account ?? defaults[parsed.agent],a=s.accounts[name ?? ''];
    if(!a || !allowedPair(parsed.agent,a.kind)) throw Error('agent/account pairing not allowed or account not found');
    const id=formatRunnerId({...parsed,account:a.name},defaults);
    if(verb==='add') {
      if(s.runners[id]) throw Error(`runner ${id} already exists`);
      const diff=applyEdit(ctx,doc=>{
        doc.addMappingEntry('runners',id,flags.model ? {model:flags.model} : {});
        // Materialize the effective routing before adding a runner, preserving every rule.
        const raw=docValue(doc,['routing']);
        if(!Array.isArray(raw)) doc.setIn(['routing'],s.routing.map(r=>r.kinds?{kinds:r.kinds,executors:r.executors}:{default:r.executors}));
        const rules=docValue(doc,['routing']) as Record<string,unknown>[];
        const index=rules.findIndex(r=>Array.isArray(r.default));
        if(index<0) doc.setIn(['routing'],[...rules,{default:[id]}]);
        else doc.setList(['routing',index,'default'],[...(rules[index].default as string[]),id]);
      });
      return ok(`Added runner ${id}.\n${diff}`);
    }
    if(verb==='rm') {
      const r=resolveRunner(s,id); if(!r) throw Error('unknown runner');
      if(r.agent===s.planner.agent && r.account===s.planner.account) throw Error('planner runner is in use');
      if(Object.keys(s.runners).length<=1) throw Error('cannot remove the last runner');
      const diff=applyEdit(ctx,doc=>{
        const declarations=docValue(doc,['runners']) as Record<string,unknown>|undefined;
        for(const key of Object.keys(declarations ?? {})) if(resolveRunner(s,key)?.id===id) doc.removeMappingEntry('runners',key);
        const rules=docValue(doc,['routing']);
        const sourceRules=Array.isArray(rules) ? rules : s.routing.map(rule=>rule.kinds?{kinds:rule.kinds,executors:rule.executors}:{default:rule.executors});
        const remainingRules=sourceRules.map((rule: Record<string, any>)=>{
          const key=Array.isArray(rule.default)?'default':'executors';
          return {...rule,[key]:rule[key].filter((v:string)=>resolveRunner(s,v)?.id!==id)};
        }).filter((rule: Record<string, any>)=>(rule.default ?? rule.executors).length);
        if(!Array.isArray(rules)) doc.setIn(['routing'],remainingRules);
        else {
          // Edit list values in place, then retain the YAML nodes (and comments)
          // of surviving rules when removing a now-empty rule.
          sourceRules.forEach((rule: Record<string, any>,i:number)=>{
            const key=Array.isArray(rule.default)?'default':'executors';
            doc.setList(['routing',i,key],rule[key].filter((v:string)=>resolveRunner(s,v)?.id!==id));
          });
          if(remainingRules.length!==sourceRules.length) {
            const node=doc.getIn(['routing']);
            if(!isSeq(node)) throw Error('routing must be a list');
            const updated=node.clone();
            updated.items=updated.items.filter(item=>{
              const rule=isNode(item)?item.toJSON():item;
              return (rule.default ?? rule.executors).length;
            });
            doc.replaceNode(['routing'],updated as Node);
          }
        }
        const order=docValue(doc,['pacing','order']);
        if(Array.isArray(order)) doc.setList(['pacing','order'],order.filter(v=>resolveRunner(s,String(v))?.id!==id));
      });
      return ok(`Removed runner ${id}.\n${diff}`);
    }
    throw Error('usage: pacer runner list [--json] | add <agent#account> [--model <m>] | rm <agent#account>');
  } catch(e) {return fail(e);}
}
