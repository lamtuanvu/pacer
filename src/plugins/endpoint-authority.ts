import type {CallResources} from './authority';
import {CoreError} from '../core/errors';
/** Canonical bundled endpoint maximum declaration is specialized to host-issued targets per call. */
export function endpointHttpScopes(canonical:boolean,method:string,declared:readonly string[],resources:Readonly<CallResources>):readonly string[]{
 if(!canonical||!['endpoint.models','endpoint.test'].includes(method))return declared;
 if(declared.length!==1||declared[0]!=='*')throw new CoreError('capability_denied','canonical endpoint HTTP declaration changed');
 const hosts=resources.http?.hosts;
 if(method==='endpoint.test'&&!hosts?.length)return Object.freeze([]);
 if(!hosts?.length)throw new CoreError('capability_denied','endpoint call requires exact host-issued HTTP targets');
 for(const host of hosts){
  try{const url=new URL('http://'+host);if(host.includes('*')||url.hostname!==host||url.username||url.password||url.port||url.pathname!=='/'||url.search||url.hash)throw Error();}
  catch{throw new CoreError('capability_denied','endpoint call requires exact host-issued HTTP targets');}
 }
 return Object.freeze([...hosts]);
}
