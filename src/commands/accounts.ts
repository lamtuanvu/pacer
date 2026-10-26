import { sep } from "node:path";
import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { parseRunnerId } from "../config/runner-id";
import { migrationLines } from "../config/migrate";
import { loadStrategy, strategyPath } from "../config/strategy";
import * as accounts from "../core/accounts";
import { ensureAccounts } from "../core/accounts";
import * as runners from "../core/runners-config";
import { parseSize, type EndpointModel, type KeySource } from "../config/accounts";
import type { Ctx } from "../types";
import type { Result } from "./types";
import { table } from "../render/table";

import * as endpoints from "../core/endpoints";
import * as setup from "../core/opencode-setup";
import {deleteKey} from "../endpoints/keys";
import {redactEndpointMessage, type EndpointState} from "../endpoints/state";
import type {DiscoveredModel, DiscoveryResult} from "../endpoints/models";
import type {Candidate, Detection} from "../endpoints/detect";
import {spendCopy} from "../view-model/copy";
import {filterModelIds, idChoice, type ModelChoice, type UsageClass} from "../endpoints/recommend";

export interface AccountDeps extends endpoints.EndpointDeps {
  promptSecret?: (question: string) => Promise<string>;
  readStdin?: () => Promise<string>;
  prompt?: (question: string) => Promise<string>;
  login?: (argv: string[], env: Record<string, string>) => Promise<number>;
  confirm?: (question: string) => Promise<boolean>;
  print?: (line: string) => void;
}
const ok = (out: string): Result => ({code: 0, out, err: ""});
const fail = (e: unknown): Result => ({code: 2, out: "", err: `pacer: ${e instanceof Error ? e.message : String(e)}`});
const NAME = /^[a-z0-9][a-z0-9-]*$/;
// Array.forEach would also pass the index and array to console.log.
function printLines(lines: string[], print?: (line: string) => void): void {
  for (const line of lines) (print ?? console.log)(line);
}
/** A closed input stream ends the wizard instead of re-asking forever. */
function answered(read: (question: string) => Promise<string>, what: string) {
  return async (question: string) => {
    const answer = await read(question);
    if (typeof answer !== "string") throw Error(`${what} cancelled: no input`);
    return answer.trim();
  };
}
/** Validate a field where it is entered, so a later save cannot fail for it and earlier answers are kept. */
async function askUntil<T>(ask: (question: string) => Promise<string>, print: (line: string) => void, question: string, parse: (answer: string) => T | Error): Promise<T> {
  for (;;) {
    const value = parse(await ask(question));
    if (!(value instanceof Error)) return value;
    print(value.message);
  }
}
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
      const ask=answered(deps.prompt ?? promptArgument,'account setup'), print=deps.print ?? console.log;
      const kinds: Record<string,string>={'1':'claude','2':'codex','3':'endpoint',claude:'claude',codex:'codex',endpoint:'endpoint'};
      const kind=await askUntil(ask,print,"What do you want to add? 1. Claude Code account  2. Codex account  3. Model endpoint (OpenCode)",
        answer=>kinds[answer] ?? Error('Choose 1, 2 or 3.'));
      if(kind==='endpoint' && args[1]!=="--orca") return await opencodePicker(ctx,deps);
      const name=await nameQuestion(ctx,ask,print);
      const options=args[1]==="--orca" ? ["--orca",await ask("Orca account id")] : [];
      return accountCmd(["add",kind,name,...options],ctx,deps);
    }
    const [verb, ...rest] = args;
    const {pos, flags} = commandArgs(rest, verb === "add" || verb === "edit" ? ["home","orca","usage","quota-source","weekly-tokens","base-url","key","models","context","output","cap-usd","model","name"] : [], verb === "list" ? ["json"] : verb === "models" ? ["refresh"] : verb === "add" || verb === "edit" ? ["no-login","no-test"] : ["delete-home","delete-key"]);
    const opencodeAdd = verb === "add" && pos[0] === "opencode" && pos.length === 2;
    if (!opencodeAdd && (flags.model !== undefined || flags.name !== undefined || flags["cap-usd"] !== undefined)) throw Error("--model, --name and --cap-usd are only supported by pacer account add opencode <provider>");
    let s = loadStrategy(ctx);
    if (verb === "list" && !pos.length) {
      const rows = await accounts.list(ctx);
      return ok(flags.json ? JSON.stringify(rows.map(({signin_command, ...row}) => row),null,2) : table(['ACCOUNT','KIND','SOURCE','FOLDER','RUNNERS','USAGE'],rows.map(a=>[a.name,a.kind,a.source,compactFolder(ctx,a.folder),a.runners.join(', ') || 'no runners',`${spendCopy(a.usageReading.spendUsd, a.weeklyUsd) ?? (a.usageReading.windows.map(w=>`${w.name}: ${w.usedPct ?? '?'}%`).join(', ') || a.usage)}${!a.runnable ? ' · usage-only: account folder not found' : ''}`])));
    }
    if (["add", "edit", "rm"].includes(verb) || (verb === "models" && flags.refresh)) {
      const ensured=ensureAccounts(ctx);
      s=ensured.strategy;
      if (ensured.migrated) printLines(migrationLines(strategyPath(ctx),ensured.migrated),deps.print);
    }
    if (verb === 'test' && pos.length===1) return ok(endpointMessage(pos[0],await endpoints.testEndpoint(ctx,pos[0],deps)));
    if (verb === 'models' && pos.length===1) {
      const a=s.accounts[pos[0]];
      if (!a?.connection) throw Error("a configured endpoint connection is required");
      if (!flags.refresh) return ok(table(['MODEL','CONTEXT','OUTPUT'],a.connection.models.map(m=>[m.id,String(m.context),String(m.output)])));
      const discovered=await endpoints.listModels(ctx,{name:pos[0]},deps);
      const models=await chooseModels(discovered,deps);
      const result=await endpoints.editEndpoint(ctx,{name:pos[0],models},deps);
      return ok(endpointMessage(pos[0],result));
    }
    if (verb==='edit' && pos.length===1) {
      const a=s.accounts[pos[0]];
      if (!a || a.kind!=='endpoint') throw Error("an endpoint account is required");
      if (!Object.keys(flags).length) return await endpointWizard(ctx,pos[0],deps,true);
      if (!a.connection) throw Error(`External OpenCode provider; use pacer account edit ${pos[0]} to adopt it`);
      const input=await endpointFlags(pos[0],flags,deps,true);
      const result=await endpoints.editEndpoint(ctx,input,deps);
      return ok(endpointMessage(pos[0],result));
    }
    if (verb==='add' && pos[0]==='opencode' && pos.length===2) {
      const provider=pos[1];
      // AccountDeps.login takes (argv, env) for the claude/codex CLI login flow; SetupDeps.login
      // takes (argv) for `opencode auth login`. The two are unrelated, so drop the former before
      // forwarding deps into opencode-setup, instead of widening SetupDeps to match.
      const {login: _login, ...setupDeps} = deps;
      const cap=flags['cap-usd']===undefined ? undefined : Number(flags['cap-usd']);
      if (cap!==undefined && !(Number.isFinite(cap) && cap>0)) throw Error('--cap-usd must be a positive number of dollars, e.g. 10');
      // For providers the catalog cannot classify; otherwise the catalog sets the usage type.
      const usage=flags.usage===undefined ? undefined : String(flags.usage);
      if (usage!==undefined && !['quota','metered','unmetered'].includes(usage)) throw Error('--usage must be quota, metered or unmetered');
      let model: string | undefined = typeof flags.model==='string' ? flags.model : undefined;
      if (!model) {
        const models=await setup.setupModels(ctx,{provider,group:'signed_in'},setupDeps);
        model=models.pick?.id;
        if (!model) throw Error(models.note ? `${models.note} Or pass --model <id>.` : `no usable model found for ${provider}; pass --model <id>`);
      }
      const result=await setup.addOpencodeAccount(ctx,{provider,model,name:typeof flags.name==='string'?flags.name:undefined,cap_usd:cap,...(usage ? {usage: usage as 'quota'|'metered'|'unmetered'} : {}),test:!flags['no-test']},setupDeps);
      return ok(opencodeMessage(result.account.name,provider,model,result,cap));
    }
    if (verb==='add' && pos[0]==='endpoint' && pos.length===2 && (['base-url','key','models','context','output','no-test'].some(k=>flags[k]))) {
      if (s.accounts[pos[1]]) throw Error(`account ${pos[1]} already exists; use pacer account edit ${pos[1]}`);
      const input=await endpointFlags(pos[1],flags,deps);
      const result=await endpoints.addEndpoint(ctx,input as endpoints.EndpointInput,deps);
      return ok(endpointMessage(pos[1],result,true));
    }
    if (verb === "add" && pos.length === 2) {
      const [kind,name] = pos;
      if (kind !== 'endpoint' && ['base-url','key','models','context','output','no-test'].some(k=>flags[k])) throw Error("connection options are only supported for endpoints");
      if (s.accounts[name]) throw Error(`account ${name} already exists; use pacer account edit ${name}`);
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
      const stored=a.connection?.key;
      const removeKey=stored && ['file','keychain'].includes(stored) && (flags['delete-key'] || await (deps.confirm ?? confirmDeletion)(`Delete stored key for endpoint ${name}?`));
      const {diff}=await accounts.remove(ctx,name,{deleteHome: !!flags['delete-home']});
      if (removeKey) await deleteKey(ctx,name,stored!);
      return ok(`Removed account ${name}.\n${diff}`);
    }
    throw Error('usage: pacer account list [--json] | add <kind> <name> [options] | add opencode <provider> [--model <id>] [--cap-usd <n>] [--usage <quota|metered|unmetered>] [--name <n>] [--no-test] | models <name> [--refresh] | test <name> | edit <name> | rm <name> [--delete-home] [--delete-key]');
  } catch(e) {return fail(e);}
}

export async function runnerCmd(args: string[], ctx: Ctx, deps: Pick<AccountDeps,"prompt"|"print"> = {}): Promise<Result> {
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
    const migration=ensureAccounts(ctx).migrated;
    if (migration) printLines(migrationLines(strategyPath(ctx),migration),deps.print);
    if(pos.length!==1) throw Error('a runner id is required');
    const parsed=parseRunnerId(pos[0]); if(!parsed) throw Error('invalid runner id');
    if(verb==='add') {
      const {id, diff}=await runners.add(ctx, {agent: parsed.agent, account: parsed.account ?? undefined, host: parsed.host ?? undefined, model: flags.model as string | undefined});
      return ok(`Added runner ${id}.\n${diff}`);
    }
    if(verb==='rm') {
      const {id, diff}=await runners.remove(ctx,pos[0]);
      return ok(`Removed runner ${id}.\n${diff}`);
    }
    throw Error('usage: pacer runner list [--json] | add <agent#account> [--model <m>] | rm <agent#account>');
  } catch(e) {return fail(e);}
}

async function hiddenKey(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw Error("interactive endpoint setup requires a terminal");
  // Bun readline does not reliably disable terminal echo for a muted output.
  // Enter raw mode explicitly before displaying the prompt.
  const muted=new Writable({write(_chunk,_encoding,done){done();}});
  const wasRaw=process.stdin.isRaw;
  process.stdin.setRawMode(true);
  const rl=createInterface({input:process.stdin,output:muted,terminal:true});
  try {process.stdout.write(`${question}> `);return await rl.question('');}
  finally {rl.close();process.stdin.setRawMode(!!wasRaw);process.stdout.write('\n');}
}
function endpointMessage(name: string, state: EndpointState, added=false): string {
  const label={ready:'Ready',not_tested:'Not tested',not_working:'Not working',key_missing:'Key missing'}[state.state];
  return `${label}: opencode#${name}${state.detail ? ` · ${state.detail}` : ''}`+
    (state.state==='not_working' ? `\nRetry: pacer account test ${name}` : '')+
    (added ? '\nRouting: added to the end of the default rule. Move it in the app’s Executors screen.' : '');
}
function opencodeMessage(name: string, provider: string, model: string, state: EndpointState, cap?: number): string {
  return endpointMessage(name, state, true).replace(`opencode#${name}`, `opencode#${name} (${provider}/${model})${cap ? ` · cap $${cap}/week` : ''}`);
}
function positiveLimit(value: string | true | undefined, fallback: number, message='model limits must be positive integers'): number {
  const n=value===undefined || value==='' ? fallback : parseSize(value);
  if (!n || !Number.isSafeInteger(n) || n<=0) throw Error(message);
  return n;
}
async function chooseModels(result: DiscoveryResult, deps: AccountDeps): Promise<EndpointModel[]> {
  const ask=answered(deps.prompt ?? promptArgument,'endpoint setup'), print=deps.print ?? console.log;
  let selected: DiscoveredModel[];
  // Embedding, image and speech models cannot run an executor; hide them, as the provider picker does.
  const usable=new Set(filterModelIds(result.listed ? result.models.map(m=>m.id) : []));
  const shown=result.listed ? result.models.filter(m=>usable.has(m.id)) : [];
  const hidden=result.listed ? result.models.length-shown.length : 0;
  if (hidden && shown.length) print(`Hid ${hidden} ${hidden===1 ? 'model' : 'models'} that cannot run an executor (embeddings, images or speech).`);
  if (result.listed && shown.length) {
    shown.forEach((m,i)=>print(`${i+1}. ${m.id}${m.context ? ` · ${m.context} context` : ''}`));
    for (;;) {
      const choices=(await ask('Models to use (e.g. 1,3)')).split(',').map(n=>Number(n.trim()));
      if (choices.length && choices.every(n=>Number.isInteger(n) && n>=1 && n<=shown.length)) {
        selected=[...new Set(choices)].map(n=>shown[n-1]);break;
      }
      print('Choose model numbers from the list.');
    }
  } else {
    print(!result.listed ? result.detail : result.models.length ? "None of this endpoint's models can run an executor. Enter model ids." : "This endpoint doesn't list models. Enter model ids.");
    const ids=await ask('Model ids (comma separated)');
    selected=[...new Set(ids.split(',').map(id=>id.trim()).filter(Boolean))].map(id=>({id}));
    if (!selected.length) throw Error('at least one model id is required');
  }
  let context=128000, output=16000;
  if (selected.some(m=>!m.context || !m.output)) {
    for (;;) {
      const contextInput=await ask('Context size (default 128K)'), outputInput=await ask('Output size (default 16K)');
      try {
        context=positiveLimit(contextInput,128000);
        output=positiveLimit(outputInput,16000);break;
      } catch {print('Model limits must be positive integers.');}
    }
  }
  return selected.map(m=>({...m,context:m.context ?? context,output:m.output ?? output,tools:m.tools ?? true}));
}
async function usagePrompts(ctx: Ctx, ask: (q: string)=>Promise<string>, print: (line: string)=>void, current?: {usage?: string; weeklyTokens?: number | null}) {
  const usage=await askUntil(ask,print,`Usage — quota (a plan with limits), metered (pay per token), unmetered (free/local)${current?.usage ? ` [${current.usage}]` : ''}`,answer=>{
    const value=answer || current?.usage || '';
    return ['quota','metered','unmetered'].includes(value) ? value : Error('Usage must be quota, metered or unmetered.');
  });
  const budget=current?.weeklyTokens ?? undefined;
  const weekly_tokens=usage!=='metered' ? undefined : await askUntil(ask,print,`Weekly token budget (e.g. 50M, Enter for none)${budget ? ` [${budget}]` : ''}`,answer=>{
    if (!answer) return budget;
    const n=parseSize(answer);
    return n && Number.isSafeInteger(n) && n>0 ? n : Error('Enter a positive weekly token budget, for example 50M or 2000000.');
  });
  // arkcli is the only quota reader, so a blank answer selects it.
  const quota_source=usage!=='quota' ? undefined : await askUntil(ask,print,'Quota source [arkcli]',answer=>
    !answer || answer==='arkcli' ? 'arkcli' : Error('Quota source must be arkcli, the only supported quota reader.'));
  if (quota_source==='arkcli' && !ctx.which('arkcli')) print('Note: arkcli is not on PATH, so usage for this account will show as unknown until it is installed.');
  return {usage,weekly_tokens,quota_source};
}
/** The free-form account name prompt shared by the claude/codex kinds and the picker's "Enter a URL yourself" path. */
function nameQuestion(ctx: Ctx, ask: (q: string)=>Promise<string>, print: (line: string)=>void): Promise<string> {
  const taken=loadStrategy(ctx).accounts;
  return askUntil(ask,print,"Name (lowercase, e.g. terastorai)",answer=>
    !NAME.test(answer) ? Error('Use lowercase letters, digits and hyphens, starting with a letter or digit.')
      : taken[answer] ? Error(`Account ${answer} already exists; use pacer account edit ${answer} to change it.`) : answer);
}
/** The name prompt for a detected provider or local server, defaulting to the suggested name on Enter. */
function providerNameQuestion(ctx: Ctx, ask: (q: string)=>Promise<string>, print: (line: string)=>void, suggested: string): Promise<string> {
  const taken=loadStrategy(ctx).accounts;
  return askUntil(ask,print,`Name [${suggested}]`,answer=>{
    const value=answer || suggested;
    return !NAME.test(value) ? Error('Use lowercase letters, digits and hyphens, starting with a letter or digit.')
      : taken[value] ? Error(`Account ${value} already exists; use pacer account edit ${value} to change it.`) : value;
  });
}
function modelFacts(m: ModelChoice): string {
  const parts=[m.tools ? 'tools' : 'no tools', `${Math.round(m.context/1000)}K context`];
  if (m.costIn!==null && m.costOut!==null) parts.push(`$${m.costIn}/$${m.costOut} per M`);
  return parts.join(', ');
}
function usageLabel(u: UsageClass): string {
  if (u.usage==='unmetered') return 'unmetered · free';
  if (u.usage==='quota') return `quota${u.quota_source ? ` · ${u.quota_source}` : ''}`;
  return `metered · prices ${u.known ? 'known' : 'unknown'}`;
}
function candidateLabel(c: Candidate): string {
  const base=c.group==='local'
    ? `${c.name} (${(c.base_url ?? '').replace(/^https?:\/\//,'').replace(/\/v1$/,'')})   ${c.models ?? 0} ${(c.models ?? 0)===1 ? 'model' : 'models'} · free`
    : `${c.name}  ${usageLabel(c.usage)}`;
  return c.added ? `${base} · added as ${c.added}` : base;
}
type MenuItem = {kind:'candidate'; c: Candidate} | {kind:'search'; candidates: Candidate[]} | {kind:'url'};
/** Numbers candidates and the fixed entries in the order the spec's terminal mockup shows them. */
function buildMenu(detection: Detection): {items: MenuItem[]; lines: string[]} {
  const items: MenuItem[]=[], lines: string[]=[];
  let n=0;
  const section=(header: string, cands: Candidate[]) => {
    if (!cands.length) return;
    lines.push(`  ${header}`);
    for (const c of cands) { n++; items.push({kind:'candidate',c}); lines.push(`    ${n}. ${candidateLabel(c)}`); }
  };
  section('Already signed in to OpenCode', detection.candidates.filter(c=>c.group==='signed_in'));
  section('Running on this machine', detection.candidates.filter(c=>c.group==='local'));
  const catalogCandidates=detection.candidates.filter(c=>c.group==='catalog');
  if (catalogCandidates.length) {
    lines.push('  Connect a provider (OpenCode stores the key)');
    n++; items.push({kind:'search',candidates:catalogCandidates});
    lines.push(`    ${n}. Search ${catalogCandidates.length} providers…      e.g. deepseek, byteplus, zhipu`);
  }
  n++; items.push({kind:'url'});
  lines.push(`  ${n}. Enter a URL yourself`);
  return {items,lines};
}
/** Reads a 1-based list selection, re-asking on anything that isn't a number in range. */
async function chooseNumber<T>(ask: (q: string)=>Promise<string>, print: (line: string)=>void, items: T[]): Promise<T> {
  return askUntil(ask,print,'',answer=>{
    const n=Number(answer);
    return Number.isInteger(n) && n>=1 && n<=items.length ? items[n-1] : Error('Choose a number from the list.');
  });
}
/** Steps 4: accept the recommendation, search others, or (no pick) enter a model id. */
async function pickModel(ask: (q: string)=>Promise<string>, print: (line: string)=>void, result: setup.SetupModelsResult): Promise<ModelChoice> {
  if (!result.pick) {
    print(result.note ?? 'No model here can run an executor, so there is nothing to recommend. Enter a model id.');
    const id=await askUntil(ask,print,'Model id',answer=>answer.trim() ? answer.trim() : Error('A model id is required.'));
    return idChoice(id);
  }
  let pick=result.pick, rest=result.rest;
  for (;;) {
    const answer=await ask(`Model: ${pick.id} (${modelFacts(pick)})  [Enter to accept, / to search ${rest.length} others]`);
    if (!answer) return pick;
    if (answer==='/') {
      const query=(await ask('Search models')).toLowerCase();
      const all=[pick,...rest];
      const matches=all.filter(m=>m.id.toLowerCase().includes(query) || (m.name ?? '').toLowerCase().includes(query));
      if (!matches.length) { print('No matching models.'); continue; }
      printLines(matches.map((m,i)=>`${i+1}. ${m.id}${m.name && m.name!==m.id ? ` (${m.name})` : ''}`),print);
      const chosen=await chooseNumber(ask,print,matches);
      pick=chosen; rest=all.filter(m=>m.id!==chosen.id);
      continue;
    }
    print('Press Enter to accept, or / to search.');
  }
}
/** Steps 4-10 once a provider (signed in, newly connected, or local) and its base URL (local only) are known. */
async function setupFromProvider(ctx: Ctx, ask: (q: string)=>Promise<string>, print: (line: string)=>void, group: 'signed_in'|'local', provider: string, base_url: string | undefined, setupDeps: setup.SetupDeps, deps: AccountDeps): Promise<Result> {
  const result=await setup.setupModels(ctx,{provider,group,base_url},setupDeps);
  const pick=await pickModel(ask,print,result);
  let usageKind=result.usage.usage;
  if (!result.usage.known) {
    usageKind=await askUntil(ask,print,'Usage — quota (a plan with limits), metered (pay per token), unmetered (free/local) [metered]',answer=>{
      const value=answer || 'metered';
      return ['quota','metered','unmetered'].includes(value) ? value as UsageClass['usage'] : Error('Usage must be quota, metered or unmetered.');
    });
  }
  const cap=usageKind!=='metered' ? undefined : await askUntil<number|undefined>(ask,print,'Weekly spend cap in $ (Enter for no cap)',answer=>{
    if (!answer) return undefined;
    const n=Number(answer.replace(/^\$/,''));
    return Number.isFinite(n) && n>0 ? n : Error('Enter a positive dollar amount, for example 10, or leave it blank.');
  });
  const name=await providerNameQuestion(ctx,ask,print,setup.suggestName(ctx,provider));
  const test=!/^n(?:o)?$/i.test(await ask('Test with a short task now? Uses about 2K tokens. [Y/n]'));
  if (group==='local') {
    const result2=await endpoints.addEndpoint(ctx,{name,base_url:base_url!,key_source:'none',models:[pick],usage:'unmetered',test},deps);
    return ok(endpointMessage(name,result2,true));
  }
  const result2=await setup.addOpencodeAccount(ctx,{provider,model:pick.id,name,cap_usd:cap,usage:usageKind,test},setupDeps);
  return ok(opencodeMessage(result2.account.name,provider,pick.id,result2,cap));
}
/** The "Model endpoint (OpenCode)" picker: steps 1-3 (detect, menu, connect), then setupFromProvider or the URL fallback. */
async function opencodePicker(ctx: Ctx, deps: AccountDeps): Promise<Result> {
  const ask=answered(deps.prompt ?? promptArgument,'account setup'), print=deps.print ?? console.log;
  const {login,...rest}=deps;
  const setupDeps: setup.SetupDeps={...rest, login: login ? (argv: string[])=>login(argv,{}) : undefined};

  print('Looking for models you can use…');
  const detection=await setup.setupCandidates(ctx,setupDeps);
  printLines(detection.notes,print);

  for (;;) {
    const {items,lines}=buildMenu(detection);
    printLines(lines,print);
    const item=await chooseNumber(ask,print,items);
    if (item.kind==='candidate') {
      if (item.c.added) { print(`Already added as ${item.c.added}; use pacer account edit ${item.c.added}`); continue; }
      return await setupFromProvider(ctx,ask,print,item.c.group as 'signed_in'|'local',item.c.provider,item.c.base_url,setupDeps,deps);
    }
    if (item.kind==='search') {
      const query=(await ask('Search providers (e.g. deepseek)')).toLowerCase();
      const matches=item.candidates.filter(c=>c.provider.toLowerCase().includes(query) || c.name.toLowerCase().includes(query)).slice(0,10);
      if (!matches.length) { print('No matching providers.'); continue; }
      printLines(matches.map((c,i)=>`${i+1}. ${candidateLabel(c)}`),print);
      const chosen=await chooseNumber(ask,print,matches);
      if (chosen.added) { print(`Already added as ${chosen.added}; use pacer account edit ${chosen.added}`); continue; }
      const connected=await setup.connectProvider(ctx,chosen.provider,setupDeps);
      if (!connected) { print(`OpenCode did not finish signing in to ${chosen.provider}.`); continue; }
      return await setupFromProvider(ctx,ask,print,'signed_in',chosen.provider,undefined,setupDeps,deps);
    }
    const name=await nameQuestion(ctx,ask,print);
    return await endpointWizard(ctx,name,deps);
  }
}
const KEY_SOURCE=/^(keychain|file|none|env:[A-Za-z_][A-Za-z0-9_]*)$/;
function parseKeySource(answer: string, fallback: KeySource): KeySource | Error {
  const value=answer || fallback;
  if (!KEY_SOURCE.test(value)) return Error('Key storage must be keychain, file, env:VAR or none.');
  if (value==='keychain' && process.platform!=='darwin') return Error('Keychain storage is only available on macOS; choose file, env:VAR or none.');
  return value as KeySource;
}
async function endpointWizard(ctx: Ctx, name: string, deps: AccountDeps, editing=false): Promise<Result> {
  const existing=loadStrategy(ctx).accounts[name], print=deps.print ?? console.log;
  const ask=answered(deps.prompt ?? promptArgument,'endpoint setup');
  if (!NAME.test(name)) throw Error('invalid endpoint name');
  if (!editing && existing) throw Error(`account ${name} already exists; use pacer account edit ${name}`);
  const migration=ensureAccounts(ctx).migrated;
  if (migration) printLines(migrationLines(strategyPath(ctx),migration),print);
  const adopting=editing && !existing?.connection;
  let external: ReturnType<typeof endpoints.externalEndpoint> | undefined;
  if (adopting) {
    external=endpoints.externalEndpoint(ctx,name);
    print(`External OpenCode provider: ${external.provider}`);
    if (!/^y(?:es)?$/i.test(await ask('Adopt this provider? [y/N]'))) throw Error('adoption cancelled');
  }
  let base_url=existing?.connection?.base_url ?? external?.base_url ?? '';
  const platformSource: KeySource=process.platform==='darwin'?'keychain':'file';
  let key_source: KeySource=platformSource;
  let key: string | undefined;
  let sourceAsked=false;
  const promptKey=async () => {
    // Ask where to keep the key once; a refused key only asks for the key again,
    // unless the key is not entered here (env:VAR or none).
    if (!sourceAsked || key_source==='none' || key_source.startsWith('env:')) {
      const fallback=(editing ? existing?.connection?.key : undefined) ?? platformSource;
      key_source=await askUntil(ask,print,`Key storage (keychain, file, env:VAR, none) [${fallback}]`,answer=>parseKeySource(answer,fallback));
      sourceAsked=true;
      if (key_source.startsWith('env:') && !ctx.env[key_source.slice(4)]) print(`Note: ${key_source.slice(4)} is not set in pacer's environment; the endpoint will show Key missing until it is.`);
      if (key_source==='none' || key_source.startsWith('env:')) {key=undefined;return;}
    }
    key=await (deps.promptSecret ?? hiddenKey)('API key (hidden, empty for none)');
    if (!key) key_source='none';
  };
  let keyAsked=false;
  let models: EndpointModel[];
  if (external) {await promptKey();models=external.models;}
  else {
    let discovery: DiscoveryResult;
    for (;;) {
      const entered=await ask(`Base URL${base_url ? ` [${base_url}]` : ''}`);
      base_url=entered || base_url;
      try {
        const url=new URL(base_url);
        if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw Error();
      } catch {print('Check the URL and try again.');continue;}
      if (!keyAsked) {await promptKey();keyAsked=true;}
      for (;;) {
        discovery=await endpoints.listModels(ctx,{base_url,key:key_source.startsWith('env:') ? ctx.env[key_source.slice(4)] : key},deps);
        if (!discovery.listed && discovery.error==='refused') {print('The key was refused.');await promptKey();continue;}
        break;
      }
      if (!discovery.listed && ['unreachable','invalid_url','timeout'].includes(discovery.error)) {print('Endpoint unreachable. Check the URL and try again.');continue;}
      break;
    }
    models=await chooseModels(discovery!,deps);
  }
  const usage=await usagePrompts(ctx,ask,print,existing);
  const test=!/^n(?:o)?$/i.test(await ask('Test with a short task now? Uses a few hundred tokens. [Y/n]'));
  const input={name,base_url,key_source,key,models,...usage,test};
  try {
    const result=await (adopting ? endpoints.adoptEndpoint : editing ? endpoints.editEndpoint : endpoints.addEndpoint)(ctx,input,deps);
    return ok(endpointMessage(name,result,!editing));
  } catch(e) {throw Error(redactEndpointMessage(e instanceof Error?e.message:String(e),[key ?? '']));}
}
async function endpointFlags(name: string, flags: Record<string,string|true>, deps: AccountDeps, editing=false): Promise<endpoints.EndpointEdit> {
  if (flags.home || flags.orca || flags['no-login']) throw Error('endpoint accounts do not have a home or login');
  if (!editing && (!flags['base-url'] || !flags.key || !flags.models || !flags.usage)) throw Error('endpoint requires --base-url, --key, --models and --usage');
  const key_source=flags.key as KeySource | undefined;
  let key: string | undefined;
  if (key_source==='keychain' || key_source==='file') {
    if (!deps.readStdin && process.stdin.isTTY) throw Error('pipe the endpoint key on stdin');
    key=(await (deps.readStdin ?? (()=>Bun.stdin.text()))()).replace(/\r?\n$/,'');
  }
  const models=typeof flags.models==='string'?flags.models.split(',').map(id=>({id:id.trim(),context:positiveLimit(flags.context,128000),output:positiveLimit(flags.output,16000),tools:true})):undefined;
  return {name,...(typeof flags['base-url']==='string'?{base_url:flags['base-url']}:{}),...(key_source?{key_source}:{}),...(key!==undefined?{key}:{}),
    ...(models?{models}:{}),...(typeof flags.usage==='string'?{usage:flags.usage}:{}),
    ...(flags['weekly-tokens']?{weekly_tokens:positiveLimit(flags['weekly-tokens'],0,'--weekly-tokens must be a positive token budget, e.g. 50M')}:{}),...(typeof flags['quota-source']==='string'?{quota_source:flags['quota-source']}:{}),test:editing?false:!flags['no-test']};
}
