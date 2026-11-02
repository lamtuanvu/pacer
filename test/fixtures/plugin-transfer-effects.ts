import { createCallAuthority } from '../../src/plugins/authority';
import { fileWriteTransfers } from '../../src/plugins/file-write-transfers';
import { fakeCtx } from '../helpers';

const outcomes: unknown[] = [];
for (const field of ['bytes', 'offset', 'mode']) {
for (const literal of ['0.0', '0e0', '3.0', '3e0', '384.0', '3.84e2', '1.5', '9007199254740992']) {
  const authority = createCallAuthority(fakeCtx(), { reads: [], commands: [], stores: [] },
    { grants: ['fs.write'], deadlineMs: Date.now() + 10000 });
  const effects: unknown[] = [];
  const transfer = fileWriteTransfers(authority, { authorize() {}, async write(path, text, mode) {
    effects.push({ path, text, mode }); return { ok: true };
  } });
  try {
    const { handle } = await transfer.begin('/tmp/issued', field === 'bytes' ? JSON.parse(literal) : 3, field === 'mode' ? JSON.parse(literal) : 384);
    await transfer.append(handle, field === 'offset' ? JSON.parse(literal) : 0, 'YWJj');
    await transfer.commit(handle);
    outcomes.push({ accepted: true, effects });
  } catch { outcomes.push({ accepted: false, effects }); }
  finally { await authority.revoke(); }
}
}
console.log(JSON.stringify(outcomes));
