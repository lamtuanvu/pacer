import {expect,test} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {makeCtx} from '../src/ctx';
import {BUNDLED} from '../plugins/bundled';
import {PluginRegistry} from '../src/plugins/registry';
import {testManagedEndpoint} from '../src/plugins/endpoint-test';
test('real endpoint plugin runs owned stub test with injected key and cleans disposable git repository',async()=>{
 const root=mkdtempSync(join(tmpdir(),'pacer-endpoint-test-')),script=join(root,'owned-opencode'),receipt=join(root,'receipt');
 writeFileSync(script,`#!/bin/sh\n[ "$PACER_KEY_OWNED" = "owned-test-fixture" ] || exit 7\n[ "$PACER_ROLE" = "executor" ] || exit 8\n[ -d .git ] || exit 9\nprintf '%s' "$PWD" > '${receipt}'\nprintf ok > hello.txt\n`,{mode:0o700});
 const ctx=makeCtx({home:root,pacerHome:root,env:{PATH:'/usr/bin:/bin',TEST_KEY:'owned-test-fixture',OPENCODE_CONFIG_CONTENT:'{"token":"config-private-fixture"}'},which:name=>name==='opencode'?script:Bun.which(name)});
 const account={name:'owned',connection:{api:'openai-compatible',base_url:'http://endpoint.invalid/v1',key:'env:TEST_KEY',models:[]}};
 const runner={id:'opencode#owned',account:'owned',agent:'opencode',model:'pacer-owned/m',host:null};
 const bundle=BUNDLED.find(value=>value.manifest.id==='pacer-endpoints')!;
 const registry=new PluginRegistry({bundled:[bundle],spawnBundled:()=>({argv:[process.execPath,join(import.meta.dir,'../plugins/pacer-endpoints/index.ts')],cwd:root,env:{}})});
 try{
 expect(await testManagedEndpoint(ctx,{owned:account} as any,'owned',runner as any,registry)).toEqual({state:'ready',checked_at:new Date(ctx.now*1000).toISOString()});
 const repo=readFileSync(receipt,'utf8');expect(repo.startsWith(join(realpathSync(root),'endpoints','test-'))).toBe(true);expect(existsSync(repo)).toBe(false);
 const config=readFileSync(join(root,'opencode/opencode.json'),'utf8');expect(config).toContain('{env:PACER_KEY_OWNED}');expect(config).not.toContain('owned-test-fixture');expect(config).not.toContain('config-private-fixture');
 }finally{await registry.shutdown();rmSync(root,{recursive:true,force:true});}
});
