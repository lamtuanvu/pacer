import {expect,test} from 'bun:test';
import {bundledPluginSpawn} from '../src/plugins/index';
import {fakeCtx} from './helpers';
import {fileURLToPath} from 'node:url';
const runtime={executable:'/fixture/bin/bun',bunVersion:'1.4.2'};
test('source front door retains wrapper routing but replaces raw selector with this host source',()=>{
 const ctx=fakeCtx({env:{PACER_BIN:'/fixture/guard',PACER_CORE_ARGV:'["/untrusted/selector","private-marker"]',SECRET:'private-marker'}});
 const spec=bundledPluginSpawn(ctx,'pacer-usage',runtime);
 expect(spec.argv).toEqual(['/fixture/guard','plugin','run','pacer-usage']);
 expect(spec.env).toEqual({PACER_CORE_ARGV:JSON.stringify([runtime.executable,fileURLToPath(new URL('../src/cli.ts',import.meta.url))])});
 expect(JSON.stringify(spec.env)).not.toContain('private-marker');
});
test('ordinary guards and compiled core launches do not receive a source selector',()=>{
 const ctx=fakeCtx({env:{PACER_BIN:'/fixture/guard'}});expect(bundledPluginSpawn(ctx,'pacer-usage',runtime).env).toEqual({});
 ctx.env.PACER_CORE_ARGV='["/untrusted"]';expect(bundledPluginSpawn(ctx,'pacer-usage',{executable:'/fixture/pacer-core',bunVersion:'1.4.2'}).env).toEqual({});
 expect(bundledPluginSpawn(ctx,'pacer-usage',{executable:'/fixture/bun'}).env).toEqual({});
});
