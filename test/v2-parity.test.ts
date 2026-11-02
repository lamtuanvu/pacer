import { expect, test } from 'bun:test';
import {
  toV2Event,
  toV2OpResult,
  v2Params,
  V2_EVENT,
  v3OnlyEvent,
} from '../src/api/v2-compat';
import type { CompatEvent } from '../src/api/v2-compat';
import conversions from './fixtures/protocol-v2/conversions.json';

test('v2 pure conversions retain their golden outputs without mutating inputs', () => {
  for (const { name, input, output } of conversions.params) {
    const before = JSON.stringify(input);
    expect(v2Params(name, input)).toEqual(output);
    expect(JSON.stringify(input)).toBe(before);
  }
  for (const { name, input, output } of conversions.results) {
    const before = JSON.stringify(input);
    expect(toV2OpResult(name, input)).toEqual(output);
    expect(JSON.stringify(input)).toBe(before);
  }
  for (const { input, output } of conversions.events) {
    const before = JSON.stringify(input);
    expect(toV2Event(input as CompatEvent) as unknown).toEqual(output);
    expect(JSON.stringify(input)).toBe(before);
  }
});

test('v2 review rejects non-boolean accepted values', () => {
  for (const accepted of [null, 0, 1, '', 'true', {}, []]) {
    expect(() => v2Params('task.review', { accepted })).toThrow(
      'accepted: expected boolean',
    );
  }
});

test('explicit legacy events override conversion, except desktop updates', () => {
  const legacy = { type: 'task', seq: 7, data: {} } as CompatEvent;
  const event = {
    type: 'message',
    seq: 3,
    data: {},
    [V2_EVENT]: legacy,
  } as CompatEvent;
  expect(toV2Event(event) as unknown).toEqual(legacy);
  expect(toV2Event({ ...event, [V2_EVENT]: null })).toBeNull();
  expect(toV2Event({ ...event, type: 'desktop.update' })).toBeNull();
});

test('discovery-only event detection preserves other events', () => {
  for (const [event, expected] of [
    [{ type: 'discovery.found', data: null }, true],
    [{ type: 'config', data: { area: 'discovery' } }, true],
    [{ type: 'attention', data: { id: 'discovery:x' } }, true],
    [{ type: 'notify', data: { key: 'discovery-network:x' } }, true],
    [{ type: 'attention', data: { id: 'other' } }, false],
    [{ type: 'notify', data: null }, false],
  ] as const)
    expect(v3OnlyEvent(event)).toBe(expected);
});

import characterization from './fixtures/protocol-v2/characterization.json';
import { convert } from './fixtures/protocol-v2/characterize';
import {
  v2Hello,
  v2OpJsonSchemas,
  V3_ONLY_OPS,
  callV2Op,
} from '../src/api/v2-compat';
import { fakeCtx } from './helpers';

for (const kind of [
  'params',
  'results',
  'events',
  'snapshots',
  'discovery',
  'setup',
] as const) {
  test(`v2 ${kind} match complete TypeScript characterization goldens`, () => {
    for (const row of characterization[kind]) {
      const before = JSON.stringify(row);
      expect(JSON.parse(JSON.stringify(convert(kind, row)))).toEqual(
        row.output,
      );
      expect(JSON.stringify(row)).toBe(before);
    }
  });
}
test('v2 hello and schemas retain the frozen operation surface and property order', async () => {
  expect(v2Hello()).toEqual(characterization.hello.output);
  expect(JSON.stringify(v2OpJsonSchemas())).toBe(
    JSON.stringify(characterization.schemas.output),
  );
  expect([...V3_ONLY_OPS]).toEqual(characterization.v3OnlyOps);
  for (const name of V3_ONLY_OPS) {
    await expect(callV2Op(fakeCtx(), name, {})).rejects.toMatchObject({
      code: 'unknown_op',
      message: `unknown operation "${name}"`,
      hint: `${name} requires protocol 3`,
    });
  }
});
