// The plugin's own worker: a pacer v3 client feeding the panel (pacer.snapshot/pacer.act)
// and the status bar item. Orca starts it when the plugin is enabled and keeps it running,
// so the live loop (subscribeEvents + reconnect) runs without any panel open.
/// <reference types="@types/bun" />
import type { OrcaWorkerApi } from 'orca/worker'
import { callOp, getSnapshot, readPacerEndpoint, subscribeEvents, type PacerSnapshot } from './pacer-client'
import type { PanelSnapshot } from './protocol'

const SEQ_KEY = 'seq'
const STATUS_ITEM = 'pacer-pace'
/** How long to wait before reconnecting a dropped event stream. */
const RECONNECT_MS = 500

/** What the panel sees when pacer has no token or is unreachable: never a crash or stale data. */
const NOT_CONNECTED: PanelSnapshot = { connected: false, scope: 'global', attention: [] }

/** The planner fields the status bar reads; the shared snapshot keeps `planner` as unknown. */
type PlannerPace = { usedPct?: number | null; verdict?: string; advice?: string }

type StatusTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

/** The focused workspace's path, or null when none is focused (or the host refuses to say). */
async function focusedWorkspacePath(orca: OrcaWorkerApi): Promise<string | null> {
  try {
    const context = await orca.host.call('workspace.readContext')
    const workspaceId = context?.workspaceId
    if (!workspaceId) return null
    const list = await orca.host.call('workspace.list')
    return list.workspaces.find((workspace) => workspace.id === workspaceId)?.path ?? null
  } catch {
    // No workspace scope is not an error: the panel just shows the global list.
    return null
  }
}

/** Scope `attention` to the focused workspace's repo when pacer knows that path. */
async function scopeToFocusedWorkspace(orca: OrcaWorkerApi, snapshot: PacerSnapshot): Promise<Pick<PanelSnapshot, 'scope' | 'repoLabel' | 'attention'>> {
  const path = await focusedWorkspacePath(orca)
  const repo = path === null ? undefined : snapshot.repos.find((candidate) => candidate.path === path)
  if (!repo) return { scope: 'global', attention: snapshot.attention }
  return { scope: 'repo', repoLabel: repo.label, attention: snapshot.attention.filter((item) => item.repo === repo.key) }
}

/** The snapshot the panel should see right now: not-connected, or the scoped live one. */
async function currentSnapshot(orca: OrcaWorkerApi): Promise<PanelSnapshot> {
  const endpoint = readPacerEndpoint(process.env)
  if (endpoint === null) return NOT_CONNECTED
  const snapshot = await getSnapshot(endpoint)
  if ('error' in snapshot) return NOT_CONNECTED
  return { connected: true, ...(await scopeToFocusedWorkspace(orca, snapshot)), counts: snapshot.counts, planner: snapshot.planner }
}

function paceStatus(snapshot: PanelSnapshot): { id: string; text: string; tone: StatusTone; tooltip: string } {
  if (!snapshot.connected) {
    return { id: STATUS_ITEM, text: 'pacer off', tone: 'neutral', tooltip: 'Pacer is not connected — is pacer serve running?' }
  }
  const attention = snapshot.attention.length
  const needYou = attention > 0 ? ` · ${attention} need${attention === 1 ? 's' : ''} you` : ''
  const planner = snapshot.planner as PlannerPace | null | undefined
  if (planner === null || planner === undefined || typeof planner.usedPct !== 'number') {
    return { id: STATUS_ITEM, text: 'pacer', tone: 'neutral', tooltip: `Connected${needYou}` }
  }
  const verdict = planner.verdict ?? 'unknown'
  const advice = typeof planner.advice === 'string' && planner.advice !== '' ? planner.advice : 'Pacer budget and pace'
  const tone: StatusTone =
    verdict === 'on_pace' || verdict === 'ahead' ? 'success' : verdict === 'behind' ? 'warning' : verdict === 'out' ? 'danger' : 'neutral'
  return { id: STATUS_ITEM, text: `pacer ${Math.round(planner.usedPct)}%`, tone, tooltip: `${advice}${needYou}` }
}

async function updateStatusBar(orca: OrcaWorkerApi, snapshot: PanelSnapshot): Promise<void> {
  const { id, text, tone, tooltip } = paceStatus(snapshot)
  try {
    await orca.host.call('statusBar.update', { id, text, tone, tooltip })
  } catch (error) {
    // Best-effort surface: a host without a status bar must never break the refresh loop.
    orca.log(`status bar update failed: ${String(error)}`)
  }
}

/** The running activation's live loop, so `deactivate` stops exactly it. */
let activeLoop: { stop(): void } | null = null

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('pacer.snapshot', async () => currentSnapshot(orca))

  // The return annotation keeps `ok: true`/`ok: false` literal through the ternary.
  orca.panels.handle('pacer.act', async ({ op, params }): Promise<{ ok: true } | { ok: false; error: string }> => {
    const endpoint = readPacerEndpoint(process.env)
    if (endpoint === null) return { ok: false, error: 'pacer is not connected' }
    const result = await callOp(endpoint, op, params)
    return result.ok ? { ok: true } : { ok: false, error: result.error }
  })

  let stopped = false
  let abortStream: (() => void) | null = null
  let reconnect: ReturnType<typeof setTimeout> | null = null

  const stop = (): void => {
    stopped = true
    abortStream?.()
    if (reconnect !== null) clearTimeout(reconnect)
    reconnect = null
  }

  /** One refresh: refetch the snapshot and keep the status bar current. */
  const refresh = async (): Promise<PanelSnapshot> => {
    const snapshot = await currentSnapshot(orca)
    await updateStatusBar(orca, snapshot)
    return snapshot
  }

  // A burst of events (a long-buffered reconnect, or a first connect with history to replay)
  // must collapse into one refresh, not one per event - without this, a few hundred backlogged
  // events fire a few hundred concurrent HTTP requests and crash the worker (observed live:
  // `setTypeOfService EINVAL` under exactly this load).
  let latestSeq: number | null = null
  let refreshPending = false
  const onEvent = (seq: number): void => {
    if (stopped) return
    latestSeq = seq
    if (refreshPending) return
    refreshPending = true
    void (async () => {
      try {
        // Let the burst settle: handle the newest seq seen in this tick, not each one.
        await Promise.resolve()
        const toStore = latestSeq
        refreshPending = false
        if (toStore === null || stopped) return
        await orca.storage.set(SEQ_KEY, toStore)
        const snapshot = await refresh()
        orca.panels.post('pacer.changed', { snapshot })
      } catch (error) {
        refreshPending = false
        // One failed refresh must never kill the live loop.
        orca.log(`pacer event refresh failed: ${String(error)}`)
      }
    })()
  }

  /** (Re)connect the event stream, resuming from the seq the worker last stored, or from the
   *  just-fetched snapshot's own seq on a first connect - never from 0, which would replay the
   *  server's entire event history as an immediate burst. */
  const connect = (initialSeq: number): void => {
    if (stopped) return
    const endpoint = readPacerEndpoint(process.env)
    if (endpoint === null) {
      // No token: nothing to subscribe to. The badge says so; the loop rests until Orca
      // restarts the worker (each snapshot request re-reads the endpoint meanwhile).
      void updateStatusBar(orca, NOT_CONNECTED)
      return
    }
    void (async () => {
      const stored = await orca.storage.get(SEQ_KEY)
      if (stopped) return
      const since = typeof stored === 'number' ? stored : initialSeq
      abortStream = subscribeEvents(endpoint, since, onEvent, () => {
        if (stopped) return
        reconnect = setTimeout(() => {
          reconnect = null
          connect(since)
        }, RECONNECT_MS)
      })
    })()
  }

  // The badge shows the current pace before any event arrives; the live loop keeps it fresh.
  // Seed the first connect from the current seq (one extra startup fetch) so a long-idle
  // server's full backlog is never replayed as a burst.
  void refresh()
  void (async () => {
    const endpoint = readPacerEndpoint(process.env)
    if (endpoint === null) return
    const snapshot = await getSnapshot(endpoint)
    if (stopped) return
    connect('error' in snapshot ? 0 : snapshot.seq)
  })()
  activeLoop = { stop }
}

/** Orca awaits this before the worker stops; the test kit's `deactivate` runs it too. */
export function deactivate(): void {
  activeLoop?.stop()
  activeLoop = null
}
