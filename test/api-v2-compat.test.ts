import {expect,test} from 'bun:test';
import {capture} from './fixtures/protocol-v2/capture';

test('terminal events are v3-only on the frozen v2 event surface',async()=>{
 const {toV2Event,v3OnlyEvent}=await import('../src/api/v2-compat');
 const event={seq:3_000_000_000_001,at:1,type:'terminal',data:{id:'shell-1',removed:true}};
 expect(v3OnlyEvent(event as never)).toBe(true);
 expect(toV2Event(event as never)).toBeNull();
});

test('the unmetered verdict stays OK on the frozen v2 rows and UNMETERED on v3',async()=>{
 const {toV2Snapshot}=await import('../src/api/v2-compat');
 const account={name:'free',agent:'opencode',source:'default',usedPct:null,pacePct:null,window:null,resetsAt:null,verdict:'UNMETERED',signedIn:true,executors:['free','p'],spendUsdWeek:null,capUsdWeek:null};
 const executor=(id:string,rank:number|'planner')=>({id,agent:'opencode',account:'free',host:null,model:null,rank,enabled:true,state:'ready',tone:'good',sub:'',usedPct:null,pacePct:null,slots:{used:0,max:1},lastCheck:null,recentFailures:0,next:false});
 const wire={seq:3_000_000_000_000,at:42,mode:'normal',tasks:[],strategies:[],planner:{runner:'p',mode:'normal',stale:false},
  accounts:[account],executors:[executor('p','planner'),executor('free',1)],
  machine:{used:0,max:1,hardCap:null,unlimited:true},setup:{items:[]},attention:[],counts:{attention:0,problems:0,review:0,running:0,queued:0,ready:0,executors:0,setupOpen:0,byRepo:{},hostsWithProblems:0},today:{since:0,done:0,accepted:0,rejected:0,failed:0,byRepo:{}},hosts:[],repos:[],service:{version:'test',protocol:'3.0.0',pid:1,notifier:null},pause:null,policy:{mode:'open',plugins:0}};
 const v2=toV2Snapshot(wire as never);
 expect(v2.accounts![0]!.verdict).toBe('OK');
 expect(v2.budget!.providers[0]!.verdict).toBe('OK');
 expect(v2.budget!.ranked[0]!.verdict).toBe('OK');
 // v3 keeps the verdict.
 expect(wire.accounts[0]!.verdict).toBe('UNMETERED');
});

test('v2 preserves pre-upgrade goldens while allowing additive snapshot fields',async()=>{
 for(const [name,value] of Object.entries(await capture())) {
  const golden = await Bun.file(`${import.meta.dir}/fixtures/protocol-v2/${name}.json`).json();
  if (name === 'snapshot') {
   // service.version is the live pacer version; the golden records pre-upgrade output.
   const live=(value as any).snapshot?.service?.version;
   if (golden.snapshot?.service?.version) { expect(live).toMatch(/^\d+\.\d+\.\d+/); golden.snapshot.service.version=live; }
   // Attention is intentionally re-derived by the new workflow, not frozen data.
   const current=(value as any).snapshot;
   delete golden.snapshot.attention;
   delete golden.snapshot.counts;
   expect(current.attention.some((a:any)=>a.id==='review:t-20261010-190000-0002')).toBe(false);
   expect(current.attention.find((a:any)=>a.taskId==='t-20261010-190000-0003')).toMatchObject({kind:'failed',severity:'problem'});
   expect(current.counts).toMatchObject({review:0,attention:5,problems:5});
   expect(value).toMatchObject(golden);
   // The default local cap changed from 2 to none; 2.x clients still get a numeric max,
   // the effective ceiling from the local executors' own limits.
   expect(value).toMatchObject({snapshot:{machine:{used:1,max:1}}});
  } else if (name === 'hello') {
   const live=value as any;
   const additive=['task.request_review','task.send'];
   for(const op of additive)expect(live.ops).toContain(op);
   expect({...live,pacer:golden.pacer,ops:live.ops.filter((op:string)=>!additive.includes(op))}).toEqual(golden);
  } else {
   // The live pacer version changes every release; the golden records pre-upgrade output.
   const live=value as Record<string,unknown>;
   if (typeof golden?.pacer === 'string') expect(live.pacer).toMatch(/^\d+\.\d+\.\d+/);
   const comparable=typeof golden?.pacer === 'string' ? {...live,pacer:golden.pacer} : live;
   if(golden===null || typeof golden!=='object') expect(comparable).toEqual(golden);
   else expect(comparable).toMatchObject(golden);
  }
 }
});

test('pure snapshot conversion rebuilds legacy fields from a serialized v3 read model',async()=>{
 const {fixture}=await import('./fixtures/protocol-v2/capture');
 const {liveSnapshot}=await import('../src/api/events');
 const {toV2Snapshot}=await import('../src/api/v2-compat');
 const {ctx,status}=await fixture();
 const wire=JSON.parse(JSON.stringify((await liveSnapshot(ctx,{status:async()=>status})).snapshot));
 const before=JSON.stringify(wire),v2=toV2Snapshot(wire);
 expect(JSON.stringify(wire)).toBe(before);
 expect(v2.budget).toMatchObject({planner:wire.planner.runner,mode:wire.planner.mode});
 expect(v2.budget!.providers).toHaveLength(wire.executors.length);
 expect(v2.alerts.map(a=>a.key)).toEqual(wire.attention.map((a:any)=>a.id));
 expect(v2.service.protocol).toBe('2.8.0');expect(v2).toHaveProperty('console',null);
});

test('v2 validates accepted and retains the limit-only bare summary array',async()=>{
 const {fixture,taskId}=await import('./fixtures/protocol-v2/capture');
 const {callV2Op}=await import('../src/api/v2-compat');const {ctx}=await fixture();
 expect(await callV2Op(ctx,'task.list',{limit:1})).toEqual([expect.objectContaining({task_id:taskId(7)})]);
 expect(callV2Op(ctx,'task.review',{id:taskId(2),accepted:'yes'})).rejects.toMatchObject({code:'invalid_input'});
});

test('the frozen 2.x surface rejects the protocol 3 q param on task.list',async()=>{
 const {callV2Op}=await import('../src/api/v2-compat');
 const {fakeCtx}=await import('./helpers');
 await expect(callV2Op(fakeCtx(),'task.list',{q:'webhook'})).rejects.toMatchObject({code:'invalid_input',message:'params: Unrecognized key: "q"'});
});

test('update_channel stays out of the frozen 2.x config.set surface',async()=>{
 const {callV2Op,v2OpJsonSchemas}=await import('../src/api/v2-compat');
 const {opJsonSchemas}=await import('../src/api/ops');
 const {fakeCtx}=await import('./helpers');
 const keys=(schemas:Record<string,{params:unknown}>)=>(schemas['config.set']!.params as {properties:{key:{enum:string[]}}}).properties.key.enum;
 expect(keys(opJsonSchemas())).toContain('update_channel');
 expect(keys(v2OpJsonSchemas())).not.toContain('update_channel');
 await expect(callV2Op(fakeCtx(),'config.set',{key:'update_channel',value:'nightly'})).rejects.toMatchObject({code:'invalid_input',message:'key: "update_channel" requires protocol 3'});
});

test('operations added after 2.8.0 stay out of the frozen 2.x surface',async()=>{
 const {v2Hello,callV2Op,v2OpJsonSchemas}=await import('../src/api/v2-compat');
 const {helloBody}=await import('../src/api/protocol');
 const {fakeCtx}=await import('./helpers');
 expect(helloBody().ops).toContain('task.takeover');
 expect(v2Hello().ops).not.toContain('task.takeover');
 expect(v2OpJsonSchemas()['task.takeover']).toBeUndefined();
 await expect(callV2Op(fakeCtx(),'task.takeover',{id:'t-x'})).rejects.toMatchObject({code:'unknown_op'});
});

test('desktop capture stays on v3 and does not change v2 client registration',async()=>{
 const {v2Hello,callV2Op,v2OpJsonSchemas}=await import('../src/api/v2-compat');
 const {fakeCtx}=await import('./helpers');
 expect(v2Hello().ops).not.toContain('desktop.capture.request');
 expect((v2OpJsonSchemas()['client.register'].params as {properties:Record<string,unknown>}).properties).not.toHaveProperty('capture');
 const registration=await callV2Op(fakeCtx(),'client.register',{kind:'desktop',version:'test',capture:true});
 expect(registration).not.toHaveProperty('capture_worker');
});

test('v2 snapshot and events strip workflow attention while leaving other items', async () => {
  const {
    toV2Snapshot,
    v3OnlyEvent,
    isWorkflowAttentionItem,
  } = await import('../src/api/v2-compat');
  const keep = {
    id: 'failed:t-keep',
    kind: 'failed',
    severity: 'problem',
    repo: null,
    title: 'Task failed',
    detail: 'x',
    raisedAt: 1,
    since: 1,
    actions: [{ label: 'Retry', op: 'task.retry', params: { id: 't-keep' } }],
    notify: 'all',
  };
  const workflowItems = [
    {
      id: 'budget_warn:r1',
      kind: 'question',
      severity: 'problem',
      repo: null,
      title: 'warn',
      detail: 'd',
      raisedAt: 1,
      since: 1,
      actions: [{ label: 'Add 20 planning steps', op: 'run.set_budget', params: { id: 'r1' } }],
      notify: 'all',
    },
    {
      id: 'budget_spent:r1',
      kind: 'question',
      severity: 'decide',
      repo: null,
      title: 'spent',
      detail: 'd',
      raisedAt: 1,
      since: 1,
      actions: [{ label: 'Stop run', op: 'run.stop', params: { id: 'r1' } }],
      notify: 'important',
    },
    {
      id: 'budget_msg_warn:r1',
      kind: 'question',
      severity: 'problem',
      repo: null,
      title: 'msg warn',
      detail: 'd',
      raisedAt: 1,
      since: 1,
      actions: [],
      notify: 'all',
    },
    {
      id: 'budget_msg_spent:r1',
      kind: 'question',
      severity: 'decide',
      repo: null,
      title: 'msg spent',
      detail: 'd',
      raisedAt: 1,
      since: 1,
      actions: [],
      notify: 'important',
    },
    {
      id: 'orchestrator_failed:r1',
      kind: 'orchestrator_failed',
      severity: 'blocked',
      repo: null,
      title: 'failed',
      detail: 'd',
      raisedAt: 1,
      since: 1,
      actions: [{ label: 'Retry now', op: 'run.retry_orchestrator', params: { id: 'r1' } }],
      notify: 'important',
    },
    {
      id: 'unresolved_wake:r1',
      kind: 'orchestrator_failed',
      severity: 'blocked',
      repo: null,
      title: 'wake',
      detail: 'd',
      raisedAt: 1,
      since: 1,
      actions: [],
      notify: 'important',
    },
    {
      id: 'run_review:t-1',
      kind: 'review',
      severity: 'decide',
      repo: null,
      title: 'review',
      detail: 'd',
      raisedAt: 1,
      since: 1,
      actions: [],
      notify: 'all',
    },
    // Kind alone must also filter, even with a non-prefix id.
    {
      id: 'custom:orch',
      kind: 'orchestrator_failed',
      severity: 'blocked',
      repo: null,
      title: 'custom',
      detail: 'd',
      raisedAt: 1,
      since: 1,
      actions: [],
      notify: 'important',
    },
  ];
  for (const item of workflowItems) expect(isWorkflowAttentionItem(item)).toBe(true);
  expect(isWorkflowAttentionItem(keep)).toBe(false);

  const wire = {
    seq: 3_000_000_000_000,
    at: 42,
    mode: 'normal',
    tasks: [],
    strategies: [],
    planner: { runner: 'p', mode: 'normal', stale: false },
    accounts: [],
    executors: [],
    machine: { used: 0, max: 1, hardCap: null, unlimited: false },
    setup: { items: [] },
    attention: [...workflowItems, keep],
    counts: {
      attention: workflowItems.length + 1,
      problems: 1,
      review: 0,
      running: 0,
      queued: 0,
      ready: 0,
      executors: 0,
      setupOpen: 0,
      byRepo: {},
      hostsWithProblems: 0,
    },
    today: { since: 0, done: 0, accepted: 0, rejected: 0, failed: 0, byRepo: {} },
    hosts: [],
    repos: [],
    service: { version: 'test', protocol: '3.0.0', pid: 1, notifier: null },
    pause: null,
    policy: { mode: 'open', plugins: 0 },
  };
  const v2 = toV2Snapshot(wire as never);
  expect(v2.attention.map(a => a.id)).toEqual(['failed:t-keep']);
  expect(v2.alerts.map(a => a.key)).toEqual(['failed:t-keep']);
  expect(v2.counts.attention).toBe(1);
  // v3 input unchanged
  expect(wire.attention).toHaveLength(workflowItems.length + 1);

  for (const item of workflowItems) {
    expect(v3OnlyEvent({ type: 'attention', data: { id: item.id, kind: item.kind } })).toBe(true);
  }
  // Notify keys follow the attention id; prefix ids are stripped like discovery.
  for (const item of workflowItems.filter(i => i.id !== 'custom:orch')) {
    expect(v3OnlyEvent({ type: 'notify', data: { key: item.id } })).toBe(true);
  }
  expect(v3OnlyEvent({ type: 'attention', data: { id: keep.id, kind: keep.kind } })).toBe(false);
  expect(v3OnlyEvent({ type: 'notify', data: { key: keep.id } })).toBe(false);
});

test('v2 HTTP/stdio event transport never exposes internal aggregate maps', async () => {
  const { fakeCtx } = await import('./helpers');
  const { eventsSince } = await import('../src/api/events');
  const { appendOutbox } = await import('../src/link/store');
  const ctx = fakeCtx();
  appendOutbox(ctx, [
    {
      seq: 1,
      at: ctx.now,
      envelope: {
        type: 'entity',
        data: {
          kind: 'attention',
          id: 'budget_warn:r1',
          value: { id: 'budget_warn:r1', severity: 'problem' },
        },
      },
    },
    {
      seq: 2,
      at: ctx.now,
      envelope: {
        type: 'entity',
        data: { kind: 'counts', id: 'counts', value: { attention: 1, problems: 1, review: 0 } },
      },
    },
  ]);
  const batch = eventsSince(ctx, 0, 2);
  // HTTP SSE sends event.data; stdio sends the event object. Neither path serializes
  // the internal discoveryOpen/workflowOpen/workflowProblemsOpen batch fields.
  for (const event of batch.events) {
    const sseData = JSON.stringify(event.data);
    const stdioParams = JSON.stringify(event);
    for (const key of ['discoveryOpen', 'workflowOpen', 'workflowProblemsOpen'] as const) {
      expect(sseData).not.toContain(key);
      expect(stdioParams).not.toContain(`"${key}"`);
    }
  }
  const clientFacing = { events: batch.events, last: batch.last, reset: batch.reset };
  expect(Object.keys(clientFacing).sort()).toEqual(['events', 'last', 'reset']);
});

test('v2 counts events leave out open workflow attention like the v2 snapshot', async () => {
  const { fakeCtx } = await import('./helpers');
  const { eventsSince } = await import('../src/api/events');
  const { publish } = await import('../src/link/publish');
  const ctx = fakeCtx();
  const attention = (id: string, severity: string, removed = false) => ({
    type: 'entity' as const,
    data: removed
      ? { kind: 'attention' as const, id, removed: true as const }
      : {
        kind: 'attention' as const,
        id,
        value: { id, kind: id.startsWith('orchestrator_failed:') ? 'orchestrator_failed' : 'question', severity },
      },
  });
  const counts = (attentionN: number, problemsN: number) => ({
    type: 'entity' as const,
    data: {
      kind: 'counts' as const,
      id: 'counts',
      value: { attention: attentionN, problems: problemsN, review: 0 },
    },
  });
  // One decide workflow item, one problem workflow item, one discovery, one ordinary.
  await publish(ctx, [
    attention('budget_spent:r1', 'decide'),
    attention('budget_warn:r1', 'problem'),
    attention('discovery:peer-z', 'decide'),
    attention('failed:t-1', 'problem'),
    counts(4, 2),
  ]);
  type Counts = { attention: number; problems: number; review: number };
  const v3 = eventsSince(ctx, 0, 3).events.filter(e => e.type === 'counts').map(e => e.data as Counts);
  expect(v3).toEqual([{ attention: 4, problems: 2, review: 0 }]);
  const v2 = eventsSince(ctx, 0, 2).events.filter(e => e.type === 'counts').map(e => e.data as Counts);
  // Discovery (1) + workflow (2) leave attention; only the problem-severity workflow item leaves problems.
  expect(v2).toEqual([{ attention: 1, problems: 1, review: 0 }]);

  await publish(ctx, [
    attention('budget_spent:r1', 'decide', true),
    attention('budget_warn:r1', 'problem', true),
    counts(2, 1),
  ]);
  const v2After = eventsSince(ctx, 0, 2).events.filter(e => e.type === 'counts').map(e => e.data as Counts);
  // Only discovery remains subtracted from attention; problems unchanged by discovery.
  expect(v2After).toEqual([
    { attention: 1, problems: 1, review: 0 },
    { attention: 1, problems: 1, review: 0 },
  ]);
  const v3After = eventsSince(ctx, 0, 3).events.filter(e => e.type === 'counts').map(e => (e.data as Counts).attention);
  expect(v3After).toEqual([4, 2]);
});

test('v2 counts stay correct when entityDiff removes workflow attention in the same pass as counts', async () => {
  const { fakeCtx } = await import('./helpers');
  const { eventsSince } = await import('../src/api/events');
  const { publish } = await import('../src/link/publish');
  const { entityDiff } = await import('../src/link/pump');
  const ctx = fakeCtx();
  const attentionRow = (id: string, severity: string) => ({
    kind: 'attention' as const,
    id,
    value: {
      id,
      kind: id.startsWith('orchestrator_failed:') ? 'orchestrator_failed' : 'question',
      severity,
    },
  });
  const countsRow = (attentionN: number, problemsN: number) => ({
    kind: 'counts' as const,
    id: 'counts',
    value: { attention: attentionN, problems: problemsN, review: 0 },
  });
  // Ordinary problem A + workflow decide W, then W is gone (e.g. Add 20 planning steps).
  const first = entityDiff({}, [
    attentionRow('failed:t-1', 'problem'),
    attentionRow('budget_spent:r1', 'decide'),
    countsRow(2, 1),
  ]);
  await publish(ctx, first.envelopes);

  const second = entityDiff(first.next, [
    attentionRow('failed:t-1', 'problem'),
    countsRow(1, 1),
  ]);
  // Publisher order: removals before counts (counts stays last). The old upserts-then-removals
  // order left W open when counts was indexed and double-subtracted it for v2.
  const secondKinds = second.envelopes.map(e =>
    e.type === 'entity'
      ? `${e.data.kind}:${e.data.id}${('removed' in e.data && e.data.removed) ? ':removed' : ''}`
      : e.type,
  );
  expect(secondKinds.indexOf('attention:budget_spent:r1:removed'))
    .toBeLessThan(secondKinds.indexOf('counts:counts'));
  expect(secondKinds.at(-1)).toBe('counts:counts');
  await publish(ctx, second.envelopes);

  type Counts = { attention: number; problems: number; review: number };
  const v2 = eventsSince(ctx, 0, 2).events.filter(e => e.type === 'counts').map(e => e.data as Counts);
  expect(v2).toEqual([
    { attention: 1, problems: 1, review: 0 },
    { attention: 1, problems: 1, review: 0 },
  ]);
});

test('v2 counts stay correct when entityDiff opens one item and removes another before counts', async () => {
  const { fakeCtx } = await import('./helpers');
  const { eventsSince } = await import('../src/api/events');
  const { publish } = await import('../src/link/publish');
  const { entityDiff } = await import('../src/link/pump');
  const ctx = fakeCtx();
  const attentionRow = (id: string, severity: string) => ({
    kind: 'attention' as const,
    id,
    value: {
      id,
      kind: id.startsWith('orchestrator_failed:') ? 'orchestrator_failed' : 'question',
      severity,
    },
  });
  const countsRow = (attentionN: number, problemsN: number) => ({
    kind: 'counts' as const,
    id: 'counts',
    value: { attention: attentionN, problems: problemsN, review: 0 },
  });
  const first = entityDiff({}, [
    attentionRow('budget_spent:r1', 'decide'),
    attentionRow('failed:t-1', 'problem'),
    countsRow(2, 1),
  ]);
  await publish(ctx, first.envelopes);

  // Same pass: open budget_warn, remove budget_spent, leave ordinary problem; counts last.
  const second = entityDiff(first.next, [
    attentionRow('budget_warn:r1', 'problem'),
    attentionRow('failed:t-1', 'problem'),
    countsRow(2, 2),
  ]);
  const removedAt = second.envelopes.findIndex(e =>
    e.type === 'entity' && e.data.kind === 'attention' && e.data.id === 'budget_spent:r1' && e.data.removed,
  );
  const openedAt = second.envelopes.findIndex(e =>
    e.type === 'entity' && e.data.kind === 'attention' && e.data.id === 'budget_warn:r1' && !e.data.removed,
  );
  const countsAt = second.envelopes.findIndex(e =>
    e.type === 'entity' && e.data.kind === 'counts',
  );
  expect(removedAt).toBeGreaterThanOrEqual(0);
  expect(openedAt).toBeGreaterThanOrEqual(0);
  expect(removedAt).toBeLessThan(countsAt);
  expect(openedAt).toBeLessThan(countsAt);
  await publish(ctx, second.envelopes);

  type Counts = { attention: number; problems: number; review: number };
  const v2 = eventsSince(ctx, 0, 2).events.filter(e => e.type === 'counts').map(e => e.data as Counts);
  // First: subtract one decide workflow → attention 1, problems 1.
  // Second: subtract one problem workflow → attention 1, problems 1.
  expect(v2).toEqual([
    { attention: 1, problems: 1, review: 0 },
    { attention: 1, problems: 1, review: 0 },
  ]);
});

test('v2 task events strip promptWait on the real eventsSince path', async () => {
  const { fakeCtx } = await import('./helpers');
  const { eventsSince } = await import('../src/api/events');
  const { toV2Event } = await import('../src/api/v2-compat');
  const { appendOutbox } = await import('../src/link/store');
  const ctx = fakeCtx();
  appendOutbox(ctx, [
    {
      seq: 1,
      at: ctx.now,
      envelope: {
        type: 'task',
        data: {
          id: 't-wait',
          state: 'running',
          goal: 'g',
          executor: null,
          backend: null,
          worktree: null,
          updatedAt: ctx.now,
          title: 'wait',
          promptWait: { text: 'Proceed? (y/n)', at: ctx.now },
          fullTitle: 'full wait',
        } as never,
      },
    },
  ]);
  const pure = toV2Event({
    type: 'task',
    seq: 3_000_000_000_001,
    at: ctx.now,
    data: {
      id: 't-wait',
      state: 'running',
      promptWait: { text: 'Proceed? (y/n)', at: 1 },
      fullTitle: 'full',
    },
  } as never) as { data: Record<string, unknown> } | null;
  expect(pure).not.toBeNull();
  expect(pure!.data.promptWait).toBeUndefined();
  expect(pure!.data.fullTitle).toBe('full');

  const batch = eventsSince(ctx, 0, 2);
  const taskEvents = batch.events.filter(e => e.type === 'task');
  expect(taskEvents.length).toBeGreaterThanOrEqual(1);
  for (const e of taskEvents) {
    const data = e.data as Record<string, unknown>;
    expect(data.promptWait).toBeUndefined();
    expect(JSON.stringify(e)).not.toContain('promptWait');
  }
});

test('the planner tier fallback stays out of the frozen 2.x surface',async()=>{
 const {callV2Op,v2OpJsonSchemas}=await import('../src/api/v2-compat');
 const {opJsonSchemas}=await import('../src/api/ops');
 const {fakeCtx}=await import('./helpers');
 const keys=(schemas:Record<string,{params:unknown}>)=>(schemas['config.set']!.params as {properties:{key:{enum:string[]}}}).properties.key.enum;
 expect(keys(opJsonSchemas())).toContain('pacing.planner_tier_fallback');
 expect(keys(v2OpJsonSchemas())).not.toContain('pacing.planner_tier_fallback');
 expect((v2OpJsonSchemas()['routing.route']!.params as {properties:Record<string,unknown>}).properties.difficulty).toBeUndefined();
 await expect(callV2Op(fakeCtx(),'config.set',{key:'pacing.planner_tier_fallback',value:'off'})).rejects.toMatchObject({code:'invalid_input',message:'key: "pacing.planner_tier_fallback" requires protocol 3'});
 await expect(callV2Op(fakeCtx(),'routing.route',{kind:'feature',difficulty:'complex'})).rejects.toMatchObject({code:'invalid_input',message:'params: Unrecognized key: "difficulty"'});
});
