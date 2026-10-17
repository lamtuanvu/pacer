import {expect,test} from 'bun:test';
import {join} from 'node:path';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {fakeCtx} from './helpers';
import {getLevel,setLevel} from '../src/core/notify';
import {pluginDataDir} from '../src/link/paths';
import {callOp} from '../src/api/ops';
test('notifications work without a plugin and preserve settings',async()=>{const ctx=fakeCtx();mkdirSync(ctx.pacerHome,{recursive:true});writeFileSync(join(ctx.pacerHome,'settings.json'),JSON.stringify({other:42}));expect(await callOp(ctx,'notifications.set',{level:'all'})).toEqual({level:'all'});expect(getLevel(ctx)).toEqual({level:'all'});expect(JSON.parse(readFileSync(join(ctx.pacerHome,'settings.json'),'utf8')).other).toBe(42);});
test('plugin level migrates once',()=>{const ctx=fakeCtx();mkdirSync(pluginDataDir(ctx),{recursive:true});const path=join(pluginDataDir(ctx),'settings.json');writeFileSync(path,'{"notifications":"off"}');expect(getLevel(ctx).level).toBe('off');writeFileSync(path,'{"notifications":"all"}');expect(getLevel(ctx).level).toBe('off');});
