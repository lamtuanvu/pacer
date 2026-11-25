// The plugin's own worker: a pacer v3 client feeding the panel (pacer.snapshot/pacer.act)
// and the status bar item. Orca starts it when the plugin is enabled and keeps it running,
// so the live loop (subscribeEvents + reconnect) runs without any panel open.
import { execFile, spawn } from 'node:child_process'
import { dirname, resolve as resolvePath } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  callOp,
  getSnapshot,
  readPacerEndpoint,
  subscribeEvents,
  type AttentionItem,
  type PacerSnapshot,
  type PacerTask,
} from './pacer-client'
import type { ActResult, AttentionRow, PanelSnapshot, PanelTask, RepoRef } from './protocol'

const SEQ_KEY = 'seq'
const STATUS_ITEM = 'pacer-pace'
/** How long to wait before reconnecting a dropped event stream. */
const RECONNECT_MS = 500

/** What the panel sees when pacer has no token or is unreachable. */
const NOT_CONNECTED: PanelSnapshot = {
  connected: false,
  at: 0,
  focusedWorkspace: null,
  planner: null,
  pause: null,
  repos: [],
  attention: [],
  running: [],
  queued: [],
  doneToday: [],
  executors: [],
}

type StatusTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

type OpenDesktop = (url: string) => Promise<boolean>

/** Injected in tests so nothing real launches; production uses open / xdg-open. */
let openDesktopFn: OpenDesktop = defaultOpenDesktop

export function setOpenDesktop(fn: OpenDesktop): void {
  openDesktopFn = fn
}

export function resetOpenDesktop(): void {
  openDesktopFn = defaultOpenDesktop
}

/** Resolve a worktree's owning repo via `git rev-parse --git-common-dir`; injected in tests. */
export type GitCommonDir = (workspacePath: string) => Promise<string | null>

async function defaultGitCommonDir(workspacePath: string): Promise<string | null> {
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        'git',
        ['-C', workspacePath, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
        { timeout: 2000, encoding: 'utf8' },
        (error, out) => {
          if (error) reject(error)
          else resolve(out)
        },
      )
    })
    const common = stdout.trim()
    if (!common) return null
    return dirname(common)
  } catch {
    return null
  }
}

let gitCommonDirFn: GitCommonDir = defaultGitCommonDir

export function setGitCommonDir(fn: GitCommonDir): void {
  gitCommonDirFn = fn
}

export function resetGitCommonDir(): void {
  gitCommonDirFn = defaultGitCommonDir
}

/** Strip trailing slashes and resolve for cheap path equality. */
export function normalizeRepoPath(path: string): string {
  const resolved = resolvePath(path)
  return resolved.replace(/\/+$/, '') || '/'
}

/**
 * Spawn the desktop deep-link opener with an argv array (no shell). Orca's trusted-worker
 * is a Node process, so this uses node:child_process — not Bun.spawn.
 * Resolves true only when the spawn itself succeeded (listen for 'error').
 */
async function defaultOpenDesktop(url: string): Promise<boolean> {
  const argv = process.platform === 'darwin' ? ['open', url] : process.platform === 'linux' ? ['xdg-open', url] : null
  if (!argv) return false
  return await new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    try {
      const child = spawn(argv[0]!, argv.slice(1), {
        detached: true,
        stdio: 'ignore',
      })
      child.once('error', () => done(false))
      child.once('spawn', () => done(true))
      child.unref()
    } catch {
      done(false)
    }
  })
}

/**
 * Map ui.open params to a `pacer://` route the desktop deep-link handler accepts
 * (desktop/src-tauri/src/logic.rs::route + app/src/data/actions.ts::uiHref).
 *
 * Answer intents (`tab:"answer"`): logic.rs accepts the 3-segment form
 * `sessions/<id>/answer` (logic.rs ~1424–1427; test ~2349–2360). Query forms like
 * `needs-you?answer=` are rejected on `pacer://` (early `?` guard), so we use the
 * path form instead of falling back to `tasks/<id>`.
 */
export function uiOpenRoute(params: Record<string, unknown>): string {
  const view = typeof params.view === 'string' ? params.view : 'overview'
  const id = typeof params.id === 'string' ? params.id : ''
  const section = typeof params.section === 'string' ? params.section : ''
  const tab = typeof params.tab === 'string' ? params.tab : ''
  switch (view) {
    case 'overview':
    case 'home':
      return 'overview'
    case 'needs-you':
      return 'needs-you'
    case 'tasks':
      return id ? `tasks/${id}` : 'tasks'
    case 'task':
      if (tab === 'answer' && id) return `sessions/${id}/answer`
      return id ? `tasks/${id}` : 'tasks'
    case 'review':
      return id ? `tasks/${id}` : 'needs-you'
    case 'session':
      return id ? `sessions/${id}` : 'sessions'
    case 'settings':
      return section ? `settings/${section}` : 'settings'
    default:
      return 'overview'
  }
}

const SEVERITY = { blocked: 0, problem: 1, decide: 2 } as const

/** Same ordering as src/view-model/selectors.ts attentionOrder. */
export function attentionOrder(a: AttentionItem, b: AttentionItem): number {
  return (SEVERITY[a.severity] ?? 3) - (SEVERITY[b.severity] ?? 3) || a.raisedAt - b.raisedAt
}

/**
 * Compatibility for old services that raised a review for every completion.
 * Port of src/view-model/selectors.ts actionableItems.
 */
export function actionableItems(items: AttentionItem[], tasks: PacerTask[]): AttentionItem[] {
  return items.flatMap((item) => {
    if (item.kind !== 'review') return [item]
    const task = tasks.find((t) => t.id === item.taskId)
    if (!task) return [item]
    if (task.review || task.resolved || task.dismissed || task.retriedBy) return []
    if (task.state === 'partial' || task.acceptanceState === 'failed') {
      return [
        {
          ...item,
          kind: 'failed',
          severity: 'problem',
          detail:
            task.acceptanceState === 'failed' ? 'Acceptance checks failed' : 'Execution is incomplete',
          actions: [
            {
              label: task.acceptanceState === 'failed' ? 'Inspect failures' : 'Inspect incomplete work',
              op: 'ui.open',
              params: { view: 'task', id: task.id },
            },
          ],
        },
      ]
    }
    return task.state !== 'done' || task.reviewRequest ? [item] : []
  })
}

/** Snooze-filter + order; port of selectors.needsYou({repo:null}) including the review-compat rewrite. */
export function filterAttention(items: AttentionItem[], at: number, tasks: PacerTask[] = []): AttentionItem[] {
  return actionableItems(items, tasks)
    .filter((a) => !(a.snoozedUntil && a.snoozedUntil > at))
    .slice()
    .sort(attentionOrder)
}

function inScope(repoKey: string | null, repo: RepoRef | null | undefined): boolean {
  return repoKey === null || !repo || repo.key === repoKey
}

/** In-flight running work only (queued is a separate section). */
export function selectRunning(tasks: PacerTask[], repoKey: string | null): PacerTask[] {
  return tasks.filter(
    (t) =>
      t.state !== 'queued' &&
      (t.state === 'running' || !!t.activeAgentSessions) &&
      !t.dismissed &&
      inScope(repoKey, t.repo),
  )
}

/** Queued tasks waiting for a slot or for resume. */
export function selectQueued(tasks: PacerTask[], repoKey: string | null): PacerTask[] {
  return tasks.filter((t) => t.state === 'queued' && !t.dismissed && inScope(repoKey, t.repo))
}

export function selectDoneToday(tasks: PacerTask[], since: number | undefined, repoKey: string | null): PacerTask[] {
  if (since === undefined) return []
  return tasks
    .filter(
      (t) =>
        t.source !== 'onboarding' &&
        t.state !== 'running' &&
        t.state !== 'queued' &&
        !t.activeAgentSessions &&
        t.updatedAt >= since &&
        inScope(repoKey, t.repo),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

function trimTask(task: PacerTask, orcaByPath: Map<string, string>): PanelTask {
  const worktree = task.worktree ?? null
  const orcaWorkspaceId = worktree ? orcaByPath.get(normalizeRepoPath(worktree)) : undefined
  return {
    id: task.id,
    rev: task.rev,
    title: task.title,
    repo: task.repo,
    repoLabel: task.repo?.label,
    executor: task.executor,
    state: task.state,
    phase: task.progress?.phase,
    attemptStartedAt: task.attemptStartedAt,
    updatedAt: task.updatedAt,
    review: task.review ?? null,
    liveness: task.liveness ?? null,
    worktree,
    ...(orcaWorkspaceId ? { orcaWorkspaceId } : {}),
  }
}

type WorkspaceRow = { id: string; name?: string; path: string; projectId?: string | null }
type ProjectRow = { id: string; path: string }

async function listWorkspaces(orca: OrcaWorkerApi): Promise<WorkspaceRow[]> {
  try {
    const list = await orca.host.call('workspace.list')
    return list.workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      path: w.path,
      projectId: w.projectId ?? null,
    }))
  } catch {
    return []
  }
}

async function listProjects(orca: OrcaWorkerApi): Promise<ProjectRow[]> {
  try {
    const list = await orca.host.call('project.list')
    return list.projects.map((p) => ({ id: p.id, path: p.path }))
  } catch {
    return []
  }
}

async function focusedWorkspacePath(orca: OrcaWorkerApi): Promise<string | null> {
  try {
    const context = await orca.host.call('workspace.readContext')
    const workspaceId = context?.workspaceId
    if (!workspaceId) return null
    const list = await orca.host.call('workspace.list')
    return list.workspaces.find((workspace) => workspace.id === workspaceId)?.path ?? null
  } catch {
    return null
  }
}

/**
 * Match the focused Orca workspace to a pacer RepoRef: exact path, then project.list path via
 * workspace.projectId, then git common-dir owner. Stops at the first hit; never throws.
 */
export async function resolveFocusedRepo(
  repos: RepoRef[],
  focusedPath: string | null,
  workspaces: WorkspaceRow[],
  projects: ProjectRow[],
  gitCommonDir: GitCommonDir = gitCommonDirFn,
): Promise<RepoRef | null> {
  if (focusedPath === null) return null
  const findByPath = (path: string): RepoRef | null => {
    const want = normalizeRepoPath(path)
    return repos.find((r) => normalizeRepoPath(r.path) === want) ?? null
  }

  const exact = findByPath(focusedPath)
  if (exact) return exact

  const focusedNorm = normalizeRepoPath(focusedPath)
  const workspace = workspaces.find((w) => normalizeRepoPath(w.path) === focusedNorm)
  if (workspace?.projectId) {
    const project = projects.find((p) => p.id === workspace.projectId)
    if (project) {
      const viaProject = findByPath(project.path)
      if (viaProject) return viaProject
    }
  }

  try {
    const commonDir = await gitCommonDir(focusedPath)
    if (commonDir) {
      const viaGit = findByPath(commonDir)
      if (viaGit) return viaGit
    }
  } catch {
    // git failure → no match; never throw from resolution
  }
  return null
}

async function buildPanelSnapshot(
  snapshot: PacerSnapshot,
  focusedPath: string | null,
  workspaces: WorkspaceRow[],
  projects: ProjectRow[],
): Promise<PanelSnapshot> {
  const orcaByPath = new Map(workspaces.map((w) => [normalizeRepoPath(w.path), w.id]))
  const focusedWorkspace = focusedPath
    ? {
        path: focusedPath,
        name:
          workspaces.find((w) => normalizeRepoPath(w.path) === normalizeRepoPath(focusedPath))?.name ??
          workspaces.find((w) => normalizeRepoPath(w.path) === normalizeRepoPath(focusedPath))?.id ??
          focusedPath.split('/').filter(Boolean).pop() ??
          focusedPath,
      }
    : null

  // A task belongs to this worktree when its repo.path equals the focused workspace path.
  const worktreeTasks = focusedPath
    ? snapshot.tasks.filter((t) => {
        const p = t.repo?.path
        return typeof p === 'string' && normalizeRepoPath(p) === normalizeRepoPath(focusedPath)
      })
    : []
  const taskIds = new Set(worktreeTasks.map((t) => t.id))

  // Next executor name for queued rows (first enabled non-planner with a free slot).
  const nextExecutorName = (() => {
    const row = snapshot.executors
      .filter((e) => e.rank !== 'planner' && e.enabled)
      .sort((a, b) => Number(a.rank) - Number(b.rank))
      .find((e) => e.slots.used < e.slots.max)
    return row ? `${row.agent}` : null
  })()

  const trimTask = (task: PacerTask): PanelTask => {
    const base = task.worktree ?? null
    const orcaWorkspaceId = base ? orcaByPath.get(normalizeRepoPath(base)) : undefined
    return {
      id: task.id,
      rev: task.rev,
      title: task.title,
      repo: task.repo,
      repoLabel: task.repo?.label,
      executor: task.executor,
      state: task.state,
      phase: task.progress?.phase,
      attemptStartedAt: task.attemptStartedAt,
      updatedAt: task.updatedAt,
      review: task.review ?? null,
      liveness: task.liveness ?? null,
      worktree: base,
      ...(orcaWorkspaceId ? { orcaWorkspaceId } : {}),
      question: (task as { question?: string | null }).question ?? null,
      nextExecutor: task.state === 'queued' ? nextExecutorName : null,
    }
  }

  const trimmedTasks = worktreeTasks.map(trimTask)

  // Attention items whose taskId is one of this worktree's tasks; actionableItems compatibility.
  const filteredAttention = filterAttention(snapshot.attention, snapshot.at, snapshot.tasks)
    .filter((a) => !!a.taskId && taskIds.has(a.taskId))
    .map((item): AttentionRow => ({ ...item, repoLabel: item.repo?.label }))

  const planner = snapshot.planner
    ? {
        agent: snapshot.planner.agent,
        usedPct: snapshot.planner.usedPct,
        pacePct: snapshot.planner.pacePct,
        verdict: snapshot.planner.verdict,
        advice: snapshot.planner.advice,
        mode: snapshot.planner.mode,
        modeHeldUntil: snapshot.planner.modeHeldUntil,
        resetsAt: snapshot.planner.resetsAt,
        window: snapshot.planner.window,
        stale: snapshot.planner.stale,
      }
    : null

  const running = selectRunning(worktreeTasks, null).map(trimTask)
  const queued = selectQueued(worktreeTasks, null).map(trimTask)
  const doneToday = selectDoneToday(worktreeTasks, snapshot.today?.since, null).map(trimTask)

  return {
    connected: true,
    at: snapshot.at,
    focusedWorkspace,
    planner,
    pause: snapshot.pause,
    repos: [],
    attention: filteredAttention,
    running,
    queued,
    tasks: trimmedTasks,
    doneToday,
    executors: [],
  }
}

async function currentSnapshot(orca: OrcaWorkerApi): Promise<PanelSnapshot> {
  const endpoint = readPacerEndpoint(process.env)
  if (endpoint === null) return NOT_CONNECTED
  const snapshot = await getSnapshot(endpoint)
  if ('error' in snapshot) return NOT_CONNECTED
  const [focusedPath, workspaces, projects] = await Promise.all([
    focusedWorkspacePath(orca),
    listWorkspaces(orca),
    listProjects(orca),
  ])
  return buildPanelSnapshot(snapshot, focusedPath, workspaces, projects)
}

function formatAbsLocal(at: number, now = Date.now() / 1000): string {
  const d = new Date(at * 1000)
  const time = d.toLocaleTimeString('en-GB', { hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
  const sameDay =
    new Date(now * 1000).toLocaleDateString('en-CA') === d.toLocaleDateString('en-CA')
  if (sameDay) return time
  const weekday = d.toLocaleDateString('en-GB', { weekday: 'short' })
  return `${weekday} ${time}`
}

/** Status bar text/tone per the worktree contract. */
export function paceStatus(snapshot: PanelSnapshot): {
  id: string
  text: string
  tone: StatusTone
  tooltip: string
} {
  if (!snapshot.connected) {
    return {
      id: STATUS_ITEM,
      text: 'pacer off',
      tone: 'neutral',
      tooltip: 'pacer is not running · open the pacer app to start it',
    }
  }
  const hasFocus = !!snapshot.focusedWorkspace
  if (!hasFocus) {
    const planner = snapshot.planner
    if (!planner || typeof planner.usedPct !== 'number') {
      return { id: STATUS_ITEM, text: 'pacer', tone: 'neutral', tooltip: 'Connected' }
    }
    const verdict = planner.verdict ?? 'unknown'
    const tone: StatusTone =
      verdict === 'behind' || verdict === 'on_pace'
        ? 'success'
        : verdict === 'ahead'
          ? 'warning'
          : verdict === 'out'
            ? 'danger'
            : 'neutral'
    const pct = Math.round(planner.usedPct)
    return {
      id: STATUS_ITEM,
      text: `pacer ${pct}%`,
      tone,
      tooltip: planner.advice || verdict,
    }
  }

  const taskIds = new Set((snapshot.tasks ?? []).map((t) => t.id))
  const needsCount = snapshot.attention.filter(
    (a) => !!a.taskId && taskIds.has(a.taskId) && (a.kind === 'review' || a.kind === 'message'),
  ).length
  const running = (snapshot.tasks ?? []).filter((t) => t.state === 'running').length
  const parts: string[] = []
  if (needsCount > 0) parts.push(`${needsCount} need you`)
  if (running > 0) parts.push(`${running} running`)
  const text = parts.length ? `pacer · ${parts.join(' · ')}` : 'pacer'
  return {
    id: STATUS_ITEM,
    text,
    tone: needsCount > 0 ? 'warning' : 'neutral',
    tooltip: parts.length ? parts.join(' · ') : 'Connected',
  }
}

async function updateStatusBar(orca: OrcaWorkerApi, snapshot: PanelSnapshot): Promise<void> {
  const { id, text, tone, tooltip } = paceStatus(snapshot)
  try {
    await orca.host.call('statusBar.update', { id, text, tone, tooltip })
  } catch (error) {
    orca.log(`status bar update failed: ${String(error)}`)
  }
}

async function handleAct(op: string, params: Record<string, unknown>): Promise<ActResult> {
  if (op === 'ui.open') {
    const route = uiOpenRoute(params)
    const url = `pacer://${route}`
    const ok = await openDesktopFn(url)
    return ok ? { ok: true, result: { opened: true } } : { ok: false, error: 'Open the pacer app to see this.' }
  }
  const endpoint = readPacerEndpoint(process.env)
  if (endpoint === null) return { ok: false, error: 'pacer is not connected' }
  return callOp(endpoint, op, params)
}

/** The running activation's live loop, so `deactivate` stops exactly it. */
let activeLoop: { stop(): void } | null = null

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('pacer.snapshot', async () => currentSnapshot(orca))

  orca.panels.handle('pacer.act', async ({ op, params }): Promise<ActResult> => handleAct(op, params))

  orca.panels.handle('orca.openWorkspace', async ({ workspaceId }) => {
    try {
      await orca.host.call('workspace.open', { workspaceId })
      return { ok: true as const }
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
    }
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

  const refresh = async (): Promise<PanelSnapshot> => {
    const snapshot = await currentSnapshot(orca)
    await updateStatusBar(orca, snapshot)
    return snapshot
  }

  let latestSeq: number | null = null
  let refreshPending = false
  const onEvent = (seq: number, type: string): void => {
    if (stopped) return
    if (type !== 'reset') latestSeq = seq
    if (refreshPending) return
    refreshPending = true
    void (async () => {
      try {
        await Promise.resolve()
        const toStore = latestSeq
        refreshPending = false
        if (toStore === null || stopped) return
        await orca.storage.set(SEQ_KEY, toStore)
        const snapshot = await refresh()
        orca.panels.post('pacer.changed', { snapshot })
      } catch (error) {
        refreshPending = false
        orca.log(`pacer event refresh failed: ${String(error)}`)
      }
    })()
  }

  const connect = (initialSeq: number): void => {
    if (stopped) return
    const endpoint = readPacerEndpoint(process.env)
    if (endpoint === null) {
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

  const seedAndConnect = (): void => {
    if (stopped) return
    const endpoint = readPacerEndpoint(process.env)
    if (endpoint === null) {
      reconnect = setTimeout(() => {
        reconnect = null
        seedAndConnect()
      }, RECONNECT_MS)
      return
    }
    void (async () => {
      const snapshot = await getSnapshot(endpoint)
      if (stopped) return
      if ('error' in snapshot) {
        reconnect = setTimeout(() => {
          reconnect = null
          seedAndConnect()
        }, RECONNECT_MS)
        return
      }
      connect(snapshot.seq)
    })()
  }

  void refresh()
  seedAndConnect()
  activeLoop = { stop }
}

export function deactivate(): void {
  activeLoop?.stop()
  activeLoop = null
}
