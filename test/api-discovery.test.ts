import { expect, test } from 'bun:test';
import { callOp, opNames, opJsonSchemas } from '../src/api/ops';
import { InProcessClient } from '../src/api/client';
import { fakeCtx } from './helpers';

test('discovery lists compact sorted registry metadata including itself and combines filters', async () => {
  const ctx = fakeCtx();
  const all = await callOp(ctx, 'api.list', {}) as any;
  expect(all.protocol).toBe('3.0.0');
  expect(all.ops.map((x: any) => x.name)).toEqual(opNames());
  expect(all.ops.find((x: any) => x.name === 'api.describe')).toBeDefined();
  expect(all.ops.every((x: any) => !('params' in x))).toBe(true);
  const filtered = await callOp(ctx, 'api.list', { prefix: 'runner.', search: 'SETTINGS' }) as any;
  expect(filtered.ops.map((x: any) => x.name)).toContain('runner.settings.get');
  expect(filtered.ops.every((x: any) => x.name.startsWith('runner.'))).toBe(true);
  expect((await callOp(ctx, 'api.list', { search: 'no-such-capability' }) as any).ops).toEqual([]);
});

test('describe returns one exact JSON parameter schema and rejects unknown operations', async () => {
  const ctx = fakeCtx();
  const info = await callOp(ctx, 'api.describe', { name: 'runner.settings.save' }) as any;
  expect(info.name).toBe('runner.settings.save');
  expect(info.params).toEqual(opJsonSchemas()['runner.settings.save'].params);
  await expect(callOp(ctx, 'api.describe', { name: '__proto__' })).rejects.toMatchObject({ code: 'unknown_op' });
});

test('v3 local client really uses current operations and current errors', async () => {
  const client = new InProcessClient(() => fakeCtx(), { protocol: 3 });
  expect((await client.hello()).protocol).toBe('3.0.0');
  expect((await client.call<any>('api.list')).ops.length).toBeGreaterThan(0);
  await expect(client.call('task.review', { id: 'missing', accepted: true })).rejects.toMatchObject({ code: 'invalid_input' });
  client.close();
});

test('local fallback refuses facilities owned by the running service', async () => {
  const client = new InProcessClient(() => fakeCtx(), {protocol:3});
  for(const name of ['client.control.enroll','client.control.targets','session.create','session.resume','task.takeover','desktop.capture.targets']) {
    await expect(client.call(name,{})).rejects.toMatchObject({code:'not_allowed'});
  }
  expect((await client.call<any>('api.list',{prefix:'session.'})).ops.length).toBeGreaterThan(0);
});
