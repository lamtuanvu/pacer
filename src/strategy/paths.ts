import { DECISIONS } from "../classify/types";
type Schema = { [key:string]: Schema | null };
const leaves=(keys:readonly string[]):Schema=>Object.fromEntries(keys.map(k=>[k,null]));
const provider:Schema={...leaves(["via","model","usage","allow_paid","cooldown","quota_source"]),budget:leaves(["weekly_tokens"])};
const schema:Schema={
  planner:null, providers:{"*":provider}, dispatch:null,
  pacing:leaves(["policy","order","planner_reserve","ahead_threshold","behind_threshold"]),
  routing:null, execution:leaves(["backend","worktree","base_branch"]),
  classifier:{...leaves(["default","shadow","shadow_external","timeout_ms","log_state"]),
    decisions:Object.fromEntries(DECISIONS.map(k=>[k,leaves(["use","min_confidence","verify_kind","max_for_cheap"])])),
    tiers:{"*":null}, adapters:{ollama:leaves(["base_url","model","max_tokens","key_env"]),jev:leaves(["base_url","model","key_env","usd_per_mtok_in","usd_per_mtok_out"])},
    bench:leaves(["redact","timeout_ms"])}
};
function distance(a:string,b:string):number {
  let row=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++) {
    const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+(a[i-1]===b[j-1]?0:1));row=next;
  }
  return row[b.length];
}
export function checkDraftPath(keys:string[],path:string):void {
  let node:Schema|null=schema;
  for(let i=0;i<keys.length;i++) {
    if(node===null)throw new Error(`cannot traverse "${path}"; arrays and scalars replace wholesale; closest known key: "${keys.slice(0,i).join(".")}"`);
    const key=keys[i];
    if(!Object.hasOwn(node,key)&&!Object.hasOwn(node,"*")) {
      const closest=Object.keys(node).sort((a,b)=>distance(key,a)-distance(key,b))[0];
      throw new Error(`unknown strategy key "${path}"; closest known key: "${[...keys.slice(0,i),closest].join(".")}"`);
    }
    node=node[Object.hasOwn(node,key)?key:"*"];
  }
}
