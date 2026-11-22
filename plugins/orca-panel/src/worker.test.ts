// Runs src/worker.ts's activate(orca) with the orca object Orca passes, over a mock host.
// The pacer side is a real loopback fixture server (node:http) pointed at by PACER_HOME/
// PACER_PORT, so the worker exercises the real pacer-client end to end rather than a mock.
/// <reference types="@types/bun" />
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'
import type { AttentionItem } from './pacer-client'

const STATUS_ITEM = 'pacer-pace'
const DEFAULT_TOKEN = 'worker-test-token'

type PanelSnapshotLike = { connected: boolean; scope: string; attention: { id: string }[] }

/** A live connection to the fixture's /v3/events stream. */
type EventConnection = { since: string; send(frame: string): void; close(): void }

type PacerFixture = {
  home: string
  port: number
  /** One entry per /v3/events connection, in order (pushed before onEvents runs). */
  eventConnections: { since: string }[]
  /** One entry per POST /v3/ops/<op>. */
  opCalls: { op: string; params: unknown }[]
  snapshotRequests: number
  dispose(): Promise<void>
}

type FixtureOptions = {
  /** Token file content; null writes no token file, so readPacerEndpoint returns null. */
  token?: string | null
  snapshot?: () => object
  onOp?: (op: string, params: unknown) => { status: number; body: unknown }
  onEvents?: (connection: EventConnection) => void
}

// `repo` matches the real wire shape confirmed against a live /v3/snapshot response: the full
// `{ key, path, label }` object every repos[] entry has, not a bare key string (an earlier,
// untested assumption this fixture used to match). `repoKey` is a convenience for the common
// case of a repo that's also in the test's own `repos:` list, synthesizing a label/path from
// the key; pass the full object directly when a test needs its own distinct label.
const attentionItem = (id: string, repo?: string | { key: string; path: string; label: string }): AttentionItem => ({
  id,
  kind: 'review',
  severity: 'decide',
  ...(repo ? { repo: typeof repo === 'string' ? { key: repo, path: `/${repo}`, label: repo } : repo } : {}),
  title: `Item ${id}`,
  detail: `${id} needs you`,
  raisedAt: 100,
  since: 100,
  actions: [{ label: 'Dismiss', op: 'attention.dismiss', params: { id } }],
  notify: false,
})

const snapshotWith = (over: { attention?: AttentionItem[]; repos?: { key: string; label: string; path: string }[]; planner?: unknown; seq?: number } = {}) => ({
  seq: over.seq ?? 5,
  planner: over.planner ?? null,
  counts: { attention: (over.attention ?? []).length },
  attention: over.attention ?? [],
  repos: over.repos ?? [],
})

/** A mock host whose focused workspace (ws1) lives at `path`, plus a status bar that answers. */
function hostWithFocusedWorkspace(path: string | null, storage: { seq?: number } = {}) {
  return mockHost({
    storage,
    results: {
      'workspace.readContext': path === null ? null : { workspaceId: 'ws1', branch: 'main', displayName: 'repo', terminals: [] },
      'workspace.list': {
        workspaces:
          path === null
            ? []
            : [{ id: 'ws1', kind: 'worktree' as const, name: 'repo', path, branch: 'main', hostId: 'local' }],
        truncated: false,
      },
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

/** Starts the fixture pacer service on an ephemeral loopback port and points PACER_HOME/
 *  PACER_PORT at it. Every route demands the token's bearer auth. `dispose()` restores the
 *  environment, ends every stream and removes the temp home. */
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
      // Real wire shape (docs/protocol.md "HTTP routes"): `{ protocol, seq, snapshot }`.
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
    const snapshot = await worker.request('pacer.snapshot')
    assert.deepEqual(snapshot, { connected: false, scope: 'global', attention: [] })
    // With no endpoint the worker never reaches pacer and never subscribes.
    assert.equal(pacer.eventConnections.length, 0)
    assert.equal(pacer.snapshotRequests, 0)
    // Actions answer ok:false instead of crashing.
    const act = await worker.request('pacer.act', { op: 'attention.dismiss', params: { id: 'a1' } })
    assert.deepEqual(act, { ok: false, error: 'pacer is not connected' })
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  } finally {
    await pacer.dispose()
  }
})

test("pacer.snapshot scopes to the workspace's repo when its path matches one of pacer's repos", async () => {
  const pacer = await startPacer({
    snapshot: () =>
      snapshotWith({
        repos: [{ key: 'k1', label: 'jawfish', path: '/repo' }],
        attention: [attentionItem('the-k1-one', 'k1'), attentionItem('the-k2-one', 'k2')],
      }),
  })
  try {
    const host = hostWithFocusedWorkspace('/repo')
    const worker = await mountWorker(main, { host })
    const snapshot = await worker.request('pacer.snapshot')
    assert.equal(snapshot.connected, true)
    assert.equal(snapshot.scope, 'repo')
    assert.equal(snapshot.repoLabel, 'jawfish')
    assert.deepEqual(snapshot.attention.map((a) => a.id), ['the-k1-one'])
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  } finally {
    await pacer.dispose()
  }
})

test("pacer.snapshot falls back to scope:'global' when the workspace path matches no repo", async () => {
  const pacer = await startPacer({
    snapshot: () =>
      snapshotWith({
        repos: [{ key: 'k1', label: 'jawfish', path: '/repo' }],
        attention: [
          attentionItem('the-k1-one', { key: 'k1', path: '/repo', label: 'jawfish' }),
          attentionItem('the-k2-one', { key: 'k2', path: '/other', label: 'other-repo' }),
          { ...attentionItem('the-global-one'), kind: 'setup' },
        ],
      }),
  })
  try {
    const host = hostWithFocusedWorkspace('/elsewhere')
    const worker = await mountWorker(main, { host })
    const snapshot = await worker.request('pacer.snapshot')
    assert.equal(snapshot.scope, 'global')
    assert.equal(snapshot.repoLabel, undefined)
    assert.deepEqual(snapshot.attention.map((a) => a.id), ['the-k1-one', 'the-k2-one', 'the-global-one'])
    // Every row in the global view carries its own repo's label straight from the item itself
    // (the real wire shape, confirmed against a live /v3/snapshot response - not a bare key to
    // resolve against repos[]) - a list spanning many repos is otherwise unreadable (which row
    // is from where?). An item with no repo at all (a global/setup-kind item) has no label.
    assert.deepEqual(snapshot.attention.map((a) => a.repoLabel), ['jawfish', 'other-repo', undefined])
    await worker.deactivate()

    // No focused workspace at all is the same global view.
    const idleHost = hostWithFocusedWorkspace(null)
    const idleWorker = await mountWorker(main, { host: idleHost })
    const idleSnapshot = await idleWorker.request('pacer.snapshot')
    assert.equal(idleSnapshot.scope, 'global')
    assert.deepEqual(idleSnapshot.attention.map((a) => a.id), ['the-k1-one', 'the-k2-one', 'the-global-one'])
    assert.deepEqual(idleWorker.refusals, [])
    await idleWorker.deactivate()
  } finally {
    await pacer.dispose()
  }
})

test('pacer.act forwards op/params to callOp and returns its result', async () => {
  const pacer = await startPacer({
    snapshot: () => snapshotWith(),
    onOp: (op, params) =>
      op === 'attention.dismiss'
        ? { status: 200, body: { result: { dismissed: params } } }
        : { status: 404, body: { error: { code: 'unknown_op', message: `unknown op ${op}` } } },
  })
  try {
    const host = hostWithFocusedWorkspace(null)
    const worker = await mountWorker(main, { host })
    const ok = await worker.request('pacer.act', { op: 'attention.dismiss', params: { id: 'a1' } })
    assert.deepEqual(ok, { ok: true })
    assert.deepEqual(pacer.opCalls, [{ op: 'attention.dismiss', params: { id: 'a1' } }])
    const failed = await worker.request('pacer.act', { op: 'attention.nope', params: {} })
    assert.deepEqual(failed, { ok: false, error: 'unknown op attention.nope' })
    assert.deepEqual(worker.refusals, [])
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
    const post = worker.posts.find((candidate) => candidate.event === 'pacer.changed')
    const snapshot = (post?.payload as { snapshot: PanelSnapshotLike } | undefined)?.snapshot
    assert.equal(snapshot?.connected, true)
    assert.deepEqual(snapshot?.attention.map((a) => a.id), ['a1'])
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  } finally {
    await pacer.dispose()
  }
})

test("subscribeEvents' onDrop triggers a reconnect using the last stored seq, read from orca.storage", async () => {
  const pacer = await startPacer({
    snapshot: () => snapshotWith(),
    onEvents: (connection) => {
      // The first connection replays one event and drops; the reconnect must hold.
      if (pacer.eventConnections.length === 1) {
        connection.send('id: 6\nevent: counts\ndata: {}\n\n')
        connection.close()
      }
    },
  })
  try {
    const host = hostWithFocusedWorkspace(null, { seq: 5 })
    const worker = await mountWorker(main, { host })
    // Activation resumed from the stored seq.
    await waitFor(() => pacer.eventConnections.length >= 1, 'the first event stream')
    assert.equal(pacer.eventConnections[0]?.since, '5')
    // The drop triggers a reconnect that resumes from the seq the event stored.
    await waitFor(() => pacer.eventConnections.length >= 2, 'the reconnect')
    assert.equal(pacer.eventConnections[1]?.since, '6')
    assert.equal(host.data().storage.seq, 6)
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  } finally {
    await pacer.dispose()
  }
})

test('a first connect with empty storage seeds `since` from the snapshot\'s own seq, never from 0', async () => {
  const pacer = await startPacer({ snapshot: () => snapshotWith({ seq: 42 }) })
  try {
    const host = hostWithFocusedWorkspace(null)
    const worker = await mountWorker(main, { host })
    await waitFor(() => pacer.eventConnections.length >= 1, 'the first event stream')
    // The seeding snapshot fetch happens before the stream subscribes, and its seq - not 0 -
    // is what the first connection asks the server to resume from.
    assert.equal(pacer.snapshotRequests >= 1, true)
    assert.equal(pacer.eventConnections[0]?.since, '42')
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  } finally {
    await pacer.dispose()
  }
})

test('a failed seeding snapshot retries instead of falling back to since=0', async () => {
  // Activation fires two independent getSnapshot calls (refresh()'s one-shot status-bar
  // update, and seedAndConnect's own seed), so the first two responses are malformed
  // (pacer not fully up yet - getSnapshot returns { error } for both) and only the third
  // onward is a real snapshot: whichever call seedAndConnect's is, it fails at least once
  // and must retry rather than ever subscribing with 0.
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
    // Never subscribed with a failed attempt's seq or 0 - only the retried seed's real seq.
    assert.equal(pacer.eventConnections[0]?.since, '9')
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  } finally {
    await pacer.dispose()
  }
})

test('a burst of events delivered in one chunk collapses into exactly one refresh, using the newest seq', async () => {
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
    // Three events delivered together, as the real crash's instant backlog replay did.
    events?.send('id: 10\nevent: attention\ndata: {}\n\nid: 11\nevent: attention\ndata: {}\n\nid: 12\nevent: attention\ndata: {}\n\n')
    await waitFor(() => host.data().storage.seq === 12, 'the newest seq to be stored')
    // Exactly one refresh for the whole burst, not one per event.
    assert.equal(pacer.snapshotRequests - snapshotsBeforeBurst, 1)
    assert.equal(worker.posts.filter((post) => post.event === 'pacer.changed').length, 1)
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  } finally {
    await pacer.dispose()
  }
})

test('a synthetic reset event (seq below the stored cursor) never regresses the stored seq', async () => {
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
    // A retention reset carries a seq below the client's real position.
    events?.send('id: 2\nevent: reset\ndata: {}\n\n')
    await waitFor(() => pacer.snapshotRequests > snapshotsBeforeReset, 'the reset to still trigger a refresh')
    assert.equal(host.data().storage.seq, 10)
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  } finally {
    await pacer.dispose()
  }
})

test('activation and every snapshot change update the status bar item with the planner pace and tone', async () => {
  let events: EventConnection | undefined
  const pacer = await startPacer({
    snapshot: () =>
      snapshotWith({
        planner: {
          runner: 'r1',
          agent: 'claude',
          usedPct: 62,
          pacePct: 50,
          deltaPts: 12,
          verdict: 'on_pace',
          activeHoursLeft: 3,
          resetsAt: null,
          window: '5h',
          stale: false,
          advice: 'On pace.',
          mode: 'normal',
        },
        attention: [attentionItem('a1', 'k1')],
      }),
    onEvents: (connection) => {
      events = connection
    },
  })
  try {
    const host = hostWithFocusedWorkspace(null)
    const worker = await mountWorker(main, { host })
    await waitFor(() => statusBarCalls(host).length >= 1, 'the activation status bar update')
    const first = statusBarCalls(host)[0]
    assert.deepEqual({ id: first?.id, text: first?.text, tone: first?.tone }, { id: STATUS_ITEM, text: 'pacer 62%', tone: 'success' })
    assert.match(first?.tooltip ?? '', /On pace\./)

    events?.send('id: 6\nevent: counts\ndata: {}\n\n')
    await waitFor(() => statusBarCalls(host).length >= 2, 'the status bar update after the event')
    const second = statusBarCalls(host)[1]
    assert.equal(second?.id, STATUS_ITEM)
    assert.equal(second?.text, 'pacer 62%')
    assert.equal(second?.tone, 'success')
    assert.match(second?.tooltip ?? '', /1 needs? you/)
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  } finally {
    await pacer.dispose()
  }
})

test("a not-connected refresh sets the status bar to a fixed 'not connected' text/tone instead of leaving stale pace text", async () => {
  let events: EventConnection | undefined
  const pacer = await startPacer({
    snapshot: () => snapshotWith({ planner: { usedPct: 62, verdict: 'on_pace', advice: 'On pace.' } }),
    onEvents: (connection) => {
      events = connection
    },
  })
  try {
    const host = hostWithFocusedWorkspace(null)
    const worker = await mountWorker(main, { host })
    await waitFor(() => statusBarCalls(host).length >= 1, 'the activation status bar update')
    assert.equal(statusBarCalls(host)[0]?.text, 'pacer 62%')

    // The token goes away and the stream drops: the reconnect finds no endpoint and must say so.
    rmSync(join(pacer.home, 'token'))
    events?.close()
    await waitFor(() => {
      const calls = statusBarCalls(host)
      return (calls[calls.length - 1]?.text ?? '') === 'pacer off'
    }, 'the not-connected status bar update')
    const last = statusBarCalls(host)[statusBarCalls(host).length - 1]
    assert.deepEqual({ id: last?.id, tone: last?.tone }, { id: STATUS_ITEM, tone: 'neutral' })
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  } finally {
    await pacer.dispose()
  }
})
