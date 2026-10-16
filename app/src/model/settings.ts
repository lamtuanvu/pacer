export interface AgentPreview {agent:string;files:string[];undo:string}
export function plannerAgent(planner:string) { return planner.split(/[#@]/)[0]!; }
export function consentAction(preview:AgentPreview|undefined,planner?:string,integrations:'install'|'skip'='install') {
 if(!preview||planner&&preview.agent!==plannerAgent(planner)) throw Error('Review the changes for this agent first.');
 return planner?{op:'config.set',params:{key:'planner',value:planner,integrations}}:{op:'agent.connect',params:{agent:preview.agent,consent:true}};
}
export function updateModel(report:{current?:string;latest?:string|null;available?:boolean;error?:string;disabled?:boolean}|undefined,updating:boolean) {
 if(updating) return {label:'Updating… pacer will restart',canUpdate:false};
 if(report?.error) return {label:'Update check failed',canUpdate:false};
 if(report?.disabled) return {label:'Update checking disabled',canUpdate:false};
 const canUpdate=report?.available===true;
 return {label:canUpdate?`Update available: ${report!.latest}`:report?.latest?'Up to date':'Not checked',canUpdate};
}
