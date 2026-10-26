import { expect, test } from 'bun:test';
import { createCallAuthority } from '../src/plugins/authority';
import { CallAdmission } from '../src/plugins/admission';
import { withTimeout } from '../src/classify/decide';
import { fakeCtx } from './helpers';
const delay = () => new Promise<number>(resolve => setTimeout(() => resolve(7), 20));
test('large finite owner deadlines do not overflow into immediate cancellation', async () => {
  const a = createCallAuthority(fakeCtx(), { reads: [], commands: [], stores: [] }, { deadlineMs: Date.now() + 9e15 });
  try { await delay(); expect(a.signal.aborted).toBe(false); a.assertActive(); } finally { await a.revoke(); }
});
test('large finite admission and decision budgets retain their absolute deadline', async () => {
  expect(await new CallAdmission().run(Date.now() + 9e15, delay)).toBe(7);
  expect(await withTimeout(delay(), 9e15, 'large')).toBe(7);
});
