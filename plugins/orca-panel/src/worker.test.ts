/// <reference types="@types/bun" />
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { AttentionItem, PacerSnapshot, PacerTask } from './pacer-client'
import type { PanelOverall, PanelSnapshot } from './protocol'
import * as main from './worker'
import {
  actionableItems,
  executorSummary,
  filterAttention,
  overallCounts,
  paceStatus,
  resetOpenDesktop,
  setOpenDesktop,
  uiOpenRoute,
} from './worker'

const STATUS_ITEM = 'pacer-pace'
const DEFAULT_TOKEN = 'worker-test-token'

type EventConnection = { since: string; send(frame: string): void; close(): void }

type PacerFixture = {
  home: string
  port: number
  eventConnections: { since: string }[]
  opCalls: { op: string; params: unknown }[]
  snapshotRequests: number
  dispose(): Promise<void>
}

type FixtureOptions = {
  token?: string | null
  snapshot?: () => object
  onOp?: (op: string, params: unknown) => { status: number; body: unknown }
  onEvents?: (connection: EventConnection) => void
}

const attentionItem = (
  id: string,
  repo?: string | { key: string; path: string; label: string } | null,
  over: Partial<AttentionItem> = {},
): AttentionItem => ({
  id,
  kind: 'review',
  severity: 'decide',
  ...(repo === null
    ? { repo: null }
    : repo
      ? { repo: typeof repo === 'string' ? { key: repo, path: `/${repo}`, label: repo } : repo }
      : {}),
  title: `Item ${id}`,
  detail: `${id} needs you`,
  raisedAt: 100,
  since: 100,
  actions: [{ label: 'Dismiss', op: 'attention.dismiss', params: { id } }],
  notify: 'important',
  ...over,
})

const snapshotWith = (
  over: {
    attention?: AttentionItem[]
    repos?: { key: string; label: string; path: string }[]
    planner?: unknown
    seq?: number
    at?: number
    tasks?: unknown[]
    executors?: unknown[]
    pause?: unknown
    today?: { since: number }
  } = {},
) => ({
  seq: over.seq ?? 5,
  at: over.at ?? 1_700_000_000,
  planner: over.planner ?? null,
  counts: { attention: (over.attention ?? []).length },
  attention: over.attention ?? [],
  repos: over.repos ?? [],
  tasks: over.tasks ?? [],
  executors: over.executors ?? [],
  pause: over.pause ?? null,
  today: over.today ?? { since: 1_699_900_000 },
})

function hostWithFocusedWorkspace(
  path: string | null,
  storage: { seq?: number } = {},
  extraWorkspaces: { id: string; path: string; projectId?: string | null }[] = [],
  options: {
    focusedProjectId?: string | null
    projects?: { id: string; name: string; kind: 'git' | 'folder'; hostId: string | null; path: string }[]
  } = {},
) {
  const workspaces =
    path === null
      ? extraWorkspaces.map((w) => ({
          id: w.id,
          kind: 'worktree' as const,
          name: w.id,
          path: w.path,
          projectId: w.projectId ?? null,
          branch: 'main',
          hostId: 'local',
        }))
      : [
          {
            id: 'ws1',
            kind: 'worktree' as const,
            name: 'repo',
            path,
            projectId: options.focusedProjectId ?? null,
            branch: 'main',
            hostId: 'local',
          },
          ...extraWorkspaces.map((w) => ({
            id: w.id,
            kind: 'worktree' as const,
            name: w.id,
            path: w.path,
            projectId: w.projectId ?? null,
            branch: 'main',
            hostId: 'local',
          })),
        ]
  return mockHost({
    storage,
    capabilities: ['storage:own', 'workspace:read', 'workspace:write'],
    results: {
      'workspace.readContext': path === null ? null : { workspaceId: 'ws1', branch: 'main', displayName: 'repo', terminals: [] },
      'workspace.list': { workspaces, truncated: false },
      'project.list': { projects: options.projects ?? [], truncated: false },
      'workspace.open': { opened: true },
      'statusBar.update': { ok: true },
    },
  })
}

type StatusBarParams = { id: string; text?: string; tone?: string; tooltip?: string }

function statusBarCalls(host: ReturnType<typeof mockHost>): StatusBarParams[] {
  return host.calls.filter((call) => call.method === 'statusBar.update').map((call) => call.params as StatusBarParams)
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      data += chunk
    })
    req.on('end', () => resolve(data))
  })
}

async function startPacer(options: FixtureOptions = {}): Promise<PacerFixture> {
  const home = mkdtempSync(join(tmpdir(), 'orca-panel-home-'))
  const token = 'token' in options ? options.token : DEFAULT_TOKEN
  if (typeof token === 'string') writeFileSync(join(home, 'token'), token)
  const expectedAuth = `Bearer ${typeof token === 'string' ? token : DEFAULT_TOKEN}`
  const openResponses = new Set<ServerResponse>()
  const fixture: PacerFixture = {
    home,
    port: 0,
    eventConnections: [],
    opCalls: [],
    snapshotRequests: 0,
    dispose: async () => {},
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res)
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.headers.authorization !== expectedAuth) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'bad token' } }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v3/snapshot') {
      fixture.snapshotRequests++
      res.writeHead(200, { 'content-type': 'application/json' })
      const snapshot = (options.snapshot?.() ?? snapshotWith()) as { seq: number }
      res.end(JSON.stringify({ protocol: '3.0.0', seq: snapshot.seq, snapshot }))
      return
    }
    if (req.method === 'POST' && url.pathname.startsWith('/v3/ops/')) {
      const op = url.pathname.slice('/v3/ops/'.length)
      const raw = await readBody(req)
      const params: unknown = raw ? JSON.parse(raw) : {}
      fixture.opCalls.push({ op, params })
      const answer =
        options.onOp?.(op, params) ?? { status: 404, body: { error: { code: 'unknown_op', message: `unknown op ${op}` } } }
      res.writeHead(answer.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer.body))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v3/events') {
      const connection: EventConnection = {
        since: url.searchParams.get('since') ?? '',
        send: (frame) => res.write(frame),
        close: () => res.end(),
      }
      fixture.eventConnections.push({ since: connection.since })
      openResponses.add(res)
      res.on('close', () => openResponses.delete(res))
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      options.onEvents?.(connection)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'not_found', message: url.pathname } }))
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  fixture.port = (server.address() as { port: number }).port
  const saved: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries({ PACER_HOME: home, PACER_PORT: String(fixture.port) })) {
    saved[key] = process.env[key]
    process.env[key] = value
  }

  fixture.dispose = async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    for (const res of openResponses) res.destroy()
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
    rmSync(home, { recursive: true, force: true })
  }
  return fixture
}

test("pacer.snapshot reports connected:false when there's no token", async () => {
  const pacer = await startPacer({ token: null })
  try {
    const host = hostWithFocusedWorkspace('/repo')
    const worker = await mountWorker(main, { host })
    const snapshot = (await worker.request('pacer.snapshot')) as PanelSnapshot
    assert.equal(snapshot.connected, false)
    assert.deepEqual(snapshot.attention, [])
    assert.equal(pacer.eventConnections.length, 0)
    const act = await worker.request('pacer.act', { op: 'attention.dismiss', params: { id: 'a1' } })
    assert.deepEqual(act, { ok: false, error: 'pacer is not connected' })
    await worker.deactivate()
  } finally {
    await pacer.dispose()
  }
})

test('pacer.snapshot trims a realistic snapshot, hides snoozed items, matches orcaWorkspaceId', async () => {
  const at = 1_700_000_100
  const pacer = await startPacer({
    snapshot: () =>
      snapshotWith({
        at,
        repos: [
          { key: 'k1', label: 'jawfish', path: '/repo' },
          { key: 'k2', label: 'other', path: '/other' },
        ],
        attention: [
          attentionItem('live', 'k1'),
          attentionItem('snoozed', 'k1', { snoozedUntil: at + 60 }),
          attentionItem('global', null, { kind: 'setup', severity: 'decide' }),
        ],
        tasks: [
          {
            id: 't1',
            rev: 2,
            title: 'Running',
            state: 'running',
            repo: { key: 'k1', label: 'jawfish', path: '/repo' },
            executor: 'cursor',
            progress: { phase: 'working' },
            attemptStartedAt: at - 100,
            updatedAt: at - 10,
            worktree: '/wt-t1',
          },
          {
            id: 't2',
            rev: 1,
            title: 'Done',
            state: 'done',
            repo: { key: 'k1', label: 'jawfish', path: '/repo' },
            executor: 'cursor',
            updatedAt: at - 5,
            review: { accepted: true },
          },
          {
            id: 'tq',
            rev: 1,
            title: 'Queued task',
            state: 'queued',
            repo: { key: 'k1', label: 'jawfish', path: '/repo' },
            executor: null,
            updatedAt: at - 20,
          },
          {
            id: 'elsewhere',
            rev: 1,
            title: 'Running in another worktree',
            state: 'running',
            repo: { key: 'k2', label: 'other', path: '/other' },
            executor: 'cursor',
            updatedAt: at - 30,
          },
        ],
        executors: [
          {
            id: 'cursor',
            agent: 'cursor',
            account: 'default',
            rank: 1,
            state: 'ready',
            tone: 'good',
            sub: 'Ready',
            next: true,
            slots: { used: 0, max: 1 },
            enabled: true,
          },
          {
            id: 'planner',
            agent: 'claude-code',
            account: 'default',
            rank: 'planner',
            state: 'ready',
            tone: 'good',
            sub: 'Planner',
            next: false,
            slots: { used: 0, max: 1 },
            enabled: true,
          },
        ],
        planner: {
          agent: 'Claude',
          usedPct: 14,
          pacePct: 12,
          verdict: 'on_pace',
          advice: 'On pace.',
          mode: 'normal',
          resetsAt: at + 3600,
          window: 'week',
          stale: false,
        },
      }),
  })
  try {
    const host = hostWithFocusedWorkspace('/repo', {}, [
      { id: 'ws-wt', path: '/wt-t1' },
      { id: 'ws-other', path: '/other' },
    ])
    const worker = await mountWorker(main, { host })
    const snapshot = (await worker.request('pacer.snapshot')) as PanelSnapshot
    assert.equal(snapshot.connected, true)
    assert.equal(snapshot.focusedWorkspace?.path, '/repo')
    assert.deepEqual(snapshot.attention.map((a) => a.id).sort(), [])
    assert.equal(snapshot.tasks?.find((t) => t.id === 't1')?.orcaWorkspaceId, 'ws-wt')
    assert.equal((snapshot.tasks ?? []).every((t) => t.id !== 'tq' || t.state === 'queued'), true)
    assert.ok((snapshot.tasks ?? []).some((t) => t.id === 'tq'))
    // The rows stay this worktree's; the pacer-wide counts (the 'live' review included) and executors cover every worktree.
    assert.equal((snapshot.tasks ?? []).some((t) => t.id === 'elsewhere'), false)
    assert.deepEqual(snapshot.overall, { needsYou: 1, running: 2, asked: 0, queued: 1, worktrees: 2 })
    assert.deepEqual(snapshot.executors, [{ id: 'cursor', name: 'Cursor', state: 'ready', tone: 'good' }])
    assert.ok((snapshot.tasks ?? []).some((t) => t.id === 't2'))
    await worker.deactivate()
  } finally {
    await pacer.dispose()
  }
})

test('pacer.act returns result and conflict', async () => {
  const pacer = await startPacer({
    snapshot: () => snapshotWith(),
    onOp: (op) => {
      if (op === 'task.delegate') return { status: 200, body: { result: { task_id: 't-new' } } }
      if (op === 'task.review') return { status: 409, body: { error: { code: 'conflict', message: 'rev mismatch' } } }
      return { status: 404, body: { error: { code: 'unknown_op', message: `unknown op ${op}` } } }
    },
  })
  try {
    const host = hostWithFocusedWorkspace(null)
    const worker = await mountWorker(main, { host })
    const ok = await worker.request('pacer.act', { op: 'task.delegate', params: { goal: 'x', repo: '/r' } })
    assert.deepEqual(ok, { ok: true, result: { task_id: 't-new' } })
    const conflict = await worker.request('pacer.act', {
      op: 'task.review',
      params: { id: 't', verdict: 'accept' },
    })
    assert.deepEqual(conflict, { ok: false, error: 'rev mismatch', conflict: true })
    await worker.deactivate()
  } finally {
    await pacer.dispose()
  }
})

test('ui.open spawns the deep link via injected opener', async () => {
  const opened: string[] = []
  setOpenDesktop(async (url) => {
    opened.push(url)
    return true
  })
  const pacer = await startPacer({ snapshot: () => snapshotWith() })
  try {
    const host = hostWithFocusedWorkspace(null)
    const worker = await mountWorker(main, { host })
    const result = await worker.request('pacer.act', { op: 'ui.open', params: { view: 'overview' } })
    assert.deepEqual(result, { ok: true, result: { opened: true } })
    assert.deepEqual(opened, ['pacer://overview'])
    assert.equal(uiOpenRoute({ view: 'task', id: 't-1' }), 'tasks/t-1')
    assert.equal(uiOpenRoute({ view: 'tasks' }), 'tasks')
    await worker.deactivate()
  } finally {
    resetOpenDesktop()
    await pacer.dispose()
  }
})

test('orca.openWorkspace calls workspace.open', async () => {
  const pacer = await startPacer({ snapshot: () => snapshotWith() })
  try {
    const host = hostWithFocusedWorkspace('/repo')
    const worker = await mountWorker(main, { host })
    const result = await worker.request('orca.openWorkspace', { workspaceId: 'ws1' })
    assert.deepEqual(result, { ok: true })
    assert.ok(host.calls.some((c) => c.method === 'workspace.open' && (c.params as { workspaceId: string }).workspaceId === 'ws1'))
    await worker.deactivate()
  } finally {
    await pacer.dispose()
  }
})

test('a snapshot-changing SSE event posts pacer.changed to open panels', async () => {
  let events: EventConnection | undefined
  const pacer = await startPacer({
    snapshot: () => snapshotWith({ attention: [attentionItem('a1', 'k1')] }),
    onEvents: (connection) => {
      events = connection
    },
  })
  try {
    const host = hostWithFocusedWorkspace(null)
    const worker = await mountWorker(main, { host })
    await waitFor(() => events !== undefined, 'the activation event stream')
    events?.send('id: 6\nevent: attention\ndata: {"id":"a1"}\n\n')
    await waitFor(() => worker.posts.some((post) => post.event === 'pacer.changed'), 'pacer.changed')
    assert.equal(host.data().storage.seq, 6)
    await worker.deactivate()
  } finally {
    await pacer.dispose()
  }
})

test("subscribeEvents' onDrop triggers a reconnect using the last stored seq", async () => {
  const pacer = await startPacer({
    snapshot: () => snapshotWith(),
    onEvents: (connection) => {
      if (pacer.eventConnections.length === 1) {
        connection.send('id: 6\nevent: counts\ndata: {}\n\n')
        connection.close()
      }
    },
  })
  try {
    const host = hostWithFocusedWorkspace(null, { seq: 5 })
    const worker = await mountWorker(main, { host })
    await waitFor(() => pacer.eventConnections.length >= 1, 'the first event stream')
    assert.equal(pacer.eventConnections[0]?.since, '5')
    await waitFor(() => pacer.eventConnections.length >= 2, 'the reconnect')
    assert.equal(pacer.eventConnections[1]?.since, '6')
    await worker.deactivate()
  } finally {
    await pacer.dispose()
  }
})

test('a first connect with empty storage seeds since from the snapshot seq', async () => {
  const pacer = await startPacer({ snapshot: () => snapshotWith({ seq: 42 }) })
  try {
    const host = hostWithFocusedWorkspace(null)
    const worker = await mountWorker(main, { host })
    await waitFor(() => pacer.eventConnections.length >= 1, 'the first event stream')
    assert.equal(pacer.eventConnections[0]?.since, '42')
    await worker.deactivate()
  } finally {
    await pacer.dispose()
  }
})

test('a failed seeding snapshot retries instead of falling back to since=0', async () => {
  let snapshotCalls = 0
  const pacer = await startPacer({
    snapshot: () => {
      snapshotCalls++
      return snapshotCalls <= 2 ? { seq: 999 } : snapshotWith({ seq: 9 })
    },
  })
  try {
    const host = hostWithFocusedWorkspace(null)
    const worker = await mountWorker(main, { host })
    await waitFor(() => pacer.eventConnections.length >= 1, 'the first event stream', 2000)
    assert.equal(pacer.eventConnections[0]?.since, '9')
    await worker.deactivate()
  } finally {
    await pacer.dispose()
  }
})

test('a burst of events collapses into exactly one refresh', async () => {
  let events: EventConnection | undefined
  const pacer = await startPacer({
    snapshot: () => snapshotWith({ attention: [attentionItem('a1', 'k1')] }),
    onEvents: (connection) => {
      events = connection
    },
  })
  try {
    const host = hostWithFocusedWorkspace(null)
    const worker = await mountWorker(main, { host })
    await waitFor(() => events !== undefined, 'the activation event stream')
    const snapshotsBeforeBurst = pacer.snapshotRequests
    events?.send('id: 10\nevent: attention\ndata: {}\n\nid: 11\nevent: attention\ndata: {}\n\nid: 12\nevent: attention\ndata: {}\n\n')
    await waitFor(() => host.data().storage.seq === 12, 'the newest seq to be stored')
    assert.equal(pacer.snapshotRequests - snapshotsBeforeBurst, 1)
    assert.equal(worker.posts.filter((post) => post.event === 'pacer.changed').length, 1)
    await worker.deactivate()
  } finally {
    await pacer.dispose()
  }
})

test('a synthetic reset event never regresses the stored seq', async () => {
  let events: EventConnection | undefined
  const pacer = await startPacer({
    snapshot: () => snapshotWith(),
    onEvents: (connection) => {
      events = connection
    },
  })
  try {
    const host = hostWithFocusedWorkspace(null)
    const worker = await mountWorker(main, { host })
    await waitFor(() => events !== undefined, 'the activation event stream')
    events?.send('id: 10\nevent: attention\ndata: {}\n\n')
    await waitFor(() => host.data().storage.seq === 10, 'the real event to be stored')
    const snapshotsBeforeReset = pacer.snapshotRequests
    events?.send('id: 2\nevent: reset\ndata: {}\n\n')
    await waitFor(() => pacer.snapshotRequests > snapshotsBeforeReset, 'the reset to still trigger a refresh')
    assert.equal(host.data().storage.seq, 10)
    await worker.deactivate()
  } finally {
    await pacer.dispose()
  }
})

test('activation updates the status bar', async () => {
  const pacer = await startPacer({
    snapshot: () =>
      snapshotWith({
        planner: {
          agent: 'Claude',
          usedPct: 62,
          pacePct: 50,
          verdict: 'on_pace',
          advice: 'On pace.',
          mode: 'normal',
          resetsAt: null,
          window: 'week',
          stale: false,
        },
        attention: [attentionItem('a1', 'k1')],
      }),
  })
  try {
    const host = hostWithFocusedWorkspace(null)
    const worker = await mountWorker(main, { host })
    await waitFor(() => statusBarCalls(host).length >= 1, 'the activation status bar update')
    const first = statusBarCalls(host)[0]
    assert.equal(first?.id, STATUS_ITEM)
    // A review anywhere needs a person, so the bar warns even though pace is fine.
    assert.equal(first?.tone, 'warning')
    assert.equal(first?.text, 'pacer 62% · 1 need you')
    await worker.deactivate()
  } finally {
    await pacer.dispose()
  }
})

test('R8: review-compat rewrite hides settled reviews and rewrites partials', () => {
  const tasks = [
    {
      id: 'settled',
      rev: 1,
      title: 'Settled',
      state: 'done',
      repo: null,
      updatedAt: 1,
      review: { accepted: true },
    },
    {
      id: 'partial',
      rev: 1,
      title: 'Partial',
      state: 'partial',
      repo: null,
      updatedAt: 1,
    },
    {
      id: 'open',
      rev: 1,
      title: 'Open review',
      state: 'done',
      repo: null,
      updatedAt: 1,
      reviewRequest: { at: 1 },
    },
  ]
  const items = [
    attentionItem('a', null, { kind: 'review', taskId: 'settled' }),
    attentionItem('b', null, { kind: 'review', taskId: 'partial' }),
    attentionItem('c', null, { kind: 'review', taskId: 'open' }),
    attentionItem('d', null, { kind: 'question', taskId: 'open' }),
  ]
  const out = actionableItems(items, tasks as never[])
  assert.equal(out.some((i) => i.id === 'a'), false)
  const partial = out.find((i) => i.id === 'b')
  assert.equal(partial?.kind, 'failed')
  assert.equal(partial?.detail, 'Execution is incomplete')
  assert.ok(out.some((i) => i.id === 'c' && i.kind === 'review'))
  assert.ok(out.some((i) => i.id === 'd' && i.kind === 'question'))
  assert.equal(filterAttention([attentionItem('snoozed', null, { snoozedUntil: 200 })], 100, []).length, 0)
})

test('uiOpenRoute covers review/session/settings/needs-you and answer tab', () => {
  assert.equal(uiOpenRoute({ view: 'overview' }), 'overview')
  assert.equal(uiOpenRoute({ view: 'needs-you' }), 'needs-you')
  assert.equal(uiOpenRoute({ view: 'review', id: 't-1' }), 'tasks/t-1')
  assert.equal(uiOpenRoute({ view: 'session', id: 't-1' }), 'sessions/t-1')
  assert.equal(uiOpenRoute({ view: 'settings', section: 'executors' }), 'settings/executors')
  assert.equal(uiOpenRoute({ view: 'settings' }), 'settings')
  // N1: tab:answer → sessions/<id>/answer (logic.rs 3-segment form).
  assert.equal(uiOpenRoute({ view: 'task', id: 't-1', tab: 'answer' }), 'sessions/t-1/answer')
  assert.equal(uiOpenRoute({ view: 'task', id: 't-1', tab: 'messages' }), 'tasks/t-1')
  assert.equal(uiOpenRoute({ view: 'task', tab: 'answer' }), 'tasks')
  assert.equal(uiOpenRoute({ view: 'unknown' }), 'overview')
})

test("a not-connected refresh sets the status bar to 'pacer off'", async () => {
  let events: EventConnection | undefined
  const pacer = await startPacer({
    snapshot: () =>
      snapshotWith({
        planner: { agent: 'Claude', usedPct: 62, pacePct: 50, verdict: 'on_pace', advice: 'On pace.', mode: 'normal', resetsAt: null, window: 'week', stale: false },
      }),
    onEvents: (connection) => {
      events = connection
    },
  })
  try {
    const host = hostWithFocusedWorkspace(null)
    const worker = await mountWorker(main, { host })
    await waitFor(() => statusBarCalls(host).length >= 1, 'the activation status bar update')
    rmSync(join(pacer.home, 'token'))
    events?.close()
    await waitFor(() => {
      const calls = statusBarCalls(host)
      return (calls[calls.length - 1]?.text ?? '') === 'pacer off'
    }, 'the not-connected status bar update')
    await worker.deactivate()
  } finally {
    await pacer.dispose()
  }
})

const plannerAt = (usedPct: number | null, verdict: string) => ({
  agent: 'Claude', usedPct, pacePct: 50, verdict, advice: `advice ${verdict}`, mode: 'normal', resetsAt: null, window: 'week', stale: false,
})
const overallOf = (over: Partial<PanelOverall> = {}): PanelOverall => ({ needsYou: 0, running: 0, asked: 0, queued: 0, worktrees: 0, ...over })
const wideBase: PanelSnapshot = { connected: true, at: 1, focusedWorkspace: { path: '/w/gar', name: 'gar' }, planner: null, pause: null, attention: [], tasks: [] }

test('status bar is pacer-wide: pace, then needs-you and running across every worktree', () => {
  const s = { ...wideBase, planner: plannerAt(94, 'ahead'), overall: overallOf({ needsYou: 3, running: 6, queued: 2, worktrees: 4 }) }
  assert.deepEqual(
    { text: paceStatus(s).text, tone: paceStatus(s).tone, tooltip: paceStatus(s).tooltip },
    { text: 'pacer 94% · 3 need you · 6 running', tone: 'warning', tooltip: 'advice ahead · 3 need you · 6 running across all worktrees' },
  )
  // The focused worktree does not change the bar.
  assert.equal(paceStatus({ ...s, focusedWorkspace: null }).text, 'pacer 94% · 3 need you · 6 running')
  assert.equal(paceStatus({ ...s, focusedWorkspace: { path: '/w/empty', name: 'empty' }, tasks: [] }).text, 'pacer 94% · 3 need you · 6 running')
})

test('status bar tone follows pace when nothing needs a person', () => {
  const at = (verdict: string) => paceStatus({ ...wideBase, planner: plannerAt(40, verdict), overall: overallOf({ running: 2 }) })
  assert.deepEqual({ text: at('on_pace').text, tone: at('on_pace').tone }, { text: 'pacer 40% · 2 running', tone: 'success' })
  assert.equal(at('behind').tone, 'success')
  assert.equal(at('ahead').tone, 'warning')
  assert.equal(at('out').tone, 'danger')
  assert.equal(at('unknown').tone, 'neutral')
})

test('status bar without usage or counts, and when pacer is off', () => {
  assert.deepEqual({ text: paceStatus(wideBase).text, tone: paceStatus(wideBase).tone, tooltip: paceStatus(wideBase).tooltip }, { text: 'pacer', tone: 'neutral', tooltip: 'Connected' })
  assert.equal(paceStatus({ ...wideBase, overall: overallOf({ needsYou: 1 }) }).text, 'pacer · 1 need you')
  assert.deepEqual(paceStatus({ ...wideBase, connected: false }), {
    id: STATUS_ITEM,
    text: 'pacer off',
    tone: 'neutral',
    tooltip: 'pacer is not running · open the pacer app to start it',
  })
})

test('overallCounts: a person-addressed item is a need, a question or caller decision is asked, worktrees are distinct', () => {
  const repoAt = (path: string) => ({ key: 'k', label: 'l', path })
  const task = (id: string, path: string, over: Record<string, unknown> = {}) =>
    ({ id, rev: 1, title: id, repo: repoAt(path), executor: 'cursor#cursor', state: 'running', updatedAt: 1, ...over }) as unknown as PacerTask
  const tasks = [
    task('run1', '/w/a'),
    task('run2', '/w/b/'),
    task('deciding', '/w/b', { liveness: { stalled: false, reason: 'caller_decision', since: 1 } }),
    task('q', '/w/c', { state: 'needs_input' }),
    task('queued', '/w/d', { state: 'queued' }),
    task('reviewed', '/w/e', { state: 'done' }),
    task('msg', '/w/a', { state: 'running' }),
    task('old', '/w/f', { state: 'done' }),
    // Back in the queue for a new attempt but its review is still open: a need, not also queued.
    task('requeued', '/w/g', { state: 'queued' }),
  ]
  const attention = [
    { ...attentionItem('r', null), kind: 'review', taskId: 'reviewed' },
    { ...attentionItem('m', null), kind: 'message', taskId: 'msg' },
    { ...attentionItem('qq', null), kind: 'question', taskId: 'q' },
    { ...attentionItem('rq', null), kind: 'review', taskId: 'requeued' },
  ] as AttentionItem[]
  assert.deepEqual(overallCounts(tasks, attention), { needsYou: 3, running: 2, asked: 2, queued: 1, worktrees: 6 })
})

test('executorSummary lists enabled executors in routing order and names shared agents by account', () => {
  const ex = (id: string, agent: string, account: string, rank: number | 'planner', over: Record<string, unknown> = {}) =>
    ({ id, agent, account, rank, state: 'ready', tone: 'good', sub: '', next: false, slots: { used: 0, max: 1 }, enabled: true, ...over })
  const rows = executorSummary([
    ex('claude', 'Claude', 'claude-code', 'planner'),
    ex('cursor', 'cursor', 'cursor', 2, { state: 'exhausted', tone: 'bad' }),
    ex('opencode#oc-gofree', 'opencode', 'oc-gofree', 1),
    ex('opencode#tse', 'opencode', 'tse', 3, { state: 'down', tone: 'weird' }),
    ex('codex', 'Codex', 'codex', 4, { enabled: false }),
  ] as unknown as PacerSnapshot['executors'])
  assert.deepEqual(rows, [
    { id: 'opencode#oc-gofree', name: 'OpenCode · oc-gofree', state: 'ready', tone: 'good' },
    { id: 'cursor', name: 'Cursor', state: 'exhausted', tone: 'bad' },
    { id: 'opencode#tse', name: 'OpenCode · tse', state: 'down', tone: 'muted' },
  ])
})
