import { afterEach, expect, test } from 'bun:test';
import { createCallAuthority, type CallAuthority } from '../src/plugins/authority';
import { prepareHttpAuthority } from '../src/plugins/http-authority';
import { fakeCtx } from './helpers';
import { answerCapability } from '../src/plugins/host';
import { manifestSchema } from '../src/plugins/protocol';
const manifest = manifestSchema.parse({ id: 'http-fixture', version: '1.0.0', publisher: 'fixture', host: '^1.2', capabilities: [{ name: 'net.http', scopes: ['127.0.0.1'] }] });
function answerHttp(a: CallAuthority, method: string, params: unknown, transport: any) {
  return answerCapability(a.ctx, { id: manifest.id, manifest }, method, params, a, undefined, transport);
}
const owners: CallAuthority[] = [];
const servers: Bun.Server<undefined>[] = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map(a => a.revoke()));
  await Promise.all(servers.splice(0).map(s => s.stop(true)));
});
function fixture() {
  let effects = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => { effects++; return new Response('\0'.repeat(300000)); } });
  servers.push(server);
  const authority = createCallAuthority(fakeCtx(), { reads: [], stores: [], commands: [], http: { hosts: ['127.0.0.1'] } }, { grants: ['net.http'], deadlineMs: Date.now() + 5000 });
  owners.push(authority);
  prepareHttpAuthority(authority, { declaredScopes: ['127.0.0.1'], explicitWildcardGrant: false });
  const transport = { features: ['httpBodyChunks'], requestFits: () => true, resultFits: (r: unknown) => Buffer.byteLength(JSON.stringify(r)) < 1048500 };
  return { authority, transport, request: { url: server.url.href, method: 'GET', timeoutMs: 1000 }, get effects() { return effects; } };
}
test('pending response refuses successor network effects until release', async () => {
  const f = fixture();
  const result: any = await answerHttp(f.authority, 'capability.net.http', f.request, f.transport);
  expect(typeof result.body.handle).toBe('string'); expect(f.effects).toBe(1);
  await expect(answerHttp(f.authority, 'capability.net.http', f.request, f.transport)).rejects.toMatchObject({ code: 'conflict' });
  expect(f.effects).toBe(1);
  await answerHttp(f.authority, 'capability.net.http.body.release', { handle: result.body.handle }, f.transport);
  expect((await answerHttp(f.authority, 'capability.net.http', f.request, f.transport) as any).status).toBe(200);
  expect(f.effects).toBe(2);
});
test('unnegotiated body methods and oversized metadata have no effects', async () => {
  const f = fixture();
  await expect(answerHttp(f.authority, 'capability.net.http.body.begin', { bytes: 1 }, { ...f.transport, features: [] })).rejects.toMatchObject({ code: 'capability_denied' });
  await expect(answerHttp(f.authority, 'capability.net.http', f.request, { ...f.transport, requestFits: () => false })).rejects.toMatchObject({ code: 'invalid_input' });
  expect(f.effects).toBe(0);
  expect((await answerHttp(f.authority, 'capability.net.http', f.request, f.transport) as any).status).toBe(200);
});

test('wire envelope checks do not count schema-inserted authorization defaults', async () => {
  const f = fixture(); f.authority.ctx.env.KEY = 'fixture-only';
  const seen: unknown[] = [];
  const transport = { ...f.transport, requestFits: (p: unknown) => { seen.push(p); return !Object.hasOwn((p as any).authorization, 'scheme'); } };
  const result: any = await answerHttp(f.authority, 'capability.net.http', { ...f.request, authorization: { secretRef: 'env:KEY' } }, transport);
  expect(result.status).toBe(200); expect(f.effects).toBe(1);
  expect(seen.length).toBeGreaterThan(0);
});
