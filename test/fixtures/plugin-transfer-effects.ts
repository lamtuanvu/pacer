import { createCallAuthority } from '../../src/plugins/authority';
import { fileWriteTransfers } from '../../src/plugins/file-write-transfers';
import { fakeCtx } from '../helpers';

const outcomes: unknown[] = [];
for (const literal of ['3.0', '3e0', '1.5', '9007199254740992']) {
  const authority = createCallAuthority(fakeCtx(), { reads: [], commands: [], stores: [] },
    { grants: ['fs.write'], deadlineMs: Date.now() + 10000 });
  const effects: unknown[] = [];
  const transfer = fileWriteTransfers(authority, { authorize() {}, async write(path, text, mode) {
    effects.push({ path, text, mode }); return { ok: true };
  } });
  try {
    const { handle } = await transfer.begin('/tmp/issued', JSON.parse(literal), 384);
    await transfer.append(handle, JSON.parse('0e0'), 'YWJj');
    await transfer.commit(handle);
    outcomes.push({ accepted: true, effects });
  } catch { outcomes.push({ accepted: false, effects }); }
  finally { await authority.revoke(); }
}
console.log(JSON.stringify(outcomes));
