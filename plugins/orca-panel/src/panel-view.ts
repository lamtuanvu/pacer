// Pure view-model for the html panel: data in, data out, no DOM and no `orca` import, so it
// unit-tests under plain `bun test` / `orca plugin test` (node:test) exactly like
// pacer-client.ts. The frame script (src/panel.ts) renders what these functions return.
import type { AttentionAction, AttentionItem } from './pacer-client'
import type { PanelSnapshot } from './protocol'

/** The op the panel should fire with `pacer.act`. */
export type RunRequest = { op: string; params: Record<string, unknown> }

/** One attention action as a row button. */
export type ActionButton = { label: string; danger: boolean; action: AttentionAction }

/** One attention item as a row. */
export type RowView = {
  id: string
  title: string
  detail: string
  /** Live-updated relative text ('4m ago'); the frame re-renders on a short interval. */
  time: string
  actions: ActionButton[]
}

/** The in-panel Confirm/Cancel gate. */
export type ConfirmView = { title: string; body: string; danger: boolean }

/** What the frame renders, one shape per visual state. */
export type PanelModel =
  | { kind: 'loading' }
  | { kind: 'load-error' }
  | { kind: 'not-connected' }
  | { kind: 'ready'; heading: string; empty: string; rows: RowView[]; confirm: ConfirmView | null }

/** Everything the panel remembers between renders: the snapshot, a pending confirm, and
 *  whether the initial (or a retried) load request itself failed outright - distinct from
 *  `connected: false`, which is a normal, successfully-answered "pacer isn't running" reply. */
export type PanelState = { snapshot: PanelSnapshot | null; pending: AttentionAction | null; loadError: boolean }

export const initialPanelState = (): PanelState => ({ snapshot: null, pending: null, loadError: false })

export type PanelEvent =
  | { type: 'snapshot'; snapshot: PanelSnapshot }
  | { type: 'load-error' }
  | { type: 'press'; action: AttentionAction }
  | { type: 'confirm' }
  | { type: 'cancel' }

/** The state transitions: a snapshot replaces data, clears any pending confirm and any load
 *  error; a load error only matters while there is no data yet (a later successful push
 *  already clears it via 'snapshot'); press starts a confirm or fires straight away; confirm
 *  fires the pending action; cancel clears. Returns the next state plus the op to fire (null
 *  when nothing should run). */
export function reducePanel(state: PanelState, event: PanelEvent): { state: PanelState; run: RunRequest | null } {
  switch (event.type) {
    case 'snapshot':
      return { state: { snapshot: event.snapshot, pending: null, loadError: false }, run: null }
    case 'load-error':
      return { state: { ...state, loadError: true }, run: null }
    case 'press':
      if (event.action.confirm) return { state: { ...state, pending: event.action }, run: null }
      return { state, run: { op: event.action.op, params: event.action.params } }
    case 'confirm': {
      if (state.pending === null) return { state, run: null }
      const action = state.pending
      return { state: { ...state, pending: null }, run: { op: action.op, params: action.params } }
    }
    case 'cancel':
      return { state: { ...state, pending: null }, run: null }
  }
}

/** Short plain relative text ('now', '4m ago', '3h ago', '5d ago', '2w ago') from `since`
 *  (unix seconds); `now` is injected so tests are deterministic. Future values clamp to 'now'. */
export function relativeTime(since: number, now: number): string {
  const seconds = Math.max(0, Math.floor(now - since))
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 14) return `${days}d ago`
  return `${Math.floor(days / 7)}w ago`
}

/** The heading: the focused repo's label, or the global view. */
export function scopeHeading(snapshot: PanelSnapshot): string {
  return snapshot.scope === 'repo' ? (snapshot.repoLabel ?? 'Repo') : 'All repos'
}

/** The empty-state message, scoped like the heading. */
export function emptyMessage(snapshot: PanelSnapshot): string {
  return snapshot.scope === 'repo' ? 'Nothing needs you' : 'Nothing needs you across any repo'
}

/** One attention item as a row view-model. */
export function rowFor(item: AttentionItem, now: number): RowView {
  return {
    id: item.id,
    title: item.title,
    detail: item.detail,
    time: relativeTime(item.since, now),
    actions: item.actions.map((action) => ({
      label: action.label,
      danger: action.style === 'danger',
      action,
    })),
  }
}

/** The whole panel view-model from the current state and clock. */
export function panelModel(state: PanelState, now: number): PanelModel {
  if (state.snapshot === null) return state.loadError ? { kind: 'load-error' } : { kind: 'loading' }
  const snapshot = state.snapshot
  if (!snapshot.connected) return { kind: 'not-connected' }
  const pending = state.pending
  return {
    kind: 'ready',
    heading: scopeHeading(snapshot),
    empty: emptyMessage(snapshot),
    rows: snapshot.attention.map((item) => rowFor(item, now)),
    confirm: pending?.confirm ? { title: pending.confirm.title, body: pending.confirm.body, danger: pending.style === 'danger' } : null,
  }
}
