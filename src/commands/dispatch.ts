import { resolve } from "node:path";
import { connectClient } from "../api/client";
import { callOp } from "../api/ops";
import type { DispatchPreview } from "../dispatch/types";
import { commandArgs } from "./accounts";
import type { Command, Result } from "./types";
import type { Ctx } from "../types";

const USAGE = "usage: pacer dispatch preview|submit|child|list|tree|events|wait|review|retry|answer|stop|dependencies|waive|models|refresh|analytics|enforcement|probe|learning-reset ... [--json]";
export async function dispatchCmd(args: string[], ctx: Ctx): Promise<Result> {
  try {
    const sub=args[0];
    if(sub!=="preview"){
      const {pos,flags}=commandArgs(args.slice(1),["repo","goal","title","kind","executor","request-id","id","after","timeout","note","expect-rev","min-tier","model","priority","depends-on","dependency","reason","relation","state","before","text","feedback","acceptance","acceptance-timeout-min","context","constraints"],["json","accept","reject","allow-delegation","tools","force","exclude"]);
      if(pos.length)throw Error(USAGE);
      const opt={...(flags["min-tier"]||flags.tools?{requirements:{...(flags["min-tier"]?{minTier:String(flags["min-tier"])}:{}),...(flags.tools?{tools:true}:{})}}:{}),...(flags.model?{model:String(flags.model)}:{}),...(flags.priority?{priority:Number(flags.priority)}:{}),...(flags["allow-delegation"]?{allowDelegation:true}:{})};
      let op:string,params:Record<string,unknown>;
      const id=String(flags.id??"");
      switch(sub){
        case "submit":
        case "child":
          if(!flags.goal||sub==="submit"&&!flags.repo||sub==="child"&&!flags["request-id"])throw Error(USAGE);
          op=sub==="submit"?"dispatch.submit":"dispatch.child";
          params={goal:flags.goal,title:flags.title,kind:flags.kind,executor:flags.executor,requestId:flags["request-id"],acceptance:flags.acceptance,...(flags["acceptance-timeout-min"]!==undefined?{acceptance_timeout_min:Number(flags["acceptance-timeout-min"])}:{}),context:flags.context,constraints:flags.constraints,...(sub==="submit"?{repo:resolve(String(flags.repo))}:{}),options:opt};break;
        case "tree":case "events":case "wait":case "stop":case "review":case "retry":case "answer":
          if(!id)throw Error(USAGE);
          op=`dispatch.${sub}`;params={id};
          if(sub==="events")params.after=flags.after?Number(flags.after):0;
          if(sub==="wait")params.timeout_s=flags.timeout?Number(flags.timeout):600;
          if(sub==="stop")params.expect_rev=flags["expect-rev"]?Number(flags["expect-rev"]):undefined;
          if(sub==="review"){
            if(!!flags.accept===!!flags.reject)throw Error("Choose --accept or --reject");
            params.accepted=!!flags.accept;params.note=flags.note;
            if(flags["expect-rev"]!==undefined)params.expect_rev=Number(flags["expect-rev"]);
          }
          if(sub==="retry"||sub==="answer"){
            if(!flags["request-id"]||sub==="answer"&&!flags.text)throw Error(USAGE);
            params.requestId=flags["request-id"];
            if(flags["expect-rev"]!==undefined)params.expect_rev=Number(flags["expect-rev"]);
            if(sub==="retry")params.feedback=flags.feedback;
            else params.text=flags.text;
          }
          break;
        case "models":case "refresh":case "analytics":
          op=`dispatch.${sub}`;params=sub==="refresh"?{runner:flags.executor,force:!!flags.force}:sub==="analytics"?{repo:flags.repo,kind:flags.kind}:{};
          break;
        case "enforcement":case "probe":
          if(!flags.repo||sub==="probe"&&!flags.executor)throw Error(USAGE);
          op=sub==="probe"?"dispatch.enforcement.probe":"dispatch.enforcement";
          params={repo:resolve(String(flags.repo)),...(sub==="probe"?{runner:flags.executor}:{})};break;
        case "list":
          op="dispatch.list";params={relation:flags.relation,state:flags.state,before:flags.before};break;
        case "dependencies":
          if(!id||!flags["expect-rev"])throw Error(USAGE);
          op="dispatch.dependencies";params={id,dependencies:String(flags["depends-on"]??"").split(",").filter(Boolean),expect_rev:Number(flags["expect-rev"])};break;
        case "waive":
          if(!id||!flags.dependency||!flags.reason||!flags["expect-rev"])throw Error(USAGE);
          op="dispatch.dependencies.waive";params={id,dependency:flags.dependency,reason:flags.reason,expect_rev:Number(flags["expect-rev"])};break;
        case "learning-reset":
          if(!flags.repo)throw Error(USAGE);
          op="dispatch.learning.reset";params={repo:resolve(String(flags.repo)),excluded:!!flags.exclude};break;
        default:throw Error(USAGE);
      }
      const client=await connectClient(ctx,{protocol:3});
      let result:unknown;
      try {
        if(["review","retry","answer"].includes(sub)&&params.expect_rev===undefined){
          const tree=client.kind==="inprocess"?await callOp(ctx,"dispatch.tree",{id}):await client.call("dispatch.tree",{id});
          const node=(tree as {nodes:{taskId:string;rev:number}[]}).nodes.find(n=>n.taskId===id);
          if(!node)throw Error("Work step is not visible");
          params.expect_rev=node.rev;
        }
        if(sub==="learning-reset"){
          const analytics=client.kind==="inprocess"?await callOp(ctx,"dispatch.analytics",{repo:params.repo}):await client.call("dispatch.analytics",{repo:params.repo});
          params.expect_rev=(analytics as {learningRevision:number}).learningRevision;
        }
        result=client.kind==="inprocess"?await callOp(ctx,op,params):await client.call(op,params);
      }
      finally{client.close();}
      if(flags.json)return{code:0,out:JSON.stringify(result,null,2),err:""};
      if(sub==="tree"){
        const tree=result as {nodes:{taskId:string;depth:number;state:string;title:string;model?:string|null}[];totals:{tasks:number;running:number;queued:number}};
        return{code:0,out:[...tree.nodes.map(n=>`${"  ".repeat(n.depth)}${n.taskId} ${n.state} ${n.title}${n.model?` [${n.model}]`:""}`),`Total ${tree.totals.tasks}, running ${tree.totals.running}, queued ${tree.totals.queued}`].join("\n"),err:""};
      }
      return{code:0,out:JSON.stringify(result,null,2),err:""};
    }
    if (args[0] !== "preview") throw Error(USAGE);
    const {pos, flags} = commandArgs(args.slice(1), ["repo", "goal", "kind", "model", "min-tier"], ["json", "tools"]);
    if (pos.length || !flags.repo || !flags.goal) throw Error(USAGE);
    const repo = String(flags.repo);
    const input = {repo: repo === "." || repo.startsWith("./") || repo.startsWith("../") ? resolve(repo) : repo, goal: flags.goal, ...(flags.kind ? {kind: flags.kind} : {}), ...(flags.model ? {model: flags.model} : {}),
      requirements: {...(flags["min-tier"] ? {minTier: flags["min-tier"]} : {}), ...(flags.tools ? {tools: true} : {})}};
    const client = await connectClient(ctx, {protocol: 3});
    let preview: DispatchPreview;
    try { preview = client.kind === "inprocess" ? await callOp(ctx, "dispatch.preview", input) as DispatchPreview : await client.call<DispatchPreview>("dispatch.preview", input); }
    finally { client.close(); }
    if (flags.json) return {code: 0, out: JSON.stringify(preview, null, 2), err: ""};
    const lines = [`Engine: ${preview.engine.id}@${preview.engine.version} (${preview.validation})`];
    if (preview.proposal?.state === "ranked") {
      lines.push(`Step: ${preview.proposal.step}`, ...preview.proposal.choices.map((c, i) => `${i + 1}. ${c.id}: ${c.reason}`));
    } else lines.push(`${preview.recommendedAction}: ${preview.proposal?.reason ?? "Decision engine did not return a valid proposal"}`);
    lines.push(...preview.excluded.map(e => `Excluded ${e.id}: ${e.reason}`), ...preview.uncertainty);
    return {code: 0, out: lines.join("\n"), err: ""};
  } catch (e) { return {code: 2, out: "", err: `pacer: ${e instanceof Error ? e.message : String(e)}`}; }
}
export const COMMANDS: Command[] = [{name: "dispatch", usage: "dispatch preview|submit|child|list|tree|events|wait|review|retry|answer|stop|dependencies|waive|models|refresh|analytics|enforcement|probe|learning-reset    select models and manage scoped work", run: dispatchCmd}];
