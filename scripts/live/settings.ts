/** Fixed file-only config handler validation; network config.set passes D8 only under CONDITIONAL_OPS. */
import {existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {callOp} from '../../src/api/ops';
import {get} from '../../src/core/config';
import {healthy, liveRoot, record, validId, type Session} from './core';

export function settingsFixtureRoot(session: Session, base = liveRoot): string {
  const expected = join(base, validId(session.id));
  if (session.root !== expected || session.seed !== 'ui' || session.stopped) throw Error('Settings fixture requires an active seeded sandbox');
  for (const path of [base, expected, join(expected, 'evidence'), join(expected, 'home')]) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw Error('Settings fixture requires canonical owned directories');
  }
  const log = join(expected, 'evidence/log.jsonl');
  if (existsSync(log)) {
    const stat = lstatSync(log);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw Error('Settings fixture requires private evidence');
  }
  return join(expected, 'settings-fixture');
}

/** The caller has already checked the active session; verify the immediate parent again before creating its child. */
export function createFixtureHome(home: string): void {
  const parent = join(home, '..');
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || realpathSync(parent) !== parent ||
    parentStat.uid !== process.getuid?.() || (parentStat.mode & 0o077))
    throw Error('Fixture requires a canonical owned private home');
  mkdirSync(home, {mode: 0o700});
  const child = lstatSync(home);
  if (!child.isDirectory() || child.isSymbolicLink() || realpathSync(home) !== home ||
    child.uid !== process.getuid?.() || (child.mode & 0o077))
    throw Error('Fixture requires an exclusive private child');
}

/** Exclusive creation: no existing home, account state or caller-selected settings are accepted. */
export async function exerciseSettingsHome(home: string) {
  createFixtureHome(home);
  writeFileSync(join(home, 'strategy.yaml'), JSON.stringify({planner: 'codex', pacing: {policy: 'priority'}, accounts: {codex: {kind: 'codex', usage: 'quota'}}, runners: {codex: {}}, routing: [{default: ['codex']}]}) + '\n', {mode: 0o600, flag: 'wx'});
  const ctx = {home, pacerHome: home, now: Date.now()/1000, env: {HOME: home, PACER_HOME: home}, which: () => null,
    run: async () => {throw Error('Settings fixture cannot run subprocesses');}};
  const value = () => get(ctx).keys['pacing.policy'].value;
  const before = readFileSync(join(home, 'strategy.yaml'), 'utf8');
  await callOp(ctx, 'config.set', {key: 'pacing.policy', value: 'even'});
  if (value() !== 'even') throw Error('Saved setting did not persist');
  const saved = readFileSync(join(home, 'strategy.yaml'), 'utf8');
  let invalidRejected = false;
  try { await callOp(ctx, 'config.set', {key: 'pacing.policy', value: 'invalid-fixture-policy'}); }
  catch (error) {
    if ((error as {code?: string}).code !== 'invalid_input') throw error;
    invalidRejected = true;
  }
  if (!invalidRejected || readFileSync(join(home, 'strategy.yaml'), 'utf8') !== saved) throw Error('Rejected setting changed persisted config');
  await callOp(ctx, 'config.set', {key: 'pacing.policy', value: 'priority'});
  if (value() !== 'priority' || readFileSync(join(home, 'strategy.yaml'), 'utf8') !== before) throw Error('Setting restore did not preserve original config');
  return {saved: 'even', restored: 'priority', invalidRejected};
}

export async function exerciseSettings(session: Session): Promise<void> {
  const home = settingsFixtureRoot(session);
  if (!await healthy(session)) throw Error('Settings fixture requires a healthy harness service and proxy');
  try {
    await exerciseSettingsHome(home);
    record(session, {kind: 'note', behavior: 'Fixed settings handler save/read/reject/restore', surface: 'API handler fixture', verdict: 'PASS', text: 'Real config handler exercised in a fresh disposable home; D8 unchanged. Browser saves, planner integrations and other settings remain UNVERIFIED.'});
  } catch (error) {
    record(session, {kind: 'note', behavior: 'Fixed settings handler save/read/reject/restore', surface: 'API handler fixture', verdict: 'FAIL', text: 'Fixed settings fixture failed; retained for inspection.'});
    throw error;
  }
}
