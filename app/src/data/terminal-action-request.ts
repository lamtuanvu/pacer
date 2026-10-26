const TERMINAL_ACTIONS = new Set(["account.signin", "runner.add", "host.terminal", "strategy.build"]);

/** Keep a launch identity after an ambiguous transport failure. */
export class TerminalActionRequests {
  private pending = new Map<string,string>();
  constructor(private readonly generate: () => string) {}

  prepare(op: string, params: unknown): {params: unknown; key?: string} {
    if (!TERMINAL_ACTIONS.has(op) || !params || typeof params !== "object" || Array.isArray(params) || "request_id" in params) return {params};
    const key=`${op}:${JSON.stringify(params)}`;
    let id=this.pending.get(key);
    if(!id){id=this.generate();this.pending.set(key,id);}
    return {params:{...params,request_id:id},key};
  }

  finish(key?:string,errorStatus?:number):void {
    if(key && (errorStatus === undefined || errorStatus >= 400 && errorStatus < 500)) this.pending.delete(key);
  }
}
