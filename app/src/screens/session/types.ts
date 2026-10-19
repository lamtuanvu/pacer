import type { Action } from '../../../../src/api/read-model/types';
import type { SessionInfo } from '../../../../src/session/service';
export type { Action };
export interface Resource<T> { data?:T|null; loading?:boolean; error?:string|null }
export interface RetryOption { id:string; agent:string; label:string; reason?:string; available:boolean; action:Action }
/** Presentation data supplied by task.get/task.session and the shell's action runner. */
export interface SessionData {
 id:string; title?:string; goal:string; state:string; executor:string|null; agent:string; repo:string; branch?:string|null; machine?:string|null; started?:string; phase?:string; changesSummary?:string; elapsed?:string;
 review?:{accepted:boolean}|null; resolved?:string; dismissed?:boolean; retriedBy?:string;
 session?:SessionInfo|null; sessionLoading?:boolean; sessionError?:string;
 brief?:Resource<string>; doneWhen?:Resource<string>; changes?:Resource<string>; log?:Resource<string>;
 timeline?:Resource<{at:string;text:string}[]>;
 stop?:Action|null; retryOptions?:RetryOption[]; retryLoading?:boolean; retryError?:string;
}
export interface SessionActions { onAction?:(action:Action)=>void|Promise<unknown>; onAttach?:(id:string,target:'orca'|'terminal')=>void|Promise<{opened:boolean;command?:string}|void> }
