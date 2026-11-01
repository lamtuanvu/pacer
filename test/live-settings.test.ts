import {expect, test} from 'bun:test';
import {chmodSync, mkdirSync, readFileSync, realpathSync, symlinkSync, linkSync, writeFileSync, renameSync} from 'node:fs';
import {join} from 'node:path';
import {tmpDir} from './helpers';
import {settingsFixtureRoot, exerciseSettingsHome} from '../scripts/live/settings';
import type {Session} from '../scripts/live/core';

function fixture() {
  const base=realpathSync(tmpDir()), root=join(base,'settings');
  mkdirSync(root,{mode:0o700});mkdirSync(join(root,'evidence'),{mode:0o700});mkdirSync(join(root,'home'),{mode:0o700});
  const session:Session={id:'settings',root,seed:'ui',pid:process.pid,port:49192,innerPort:49193,createdAt:new Date().toISOString()};
  return {session,base};
}

test('settings fixture accepts only a canonical active seeded sandbox',()=>{
  const {session,base}=fixture();
  expect(settingsFixtureRoot(session,base)).toBe(join(session.root,'settings-fixture'));
  for(const changed of [{seed:undefined},{stopped:true},{root:tmpDir()},{id:'../escape'}])
    expect(()=>settingsFixtureRoot({...session,...changed},base)).toThrow();
  const link=join(session.root,'evidence-link');symlinkSync(join(session.root,'evidence'),link);
  expect(()=>settingsFixtureRoot({...session,root:link},base)).toThrow();
});

test('fixed settings exercise saves, reads, rejects invalid input and restores in a disposable home',async()=>{
  const root=join(realpathSync(tmpDir()),'exclusive');
  const result=await exerciseSettingsHome(root);
  expect(result).toEqual({saved:'even',restored:'priority',invalidRejected:true});
  expect(JSON.parse(readFileSync(join(root,'strategy.yaml'),'utf8')).pacing.policy).toBe('priority');
  await expect(exerciseSettingsHome(root)).rejects.toThrow();
});

for (const kind of ['symlink', 'hardlink'] as const) test(`settings fixture refuses ${kind} evidence without touching its target`, () => {
  const {session,base}=fixture();
  const outside=join(tmpDir(),'sentinel');writeFileSync(outside,'untouched');
  const log=join(session.root,'evidence/log.jsonl');
  if(kind==='symlink') symlinkSync(outside,log); else linkSync(outside,log);
  expect(()=>settingsFixtureRoot(session,base)).toThrow('private evidence');
  expect(readFileSync(outside,'utf8')).toBe('untouched');
});

test('settings fixture refuses a redirected evidence directory', () => {
  const {session,base}=fixture();
  const evidence=join(session.root,'evidence');renameSync(evidence,evidence+'-old');
  symlinkSync(tmpDir(),evidence);
  expect(()=>settingsFixtureRoot(session,base)).toThrow('canonical owned directories');
});

test('settings fixture refuses a redirected home without touching its target', () => {
  const {session,base}=fixture();
  const outside=tmpDir();
  writeFileSync(join(outside,'sentinel'),'untouched');
  renameSync(join(session.root,'home'),join(session.root,'old-home'));
  symlinkSync(outside,join(session.root,'home'));
  expect(()=>settingsFixtureRoot(session,base)).toThrow('canonical owned directories');
  expect(readFileSync(join(outside,'sentinel'),'utf8')).toBe('untouched');
});

test('settings fixture refuses a permissive sandbox home', () => {
  const {session,base}=fixture();
  chmodSync(join(session.root,'home'),0o755);
  expect(()=>settingsFixtureRoot(session,base)).toThrow('canonical owned directories');
});
