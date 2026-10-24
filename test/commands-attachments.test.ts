import { expect, test } from 'bun:test';
import { attachmentCommand } from '../src/commands/attachments';
import { fakeCtx, tmpDir } from './helpers';
import { join } from 'node:path';

test('attachment upload/list/remove use authenticated public HTTP routes', async () => {
  const requests: Request[] = [];
  const endpoint = { base: 'http://127.0.0.1:1234', token: 'fixture-only' };
  const file = join(tmpDir(), 'note.txt'); await Bun.write(file, 'hello');
  const deps = { endpoint: async () => endpoint, fetch: async (request: Request) => { requests.push(request); return Response.json({ id: 'attachment-1' }); } };
  const uploaded = await attachmentCommand(['upload', '--draft', 'draft-1', '--file', file, '--json'], fakeCtx(), deps);
  expect(uploaded.code).toBe(0);
  expect(requests[0].headers.get('authorization')).toBe('Bearer fixture-only');
  expect(new URL(requests[0].url).pathname).toBe('/v3/attachments');
  expect(new URL(requests[0].url).searchParams.get('draft')).toBe('draft-1');
  expect(await requests[0].text()).toBe('hello');
  await attachmentCommand(['list', '--draft', 'draft-1', '--json'], fakeCtx(), deps);
  await attachmentCommand(['remove', '--draft', 'draft-1', '--id', 'attachment-1', '--json'], fakeCtx(), deps);
  expect(requests.map(r => r.method)).toEqual(['POST', 'GET', 'DELETE']);
});
test('attachment errors are structured and do not expose token or overwrite existing files', async () => {
  const path = join(tmpDir(), 'existing'); await Bun.write(path, 'keep');
  const deps = { endpoint: async () => ({ base: 'http://127.0.0.1:1234', token: 'secret-token' }), fetch: async () => new Response('hello') };
  const result = await attachmentCommand(['download', '--draft', 'd', '--id', 'a', '--out', path, '--json'], fakeCtx(), deps);
  expect(result.code).not.toBe(0);
  expect(await Bun.file(path).text()).toBe('keep');
  expect(result.err).not.toContain('secret-token');
  expect(JSON.parse(result.err).error).toBeDefined();
});
