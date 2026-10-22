import {expect,test} from 'bun:test';
import {mkdirSync,readFileSync,symlinkSync,writeFileSync,linkSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpDir} from './helpers';
import {saveSession,sandboxEnv,type Session} from '../scripts/live/core';
import {seedUi} from '../scripts/live/seed';
import {agentPreview} from '../src/core/setup';
import {ownProcessIdentity} from '../src/update/desktop/process-identity';
import {authorizeSeedRepair} from '../scripts/live/repair';

function fixture() {
 const root=join(realpathSync(tmpDir()),'repair');
 mkdirSync(root);
 const identity=ownProcessIdentity()!;
 const session:Session={id:'repair',root,seed:'ui',pid:process.pid,serviceIdentity:identity,port:49670,innerPort:49671,createdAt:new Date().toISOString()};
 seedUi(root);saveSession(session);
 const home=join(root,'home');
 const ctx={home,pacerHome:home,now:Date.now()/1000,env:sandboxEnv(session),which:()=>null,run:async()=>{throw Error('No subprocess allowed');}};
 const params={agent:'codex',consent:true,preview_revision:agentPreview(ctx,'codex').revision};
 const request=(body:unknown=params,path='/v3/ops/agent.connect')=>new Request(`http://127.0.0.1:${session.port}${path}`,{method:'POST',headers:{origin:`http://127.0.0.1:${session.port}`,'x-pacer-client':'app'},body:JSON.stringify(body)});
 return {session,home,params,request,ctx};
}

test('seeded live repair permits only the exact reviewed Codex sandbox target',async()=>{
 const {session,request}=fixture();
 expect(await authorizeSeedRepair(session,request())).toBe(true);
 expect(await authorizeSeedRepair({...session,seed:undefined},request())).toBe(false);
 expect(await authorizeSeedRepair(session,request(undefined,'/v2/ops/agent.connect'))).toBe(false);
 expect(await authorizeSeedRepair(session,request(undefined,'/v3/ops/agent.disconnect'))).toBe(false);
});

test('live repair refuses missing consent, stale revisions, extra fields and other agents',async()=>{
 const {session,params,request}=fixture();
 for(const body of [{...params,consent:false},{...params,preview_revision:'stale'},{...params,agent:'claude-code'},{...params,folder:tmpDir()},{}])
  expect(await authorizeSeedRepair(session,request(body))).toBe(false);
});

test('live repair refuses changed accounts, external homes and service identities',async()=>{
 const {session,home,request}=fixture();
 expect(await authorizeSeedRepair({...session,serviceIdentity:{...session.serviceIdentity!,birth:'wrong'}},request())).toBe(false);
 const path=join(home,'strategy.yaml'),strategy=JSON.parse(readFileSync(path,'utf8'));
 strategy.accounts.team.home=tmpDir();writeFileSync(path,JSON.stringify(strategy));
 expect(await authorizeSeedRepair(session,request())).toBe(false);
});

for(const kind of ['directory symlink','file symlink','hardlink'])test(`live repair rejects ${kind} escapes`,async()=>{
 const {session,home,request}=fixture();
 const external=join(tmpDir(),'outside');writeFileSync(external,'private sentinel');
 const folder=join(home,'accounts/team');
 if(kind==='directory symlink')symlinkSync(tmpDir(),join(folder,'skills'));
 else if(kind==='file symlink')symlinkSync(external,join(folder,'hooks.json'));
 else linkSync(external,join(folder,'hooks.json'));
 expect(await authorizeSeedRepair(session,request())).toBe(false);
 expect(readFileSync(external,'utf8')).toBe('private sentinel');
});

test('a real seeded repair leaves one intact account-specific install record',async()=>{
 const {session,ctx}=fixture();
 const {callOp}=await import('../src/api/ops');
 writeFileSync(join(ctx.home,'accounts/team/AGENTS.md'),'broken integration');
 const preview=agentPreview(ctx,'codex');
 await callOp(ctx,'agent.connect',{agent:'codex',consent:true,preview_revision:preview.revision});
 const report=await callOp(ctx,'doctor.run',{}) as {checks:{name:string;level:string}[]};
 expect(report.checks.filter(check=>check.name.startsWith('Install '))).toEqual([
  expect.objectContaining({name:'Install codex#team',level:'ok'}),
 ]);
 expect(Object.keys(JSON.parse(readFileSync(join(session.root,'home/install-manifest.json'),'utf8')).planners)).toEqual(['codex#team']);
});
