/** Loopback HTTP used to discover the versioned API. */
export interface HttpPort {
 post?(url:string,token:string,body:unknown,timeoutMs:number):Promise<{status:number;body:string;headers?:Record<string,string|string[]|undefined>}>;
 get(url:string,token:string,timeoutMs:number):Promise<{status:number;body:string;headers?:Record<string,string|string[]|undefined>}>;
 stream(url:string,token:string,onLine:(line:string)=>void,onClose:(err?:Error)=>void):()=>void;
}
