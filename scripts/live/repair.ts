/** Scripts-only permission for the fixed Codex integration in a seeded UI sandbox. */
import {lstatSync,readFileSync,readdirSync,realpathSync} from 'node:fs';
import {dirname,join,relative,resolve,sep} from 'node:path';
import {z} from 'zod';
import {agentPreview} from '../../src/core/setup';
import {loadStrategy} from '../../src/config/strategy';
import {processIdentity,sameProcess} from '../../src/update/desktop/process-identity';
import {loadSession,sandboxEnv,type Session} from './core';

const repair = z.object({agent:z.literal('codex'),consent:z.literal(true),preview_revision:z.string().regex(/^[a-f0-9]{64}$/)}).strict();

/** Reject redirects through symlinks, hardlinks, special files or oversized fixture trees. */
function safePath(root:string,path:string,recursive=false): boolean {
  const tail=relative(root,path);
  if(tail==='..'||tail.startsWith(`..${sep}`)||resolve(root,tail)!==path)return false;
  let current=root;
  for(const part of ['',...tail.split(sep).filter(Boolean)]) {
    if(part)current=join(current,part);
    try {
      const stat=lstatSync(current);
      if(stat.isSymbolicLink()||(!stat.isDirectory()&&(!stat.isFile()||stat.nlink!==1)))return false;
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return true;throw error;}
  }
  let remaining=256;
  const walk=(entry:string,depth:number):boolean=>{
    if(--remaining<0||depth>16)return false;
    const stat=lstatSync(entry);
    if(stat.isSymbolicLink())return false;
    if(stat.isFile())return stat.nlink===1;
    return stat.isDirectory()&&readdirSync(entry).every(name=>walk(join(entry,name),depth+1));
  };
  return !recursive||walk(path,0);
}

export async function authorizeSeedRepair(session:Session,request:Request):Promise<boolean> {
  try {
    const url=new URL(request.url),origin=`http://127.0.0.1:${session.port}`;
    if(session.seed!=='ui'||session.stopped||request.method!=='POST'||url.pathname!=='/v3/ops/agent.connect'||url.search||
      ![origin,`http://localhost:${session.port}`].includes(request.headers.get('origin')??'')||request.headers.get('x-pacer-client')!=='app')return false;
    const reader=request.clone().body?.getReader();
    if(!reader)return false;
    const chunks:Uint8Array[]=[];let size=0;
    try {
      while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>4096)return false;chunks.push(next.value);}
    }finally{await reader.cancel();}
    const params=repair.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const recorded=loadSession(session.id,dirname(session.root));
    if(recorded.seed!=='ui'||recorded.stopped||recorded.root!==session.root||recorded.port!==session.port||recorded.innerPort!==session.innerPort||
      !sameProcess(recorded.serviceIdentity??null,session.serviceIdentity??null)||!sameProcess(session.serviceIdentity??null,processIdentity(session.pid)))return false;
    // Seed mode starts the service with HOME and tool config directories redirected here.
    const root=realpathSync(session.root);
    if(root!==session.root||lstatSync(root).isSymbolicLink())return false;
    const home=join(root,'home'),folder=join(home,'accounts/team');
    if(!safePath(root,folder,true)||!safePath(root,join(home,'strategy.yaml'))||!safePath(root,join(home,'install-manifest.json')))return false;
    const env=sandboxEnv(session),ctx={home,pacerHome:home,env,now:Date.now()/1000,which:()=>null,
      run:async()=>{throw Error('Repair authorization cannot run subprocesses');}};
    const strategy=loadStrategy(ctx),account=strategy.accounts.team;
    if(strategy.planner.agent!=='codex'||strategy.planner.account!=='team'||account?.source!=='pacer'||account.home!==folder)return false;
    const preview=agentPreview(ctx,'codex');
    if(preview.revision!==params.preview_revision)return false;
    const expected=[join(folder,'AGENTS.md'),join(folder,'hooks.json'),join(folder,'skills/pacer/SKILL.md')].sort();
    if(JSON.stringify([...preview.files].sort())!==JSON.stringify(expected))return false;
    // Prior records cannot introduce external paths (including rollback/backup metadata).
    const manifest=JSON.parse(readFileSync(join(home,'install-manifest.json'),'utf8'));
    for(const record of Object.values(manifest.planners??{}) as {files?:{path:string;backup?:string}[]}[]) {
      for(const file of record.files??[])if(!safePath(root,file.path)||file.backup&&!safePath(root,file.backup))return false;
    }
    return true;
  }catch{return false;}
}
