// Refresh only deliberately: bun test/fixtures/protocol-v2/characterize.ts
// TypeScript is the reference; Rust and TS tests consume the committed outputs.
import {
  toV2Snapshot,
  toV2Event,
  toV2OpResult,
  v2Params,
  v2Hello,
  v2OpJsonSchemas,
  V2_STATE,
  V2_EVENT,
  V3_ONLY_OPS,
  v3OnlyEvent,
  isDiscoveryItemId,
} from '../../../src/api/v2-compat';
import { helloBody } from '../../../src/api/protocol';
import { opJsonSchemas, LEGACY_TASK_LIST } from '../../../src/api/ops';
import { legacySetup } from '../../../src/setup/v2';

const copy = (x: any) => JSON.parse(JSON.stringify(x));
export function convert(kind: string, row: any): any {
  const input = copy(row.input);
  switch (kind) {
    case 'params':
      try {
        return { value: v2Params(row.name, input) };
      } catch (e: any) {
        return { error: { code: e.code, message: e.message } };
      }
    case 'results':
      if ('legacy' in row) input[LEGACY_TASK_LIST] = row.legacy;
      return toV2OpResult(row.name, input);
    case 'events':
      if ('legacy' in row) input[V2_EVENT] = row.legacy;
      return toV2Event(input);
    case 'snapshots':
      if ('legacy' in row) input[V2_STATE] = row.legacy;
      return toV2Snapshot(input);
    case 'discovery':
      return {
        id: isDiscoveryItemId(input.data?.id),
        only: v3OnlyEvent(input),
      };
    case 'setup':
      return legacySetup(input);
  }
}
export function cases() {
  const base: any = {
    seq: 3000000000000,
    at: 42,
    mode: 'normal',
    tasks: [{ fullTitle: 'preserved', derived: {} }],
    strategies: [
      'old',
      { name: 'inactive', active: false },
      { name: 'chosen', active: true },
      { name: 'later', active: true },
    ],
    planner: { runner: 'p', mode: 'normal', stale: true },
    accounts: [{ name: 'a', verdict: 'GO', resetsAt: 60, window: 'week' }],
    policy: { mode: 'normal' },
    pause: null,
    today: {
      since: 0,
      done: 0,
      accepted: 0,
      rejected: 0,
      failed: 0,
      byRepo: {},
    },
    hosts: [],
    repos: [],
    executors: [],
    machine: { used: 0, max: 9007199254740991, hardCap: null, unlimited: true },
    setup: { items: [] },
    attention: [],
    counts: { attention: 99, problems: 99, setupOpen: 99, other: 3 },
    service: { protocol: '3.0.0', version: 'fixture' },
    desktopUpdates: [{ id: 'hidden' }],
    extra: { preserved: true },
  };
  const executor = (id: string, extra: any = {}) => ({
    id,
    agent: 'codex',
    account: 'a',
    host: null,
    rank: 1,
    enabled: true,
    state: 'ready',
    usedPct: null,
    pacePct: 2,
    slots: { used: 0, max: 2 },
    sub: 'fallback',
    ...extra,
  });
  const attention = (id: string, severity = 'problem', since = 1) => ({
    id,
    kind: 'setup',
    severity,
    since,
    raisedAt: 2,
    title: 'original',
    detail: 'detail',
    actions: [
      { op: 'ui.open', params: { view: 'settings', section: 'old' } },
      { op: 'other', params: {} },
    ],
  });
  const snapshots: any[] = [];
  const add = (id: string, patch: any, legacy?: any) =>
    snapshots.push({
      id,
      input: { ...copy(base), ...patch },
      ...(legacy === undefined ? {} : { legacy }),
    });
  add('managed-actions-navigation', {attention: [
    {...attention('question:managed','blocked',1),kind:'question',taskId:'managed',actions:[{label:'Answer',op:'dispatch.answer',params:{id:'managed',expect_rev:7,requestId:'managed.7.answer'}}]},
    {...attention('failed:managed','problem',2),kind:'failed',taskId:'managed',actions:[{label:'Retry',op:'dispatch.retry',params:{id:'managed',expect_rev:7,requestId:'managed.7.retry'}}]},
    {...attention('failed:ordinary','problem',3),kind:'failed',taskId:'ordinary',actions:[{label:'Retry on Codex',op:'task.retry',params:{id:'ordinary',executor:'codex'}}]},
  ]});
  add('empty-unlimited', {});
  add('null-machine', { machine: null });
  add('no-planner-fixed', {
    planner: null,
    machine: { used: 1, max: 7, unlimited: false },
    seq: 3,
  });
  add('provider-and-ranking', {
    executors: [
      executor('planner', { rank: 'planner' }),
      executor('busy', { rank: 2, state: 'busy' }),
      executor('blocked', { state: 'blocked', reason: 'blocked reason' }),
      executor('blocked-sub', { state: 'blocked' }),
      executor('down', { state: 'down', reason: 'broken' }),
      executor('down-sub', { state: 'down' }),
      executor('disabled', { enabled: false }),
      executor('remote', { host: 'h' }),
      executor('ineligible', { eligibility: { state: 'ineligible' } }),
      executor('eligible', { eligibility: { state: 'eligible' } }),
      executor('missing', { account: 'missing', rank: 0 }),
    ],
  });
  add('attention-remap-sort', {
    setup: {
      items: [
        { id: 'planner', status: 'pending', detail: 'Choose a planner' },
        { id: 'service', status: 'done' },
      ],
    },
    attention: [
      attention('setup:connect'),
      attention('discovery:x'),
      attention('discovery-network:x'),
      attention('setup:planner'),
      attention('setup:service'),
      attention('plugin:reload', 'decide'),
      attention('z', 'blocked', 3),
      attention('a', 'blocked', 2),
      attention('b', 'blocked', 2),
    ],
  });
  add('setup-done-removes-planner', {
    setup: {
      items: [
        { id: 'planner', status: 'pending', detail: 'codex · signed out' },
      ],
    },
    attention: [attention('setup:planner')],
  });
  add(
    'legacy-state',
    {},
    {
      budget: { from: 'legacy' },
      alerts: [{ key: 'legacy' }],
      console: { id: 'c' },
      consoles: [{ id: 'c' }],
      serviceInstalled: false,
    },
  );
  add(
    'legacy-nullish',
    { setup: { items: [{ id: 'service', status: 'done' }] } },
    {
      budget: null,
      alerts: [],
      console: null,
      consoles: null,
      serviceInstalled: null,
    },
  );
  add('default-strategy-empty-cap', {
    strategies: ['name', { name: 'off', active: false }],
    executors: [executor('off', { enabled: false })],
  });
  for (const [i, rank] of [
    '\ufeff 0x10 \u00a0',
    '0b10',
    '0o7',
    '',
    '  ',
    '1e1',
    '1_0',
    'Infinity',
    '-Infinity',
    '\u00851',
    '3😀',
    null,
    true,
    [],
    ['2'],
    {},
    -0.5,
  ].entries())
    add(`numeric-rank-${i}`, {
      executors: [executor('reference'), executor(`rank-${i}`, { rank })],
    });
  add('all-setup-complete', {
    setup: {
      items: ['binary', 'service', 'link']
        .map((id) => ({ id, status: 'done' }))
        .concat([{ id: 'planner', status: 'done', detail: 'codex' }] as any),
    },
    attention: [
      attention('setup:binary'),
      attention('setup:planner'),
      attention('setup:link'),
    ],
  });
  add('unicode-setup-details', {
    setup: {
      items: [
        {
          id: 'planner',
          status: 'pending',
          detail: ' \ufeff😀\u0085 · signed out',
        },
      ],
    },
  });
  add('fractional-slots-cursor', {
    seq: 3000000000000.5,
    executors: [
      executor('a', { slots: { max: 0.25 } }),
      executor('b', { slots: { max: 0.5 } }),
    ],
  });
  for (const rank of [
    '0x9adffc28f123abcd',
    '0xf82eb167f123abcd',
    '0x' + 'f'.repeat(400),
    '0b1' + '0'.repeat(1023) + '1',
    '0o777777777777777777777777',
  ]) {
    const reference = Number(rank);
    // Infinity cannot be represented in JSON; a finite reference still tests overflow ordering.
    add(`radix-rounding-${rank.slice(0, 20)}`, {
      executors: [
        executor('reference', {
          rank: Number.isFinite(reference) ? reference : Number.MAX_VALUE,
        }),
        executor('converted', { rank }),
      ],
    });
  }
  add('locale-order', {
    attention: [
      'z',
      'Z',
      'a',
      'A',
      'ä',
      'å',
      'á',
      '😀',
      '_',
      '-',
      '10',
      '2',
    ].map((id) => attention(id)),
  });
  const params: any[] = [];
  for (const name of [
    'other',
    'task.delegate',
    'client.register',
    'task.review',
  ]) {
    for (const input of [
      null,
      false,
      0,
      '😀',
      [],
      [1],
      {},
      { dispatch: 1, capture: 1 },
      { accepted: true },
      { accepted: false },
      { accepted: true, verdict: null },
      { accepted: false, verdict: 'accept' },
      ...[null, 0, 1, '', [], {}].map((accepted) => ({ accepted })),
    ])
      params.push({ name, input });
  }
  const results: any[] = [];
  for (const name of [
    'other',
    'client.register',
    'version.get',
    'task.diff',
    'task.list',
    'task.get',
    'task.review',
  ]) {
    for (const input of [
      null,
      false,
      0,
      'é',
      [],
      [null, { fullTitle: 'x', derived: 1, work: 2 }],
      {},
      {
        capture_worker: true,
        patch: null,
        diff: 'old',
        fullTitle: 'x',
        derived: 1,
        work: 2,
      },
      {
        task: { fullTitle: 'x' },
        tasks: [null, { fullTitle: 'x', derived: 1 }],
        next: 'n',
      },
    ])
      if (!(name === 'task.diff' && input === null))
        results.push({ name, input });
  }
  results.push(
    {
      name: 'task.list',
      input: { tasks: [] },
      legacy: [{ id: 'legacy', fullTitle: 'hidden' }],
    },
    { name: 'task.list', input: { tasks: [] }, legacy: null },
  );
  for (const items of [
    [],
    [{ id: 'planner', status: 'failed', detail: 'failure' }],
    [{ id: 'planner', detail: 'codex · signed out', status: 'pending' }],
    [{ id: 'planner', detail: 'Choose a planner' }],
    [{ id: 'planner', detail: '' }],
    [{ id: 'connect', agent: 'codex', status: 'done', installed: true }],
    [
      { id: 'agent:codex', status: 'failed', installed: false },
      { id: 'connect', agent: 'codex', status: 'done', installed: true },
    ],
    ['binary', 'service', 'link']
      .map((id) => ({ id, status: 'done', detail: 'ok' }))
      .concat([{ id: 'planner', status: 'done', detail: 'codex' }]),
  ])
    results.push({ name: 'setup.check', input: { checkedAt: 42, items } });
  const events: any[] = [];
  for (const type of [
    'task',
    'desktop.update',
    'planner',
    'assistant',
    'machine',
    'message',
    'discovery.found',
    'config',
    'attention',
    'notify',
  ])
    for (const data of [
      null,
      {},
      { area: 'machine' },
      { area: 'discovery' },
      { area: ['machine'] },
      { area: ['discovery'] },
      { id: 'discovery:x', key: 'discovery-network:x' },
    ])
      events.push({ input: { type, seq: 3000000000001, data } });
  for (const seq of [
    0, 2999999999999, 3000000000000, 3000000000000.5, 9007199254740991,
  ])
    events.push({ input: { type: 'task', seq, data: null } });
  for (const type of ['message', 'desktop.update', 'task'])
    for (const legacy of [null, { type: 'task', seq: 7, data: {} }])
      events.push({ input: { type, seq: 3000000000001, data: {} }, legacy });
  const discovery = [
    'discovery.found',
    'config',
    'attention',
    'notify',
    'task',
  ].flatMap((type) =>
    [
      null,
      {},
      { area: 'discovery' },
      ...[
        'discovery:',
        'discovery-network:',
        'discovery',
        'other',
        5,
        null,
      ].map((id) => ({ id, key: id })),
    ].map((data) => ({ input: { type, data } })),
  );
  return {
    params,
    results,
    events,
    snapshots,
    discovery,
    setup: results
      .filter((r) => r.name === 'setup.check')
      .map((r) => ({ input: r.input })),
  };
}
if (import.meta.main) {
  const data: any = cases();
  for (const [kind, rows] of Object.entries(data))
    for (const row of rows as any[]) row.output = copy(convert(kind, row));
  data.hello = { input: helloBody(), output: v2Hello() };
  data.schemas = { input: opJsonSchemas(), output: v2OpJsonSchemas() };
  data.v3OnlyOps = [...V3_ONLY_OPS];
  await Bun.write(
    `${import.meta.dir}/characterization.json`,
    JSON.stringify(data, null, 2) + '\n',
  );
}
