import { encodeCmdLine } from "../../../src/link/envelope";
export interface WorktreeContext {worktreeId?:string;branch:string;displayName:string;terminals:{id:string}[]}
/** Reference encoder for form payloads. Reject oversized inputs; never shorten a brief. */
export function delegateLine(context:WorktreeContext|null, goal:string, acceptance:string, executor?:string):string {
 if(!context?.branch) throw new Error("Focus a worktree first.");
 if(!goal.trim()) throw new Error("What should be done is required.");
 if(goal.length>2000) throw new Error("Goal must be at most 2000 characters.");
 if(acceptance.length>500) throw new Error("Done when must be at most 500 characters.");
 if(executor&&!/^(?=.{1,64}$)[a-z0-9-]+(?:#[a-z0-9-]+)?$/.test(executor)) throw new Error("Invalid executor.");
 return encodeCmdLine({cmd:"delegate",branch:context.branch,displayName:context.displayName,...(context.worktreeId?{worktreeId:context.worktreeId}:{}),goal,acceptance,...(executor?{executor}:{})});
}
