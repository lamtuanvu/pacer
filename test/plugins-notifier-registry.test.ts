import { expect, test } from 'bun:test';
import { PluginRegistry } from '../src/plugins/registry';
import { fakeCtx } from './helpers';
import type { BundledPlugin } from '../src/plugins/types';

test('all notifier providers are selected by id rather than bundle priority', async () => {
  const bundles = ['zz-notify','aa-notify'].map(id => ({manifest:{id,version:'0.1.0',publisher:'test',host:'^1.6',contributes:{notifier:{kinds:['os']}},capabilities:[],reentrant:false,tier:'free'},main:async()=>({handlers:{}})})) as BundledPlugin[];
  const registry = new PluginRegistry({bundled:bundles,spawnBundled:()=>{throw new Error('selection must not spawn');}});
  try {
    expect(registry.findAll(fakeCtx(), 'notifier')).toEqual(['aa-notify','zz-notify']);
    expect(registry.findAll(fakeCtx(), 'notifier', c => Array.isArray(c.kinds) && c.kinds.includes('email'))).toEqual([]);
  } finally { await registry.shutdown(); }
});

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUNDLED } from '../plugins/bundled';
test('canonical notifier receives immutable host platform in hello and config.get', async () => {
  const root=mkdtempSync(join(tmpdir(),'pacer-notifier-config-'));
  const ctx=fakeCtx({home:root,pacerHome:join(root,'.pacer')});
  mkdirSync(ctx.pacerHome);
  writeFileSync(join(ctx.pacerHome,'strategy.yaml'),'planner: claude-code\nproviders:\n  claude-code: {}\nplugins:\n  config:\n    pacer-notify:\n      platform: forged\n      binary: evil\n');
  const canonical=BUNDLED.find(b=>b.manifest.id==='pacer-notify')!;
  const registry=new PluginRegistry({bundled:[canonical],spawnBundled:()=>({argv:[process.execPath,join(import.meta.dir,'fixtures/notifier-config/peer.ts')],cwd:root,env:{}})});
  try {
    expect(await registry.call(ctx,'pacer-notify','notifier.deliver',{key:'k',title:'t',body:'b',url:'/'})).toEqual({delivered:true});
  } finally {await registry.shutdown();rmSync(root,{recursive:true,force:true});}
});
