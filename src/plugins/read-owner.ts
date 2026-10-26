import {randomBytes} from 'node:crypto';
import {CoreError} from '../core/errors';
import type {Ctx} from '../types';
import type {PluginManifest} from './protocol';

/** Process-generation read authority. Never contains CallAuthority or effect resources. */
export class ReadOwner {
  readonly token = `pro_${randomBytes(32).toString('hex')}`;
  readonly ctx:Ctx;
  private readonly issuedAt:number;
  private elapsed=0;
  private retired = false;
  private readonly allowed: ReadonlySet<string>;
  constructor(ctx:Ctx, manifest:PluginManifest, grants:readonly string[], private readonly current:()=>boolean,private readonly clock=Date.now) {
    this.issuedAt=clock();
    const {operation:_operation,...retained}=ctx;
    this.ctx=Object.freeze({...retained,env:Object.freeze({...ctx.env}),readOnly:true});
    this.allowed = new Set(manifest.capabilities.map(capability=>capability.name)
      .filter(name=>grants.includes(name)&&['tasks.read','events.subscribe'].includes(name)));
  }
  assertActive():void {
    if(this.retired)throw new CoreError('capability_denied','read owner retired');
    if(!this.current()) {this.revoke();throw new CoreError('capability_denied','read owner generation changed');}
  }
  assertGranted(name:string):void {
    this.assertActive();
    if(!this.allowed.has(name))throw new CoreError('capability_denied','read owner cannot authorize this capability');
  }
  readContext():Ctx {
    this.elapsed=Math.max(this.elapsed,this.clock()-this.issuedAt);
    return {...this.ctx,now:this.ctx.now+this.elapsed/1000};
  }
  revoke():void {this.retired=true;}
}
