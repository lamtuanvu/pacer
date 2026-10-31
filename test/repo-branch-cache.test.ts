import { expect, test } from 'bun:test';
import { createRepoBranchReader } from '../src/core/repos';
import { fakeCtx } from './helpers';

test('branch metadata coalesces, expires after two seconds and stays scoped to each home', async () => {
  let now = 0, calls = 0, branch = 'main';
  const read = createRepoBranchReader(() => now);
  const ctx = fakeCtx({ run: async args => {
    calls++;
    return { code: 0, stderr: '', stdout: args.includes('symbolic-ref') ? branch : `${branch}\nother\n` };
  } });
  const [a, b] = await Promise.all([read(ctx, '/fixture'), read(ctx, '/fixture')]);
  expect(calls).toBe(2);
  expect(a).toEqual(['main', 'other']);
  expect(b).toEqual(a);
  a.push('mutated');
  expect(await read(ctx, '/fixture')).toEqual(['main', 'other']);
  branch = 'next'; now = 1999;
  expect((await read(ctx, '/fixture'))[0]).toBe('main');
  now = 2000;
  expect((await read(ctx, '/fixture'))[0]).toBe('next');
  expect(calls).toBe(4);
  await read({ ...ctx, pacerHome: ctx.pacerHome + '-other' }, '/fixture');
  expect(calls).toBe(6);
});

test('failed branch reads are not retained and removed metadata is read again after expiry', async () => {
  let now = 0, fail = true, calls = 0;
  const read = createRepoBranchReader(() => now);
  const ctx = fakeCtx({ run: async args => {
    calls++;
    return { code: fail ? 1 : 0, stderr: '', stdout: fail ? '' : args.includes('symbolic-ref') ? 'main' : 'main\n' };
  } });
  expect(await read(ctx, '/fixture')).toEqual([]);
  fail = false;
  expect(await read(ctx, '/fixture')).toEqual(['main']);
  expect(calls).toBe(4);
  now = 2000; fail = true;
  expect(await read(ctx, '/fixture')).toEqual([]);
  expect(calls).toBe(6);
});

test('a slow branch read remains single flight across expiry', async () => {
  let now = 0, calls = 0;
  let release!: (value: { code: number; stdout: string; stderr: string }) => void;
  const read = createRepoBranchReader(() => now);
  const ctx = fakeCtx({ run: async args => {
    calls++;
    if (args.includes('symbolic-ref')) return new Promise(resolve => { release = resolve; });
    return { code: 0, stdout: 'main\n', stderr: '' };
  } });
  const first = read(ctx, '/fixture');
  await Promise.resolve(); await Promise.resolve();
  now = 2001;
  const second = read(ctx, '/fixture');
  await Promise.resolve(); await Promise.resolve();
  expect(calls).toBe(1);
  release({ code: 0, stdout: 'main', stderr: '' });
  expect(await first).toEqual(['main']);
  expect(await second).toEqual(['main']);
  expect(calls).toBe(2);
});

test('thrown Git failures retry immediately and completed branch history is bounded', async () => {
  let fail = true, calls = 0;
  const read = createRepoBranchReader(() => 0);
  const ctx = fakeCtx({ run: async args => {
    calls++;
    if (fail) throw Error('unavailable');
    return { code: 0, stdout: args.includes('symbolic-ref') ? 'main' : 'main\n', stderr: '' };
  } });
  await expect(read(ctx, '/fixture-error')).rejects.toMatchObject({ code: 'invalid_input' });
  fail = false;
  expect(await read(ctx, '/fixture-error')).toEqual(['main']);
  expect(calls).toBe(3);
  for (let i = 0; i < 128; i++) await read(ctx, `/fixture-${i}`);
  await read(ctx, '/fixture-error');
  expect(calls).toBe(261);
});

test('detached and unborn branch reads stay valid while fatal HEAD failures are retried', async () => {
  for (const mode of ['detached', 'unborn', 'fatal'] as const) {
    let calls = 0;
    const read = createRepoBranchReader(() => 0);
    const ctx = fakeCtx({ run: async args => {
      calls++;
      if (args.includes('symbolic-ref')) return { code: mode === 'detached' ? 1 : mode === 'fatal' ? 128 : 0, stdout: mode === 'unborn' ? 'main' : '', stderr: '' };
      return { code: 0, stdout: mode === 'unborn' ? '' : 'main\nother\n', stderr: '' };
    } });
    const branches = mode === 'unborn' ? ['main'] : ['main', 'other'];
    expect(await read(ctx, '/fixture')).toEqual(branches);
    expect(await read(ctx, '/fixture')).toEqual(branches);
    expect(calls).toBe(mode === 'fatal' ? 4 : 2);
  }
});
