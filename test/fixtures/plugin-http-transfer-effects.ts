import { createCallAuthority } from '../../src/plugins/authority';
import { prepareHttpAuthority } from '../../src/plugins/http-authority';
import { answerHttp } from '../../src/plugins/capability-http';
import { fakeCtx } from '../helpers';

const outcomes: unknown[] = [];
let effects: unknown[] = [];
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  effects.push(await request.text());
  return new Response('\0'.repeat(300000));
} });
try {
  for (const field of ['bytes', 'stageOffset', 'readOffset', 'length']) {
    for (const literal of ['0.0', '0e0', '3.0', '3e0', '1.5', '9007199254740992']) {
      const authority = createCallAuthority(fakeCtx(), { reads: [], commands: [], stores: [], http: { hosts: ['127.0.0.1'] } },
        { grants: ['net.http'], deadlineMs: Date.now() + 10000 });
      prepareHttpAuthority(authority, { declaredScopes: ['127.0.0.1'], explicitWildcardGrant: false });
      const transport = { features: ['httpBodyChunks'], requestFits: () => true,
        resultFits: (result: unknown) => Buffer.byteLength(JSON.stringify(result)) < 1048500 };
      const call = (method: string, params: unknown) => answerHttp(authority, `capability.net.http${method}`, params, transport) as Promise<any>;
      effects = [];
      const value = JSON.parse(literal);
      try {
        const { handle } = await call('.body.begin', { bytes: field === 'bytes' ? value : 3 });
        await call('.body.stageChunk', { handle, offset: field === 'stageOffset' ? value : 0, base64: 'YWJj' });
        const response = await call('', { url: server.url.href, method: 'POST', timeoutMs: 1000, body: { handle } });
        effects.push(await call('.body.readChunk', { handle: response.body.handle,
          offset: field === 'readOffset' ? value : 0, length: field === 'length' ? value : 3 }));
        await call('.body.release', { handle: response.body.handle });
        outcomes.push({ accepted: true, effects });
      } catch { outcomes.push({ accepted: false, effects }); }
      finally { await authority.revoke(); }
    }
  }
} finally { server.stop(true); }
console.log(JSON.stringify(outcomes));
