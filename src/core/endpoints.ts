import {readFileSync} from "node:fs";
import {join} from "node:path";
import {isNode} from "yaml";
import {StrategyDoc, editStrategy} from "../config/edit";
import {loadStrategy, strategyPath, validateStrategy} from "../config/strategy";
import type {EndpointConnection, EndpointModel, KeySource} from "../config/accounts";
import type {Ctx} from "../types";
import {readKey, writeKey} from "../endpoints/keys";
import {discoverModels, type DiscoveryResult} from "../endpoints/models";
import {writeOpencodeConfig} from "../endpoints/opencode-config";
import {endpointRow} from "../endpoints/row";
import {readEndpointState, redactEndpointError, writeEndpointState} from "../endpoints/state";
import {testEndpoint as runTest} from "../endpoints/test-task";

export interface EndpointDeps {
  fetch?: Parameters<typeof discoverModels>[0]["fetch"];
  spawn?: NonNullable<Parameters<typeof runTest>[2]>["spawn"];
}
export interface EndpointInput {
  name: string;
  base_url: string;
  key_source: KeySource | "env";
  env_var?: string;
  key?: string;
  models: EndpointModel[];
  usage: string;
  weekly_tokens?: number;
  quota_source?: string;
  test?: boolean;
}
export type EndpointEdit = Pick<EndpointInput,"name"> & Partial<Omit<EndpointInput,"name">>;
function strategy(ctx: Ctx) {
  const s=loadStrategy(ctx);
  if (s.legacy) throw Error("Run pacer config migrate before editing accounts or runners.");
  return s;
}
function account(ctx: Ctx, name: string) {
  const a=strategy(ctx).accounts[name];
  if (!a || a.kind!=="endpoint") throw Error("a configured endpoint account is required");
  return a;
}
function source(input: Pick<EndpointInput,"key_source"|"env_var">): KeySource {
  const value=input.key_source==="env" ? `env:${input.env_var ?? ""}` : input.key_source;
  if (!/^(keychain|file|none|env:[A-Za-z_][A-Za-z0-9_]*)$/.test(value)) throw Error("invalid endpoint key source");
  return value as KeySource;
}
function value(doc: StrategyDoc, path: string[]): any {
  const node=doc.getIn(path); return isNode(node)?node.toJSON():node;
}
/** Account, runner and routing validate together before the key or strategy is written. */
async function save(ctx: Ctx, input: EndpointInput, editing: boolean, deps: EndpointDeps) {
  const s=strategy(ctx), name=input.name;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw Error("invalid endpoint name");
  if (!editing && s.accounts[name]) throw Error(`account ${name} already exists; use pacer account edit ${name}`);
  if (editing) account(ctx,name);
  if (!["quota","metered","unmetered"].includes(input.usage)) throw Error("usage must be quota, metered or unmetered");
  const keySource=source(input);
  if ((keySource==='file' || keySource==='keychain') && !input.key && (!editing || s.accounts[name].connection?.key!==keySource)) throw Error("endpoint key must not be empty");
  const connection: EndpointConnection={api:'openai-compatible',base_url:input.base_url,key:keySource,models:input.models};
  const change=(doc: StrategyDoc) => {
    if (!editing) doc.addMappingEntry('accounts',name,{kind:'endpoint',usage:input.usage,connection});
    else {
      doc.setIn(['accounts',name,'connection'],connection);
      doc.setIn(['accounts',name,'usage'],input.usage);
      const prior=s.accounts[name];
      // An old external provider model must not survive adoption. Keep a
      // managed account's chosen default when it remains in the model list.
      if (!prior.connection || !input.models.some(m=>m.id===prior.model || `pacer-${name}/${m.id}`===prior.model)) doc.deleteIn(['accounts',name,'model']);
    }
    if (input.usage==='metered' && input.weekly_tokens!==undefined) doc.setIn(['accounts',name,'budget','weekly_tokens'],input.weekly_tokens);
    if (input.quota_source!==undefined) doc.setIn(['accounts',name,'quota_source'],input.quota_source);
    if (input.usage!=='quota') doc.deleteIn(['accounts',name,'quota_source']);
    if (input.usage!=='metered') doc.deleteIn(['accounts',name,'budget']);
    const id=`opencode#${name}`;
    // Equivalent to runner add, in the same validated edit as the account.
    const runners=Object.values(s.runners).filter(r=>r.account===name && r.agent==='opencode');
    for (const runner of runners) {
      const declarations=value(doc,['runners']) ?? {};
      const prefix=`pacer-${name}/`;
      const selected=runner.model?.startsWith(prefix) && input.models.some(m=>prefix+m.id===runner.model) ? runner.model : prefix+(input.models[0]?.id ?? '');
      for (const ref of Object.keys(declarations)) if (s.runnerAliases[ref]===runner.id || ref===runner.id) doc.setIn(['runners',ref,'model'],selected);
    }
    if (!s.runners[id]) {
      doc.addMappingEntry('runners',id,{model:`pacer-${name}/${input.models[0]?.id ?? ''}`});
      let rules=value(doc,['routing']);
      if (!Array.isArray(rules)) {
        rules=s.routing.map(r=>r.kinds?{kinds:r.kinds,executors:r.executors}:{default:r.executors});
        doc.setIn(['routing'],rules);
      }
      const index=rules.findIndex((r: any)=>Array.isArray(r.default));
      if (index<0) doc.setIn(['routing'],[...rules,{default:[id]}]);
      else doc.setList(['routing',index,'default'],[...rules[index].default,id]);
    }
  };
  try {
    const preview=new StrategyDoc(readFileSync(strategyPath(ctx),'utf8')); change(preview);
    // Refuse echoed credentials in metadata before persisting it.
    if (input.key && preview.toString().includes(input.key)) throw Error("endpoint metadata contains credentials");
    validateStrategy(Bun.YAML.parse(preview.toString()),strategyPath(ctx));
    if (input.key && (keySource==='file' || keySource==='keychain')) await writeKey(ctx,name,keySource,input.key);
    const result=editStrategy(strategyPath(ctx),change);
    if (!result.ok) throw Error(result.error);
    writeOpencodeConfig(ctx);
    writeEndpointState(ctx,name,{state:'not_tested'});
    if (input.test!==false) await runTest(ctx,name,deps);
    const updated=loadStrategy(ctx);
    const row=await endpointRow(ctx,updated.accounts[name]);
    return {account:{...updated.accounts[name],...row},runner:updated.runners[`opencode#${name}`],...readEndpointState(ctx,name),...(row.state==='key_missing'?{state:'key_missing' as const}:{})};
  } catch(e) {throw Error(redactEndpointError(e instanceof Error?e.message:String(e),[input.key ?? '']));}
}
export async function addEndpoint(ctx: Ctx, input: EndpointInput, deps: EndpointDeps = {}) {
  return save(ctx,input,false,deps);
}
export async function editEndpoint(ctx: Ctx, input: EndpointEdit, deps: EndpointDeps = {}) {
  const a=account(ctx,input.name), c=a.connection;
  if (!c) throw Error(`External OpenCode provider; adopt with pacer account edit ${input.name}`);
  return save(ctx,{base_url:input.base_url ?? c.base_url,key_source:input.key_source ?? c.key,
    models:input.models ?? c.models,usage:input.usage ?? a.usage,weekly_tokens:input.weekly_tokens ?? a.weeklyTokens ?? undefined,
    quota_source:input.quota_source ?? a.quotaSource ?? undefined,...input,test:input.test ?? false},true,deps);
}
export async function testEndpoint(ctx: Ctx, name: string, deps: EndpointDeps = {}) {
  account(ctx,name); writeOpencodeConfig(ctx); return runTest(ctx,name,deps);
}
export async function listModels(ctx: Ctx, input: {name?: string; base_url?: string; key?: string | null}, deps: EndpointDeps = {}): Promise<DiscoveryResult> {
  const c=input.name ? account(ctx,input.name).connection : undefined;
  const baseUrl=input.base_url ?? c?.base_url;
  if (!baseUrl) throw Error("endpoint base URL is required");
  const key=input.key!==undefined ? input.key : c ? await readKey(ctx,input.name!,c.key) : null;
  if (c && c.key!=='none' && !key) throw Error("Key missing: configure the endpoint key before discovery");
  return discoverModels({baseUrl,key,fetch:deps.fetch});
}
/** Project only provider URL and model ids. Never access options.apiKey or auth files. */
export function externalEndpoint(ctx: Ctx, name: string) {
  const a=account(ctx,name), s=strategy(ctx);
  if (a.connection) throw Error("endpoint is already managed");
  const model=Object.values(s.runners).find(r=>r.account===name && r.agent==='opencode')?.model ?? a.model;
  const provider=model?.split('/')[0];
  if (!provider) throw Error("external OpenCode provider not found");
  let config;
  try {config=JSON.parse(readFileSync(join(ctx.home,'.config','opencode','opencode.json'),'utf8'));}
  catch {throw Error("could not read external OpenCode provider metadata");}
  const entry=config?.provider?.[provider];
  if (typeof entry?.options?.baseURL!=='string') throw Error("external provider baseURL not found");
  const models: EndpointModel[]=Object.keys(entry.models ?? {}).map(id=>({id,context:128000,output:16000,tools:true}));
  return {provider,base_url:entry.options.baseURL as string,models};
}
export async function adoptEndpoint(ctx: Ctx, input: Pick<EndpointInput,'name'|'key_source'|'key'|'env_var'> & Partial<EndpointInput>, deps: EndpointDeps = {}) {
  const a=account(ctx,input.name), external=externalEndpoint(ctx,input.name);
  return save(ctx,{base_url:external.base_url,models:external.models,usage:a.usage,weekly_tokens:a.weeklyTokens ?? undefined,
    quota_source:a.quotaSource ?? undefined,...input,test:input.test ?? false},true,deps);
}
