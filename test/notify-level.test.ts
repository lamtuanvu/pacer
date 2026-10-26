import {expect,test} from 'bun:test';
import {join} from 'node:path';
import {mkdirSync,writeFileSync,readFileSync,existsSync,unlinkSync} from 'node:fs';
import {fakeCtx} from './helpers';
import {getLevel,setLevel} from '../src/core/notify';
import {pluginDataDir} from '../src/link/paths';
import {callOp} from '../src/api/ops';
test('notifications work without a plugin and preserve settings',async()=>{const ctx=fakeCtx();mkdirSync(ctx.pacerHome,{recursive:true});writeFileSync(join(ctx.pacerHome,'settings.json'),JSON.stringify({other:42}));expect(await callOp(ctx,'notifications.set',{level:'all'})).toEqual({level:'all'});expect(getLevel(ctx)).toEqual({level:'all'});expect(JSON.parse(readFileSync(join(ctx.pacerHome,'settings.json'),'utf8')).other).toBe(42);});
test('plugin level migrates once',()=>{const ctx=fakeCtx();mkdirSync(pluginDataDir(ctx),{recursive:true});const path=join(pluginDataDir(ctx),'settings.json');writeFileSync(path,'{"notifications":"off"}');expect(getLevel(ctx).level).toBe('off');writeFileSync(path,'{"notifications":"all"}');expect(getLevel(ctx).level).toBe('off');});

test('TypeScript setter waits for the shared notification settings lock', async () => {
  const ctx = fakeCtx();
  mkdirSync(join(ctx.pacerHome, 'orca'), {recursive:true});
  const settings = join(ctx.pacerHome, 'settings.json');
  writeFileSync(settings, '{"notifications":"off"}');
  const lock = join(ctx.pacerHome, 'orca/notification-settings.lock');
  writeFileSync(lock, 'held');
  const marker = join(ctx.pacerHome, 'child-ready');
  const child = Bun.spawn([process.execPath, '-e', `
    import {writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    import {setLevel} from './src/core/notify.ts';
    const home=process.argv[1],marker=process.argv[2];
    writeFileSync(marker,'ready');
    setLevel({home,pacerHome:home,env:{}} as any,'all');
  `, ctx.pacerHome, marker], {cwd:join(import.meta.dir, '..'), stdout:'pipe', stderr:'pipe'});
  try {
    for (let i=0; i<100 && !existsSync(marker); i++) await Bun.sleep(10);
    expect(existsSync(marker)).toBe(true);
    await Bun.sleep(100);
    expect(readFileSync(settings,'utf8')).toBe('{"notifications":"off"}');
  } finally {
    unlinkSync(lock);
  }
  const code = await child.exited;
  expect(code).toBe(0);
  expect(readFileSync(settings,'utf8')).toBe('{"notifications":"all"}');
});
