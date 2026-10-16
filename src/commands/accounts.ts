import { sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseRunnerId } from "../config/runner-id";
import { loadStrategy } from "../config/strategy";
import * as accounts from "../core/accounts";
import { requireAccounts } from "../core/accounts";
import * as runners from "../core/runners-config";
import type { Ctx } from "../types";
import type { Result } from "./types";
import { table } from "../render/table";

export interface AccountDeps {
  prompt?: (question: string) => Promise<string>;
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
function compactFolder(ctx: Ctx, folder: string | null): string {
  if (!folder) return '—';
  const path = folder === ctx.home ? '~' : folder.startsWith(ctx.home + sep) ? '~' + folder.slice(ctx.home.length) : folder;
  return path.length > 40 ? path.slice(0,19) + '…' + path.slice(-20) : path;
}
async function confirmDeletion(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({input: process.stdin, output: process.stdout});
  try { return /^y(?:es)?$/i.test((await rl.question(`${question} [y/N] `)).trim()); }
  finally { rl.close(); }
}
async function promptArgument(question: string): Promise<string> {
  if(!process.stdin.isTTY) throw Error("interactive account/runner setup requires a terminal");
  const rl=createInterface({input:process.stdin,output:process.stdout});
  try {return (await rl.question(`${question}> `)).trim();} finally {rl.close();}
}
async function loginAgent(ctx: Ctx, argv: string[], env: Record<string,string>): Promise<number> {
  const child = Bun.spawn(argv, {env: {...ctx.env, ...env}, stdin: "inherit", stdout: "inherit", stderr: "inherit"});
  return child.exited;
}
export async function accountCmd(args: string[], ctx: Ctx, deps: AccountDeps = {}): Promise<Result> {
  try {
    if(args[0]==="add" && (args.length===1 || (args.length===2 && args[1]==="--orca"))) {
      const ask=deps.prompt ?? promptArgument;
      const kind=await ask("Account kind (claude, codex, endpoint)");
      const name=await ask("Account name");
      const options=args[1]==="--orca" ? ["--orca",await ask("Orca account id")] : [];
      if(kind==="endpoint" && args[1]!=="--orca") {
        const usage=await ask("Usage (quota, metered, unmetered)");options.push("--usage",usage);
        if(usage==="metered") options.push("--weekly-tokens",await ask("Weekly token budget"));
        if(usage==="quota") {
          const source=await ask("Quota source (arkcli, empty for manual)");
          if(source) options.push("--quota-source",source);
        }
      }
      return accountCmd(["add",kind,name,...options],ctx,deps);
    }
    const [verb, ...rest] = args;
    const {pos, flags} = commandArgs(rest, verb === "add" ? ["home","orca","usage","quota-source","weekly-tokens"] : [], verb === "list" ? ["json"] : verb === "add" ? ["no-login"] : ["delete-home"]);
    const s = loadStrategy(ctx);
    if (verb === "list" && !pos.length) {
      const rows = await accounts.list(ctx);
      return ok(flags.json ? JSON.stringify(rows.map(({signin_command, ...row}) => row),null,2) : table(['ACCOUNT','KIND','SOURCE','FOLDER','RUNNERS','USAGE'],rows.map(a=>[a.name,a.kind,a.source,compactFolder(ctx,a.folder),a.runners.join(', ') || 'no runners',`${a.usageReading.windows.map(w=>`${w.name}: ${w.usedPct ?? '?'}%`).join(', ') || a.usage}${!a.runnable ? ' · usage-only: account folder not found' : ''}`])));
    }
    requireAccounts(s);
    if (verb === "add" && pos.length === 2) {
      const [kind,name] = pos;
      const {folder, diff} = await accounts.add(ctx, {kind, name, home: flags.home as string | undefined, orca: flags.orca as string | undefined, usage: flags.usage as string | undefined, quotaSource: flags['quota-source'] as string | undefined, weeklyTokens: flags['weekly-tokens'] as string | undefined, noLogin: flags['no-login'] === true});
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
      const folder=flags['delete-home'] ? accounts.deletionHome(ctx,s,name) : null;
      if (folder && !await (deps.confirm ?? confirmDeletion)(`Delete account home ${folder}?`)) throw Error('account removal cancelled');
      const {diff}=accounts.remove(ctx,name,{deleteHome: !!flags['delete-home']});
      return ok(`Removed account ${name}.\n${diff}`);
    }
    throw Error('usage: pacer account list [--json] | add <kind> <name> [options] | rm <name> [--delete-home]');
  } catch(e) {return fail(e);}
}

export async function runnerCmd(args: string[], ctx: Ctx, deps: Pick<AccountDeps,"prompt"> = {}): Promise<Result> {
  try {
    if(args[0]==="add" && args.length===1) {
      const ask=deps.prompt ?? promptArgument,id=await ask("Runner (agent#account)");
      const model=id.startsWith("opencode#")?await ask("Model (provider/model, empty for account default)"):"";
      return runnerCmd(["add",id,...(model?["--model",model]:[])],ctx,deps);
    }
    const [verb,...rest]=args;
    const {pos,flags}=commandArgs(rest,verb==='add'?['model']:[],verb==='list'?['json']:[]);
    const s=loadStrategy(ctx);
    if(verb==='list' && !pos.length) return ok(flags.json ? JSON.stringify(Object.values(s.runners),null,2) : table(['RUNNER','ACCOUNT','MODEL'],Object.values(s.runners).map(r=>[r.id,r.account,r.model ?? 'default model'])));
    requireAccounts(s);
    if(pos.length!==1) throw Error('a runner id is required');
    const parsed=parseRunnerId(pos[0]); if(!parsed) throw Error('invalid runner id');
    if(verb==='add') {
      const {id, diff}=runners.add(ctx, {agent: parsed.agent, account: parsed.account ?? undefined, host: parsed.host ?? undefined, model: flags.model as string | undefined});
      return ok(`Added runner ${id}.\n${diff}`);
    }
    if(verb==='rm') {
      const {id, diff}=runners.remove(ctx,pos[0]);
      return ok(`Removed runner ${id}.\n${diff}`);
    }
    throw Error('usage: pacer runner list [--json] | add <agent#account> [--model <m>] | rm <agent#account>');
  } catch(e) {return fail(e);}
}
