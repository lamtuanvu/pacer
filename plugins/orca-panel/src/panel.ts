// The html panel's frame script (loaded by src/panel.html's `<script type="module">`): thin
// glue between the `orca` bridge and panel-view.ts's pure view-model. All decisions live in
// panel-view.ts; this file only calls the bridge and writes the DOM from what it returns.
// No build step: Orca transpiles this module when the frame loads, relative imports included.
import { initialPanelState, panelModel, reducePanel, type PanelEvent, type PanelState } from './panel-view'
import type { AttentionAction } from './pacer-client'

/** What the worker last reported and any pending confirm, reduced through panel-view. */
let state: PanelState = initialPanelState()

const root = document.getElementById('pacer-panel')

function dispatch(event: PanelEvent): void {
  const next = reducePanel(state, event)
  state = next.state
  if (next.run !== null) void orca.plugin.request('pacer.act', next.run).catch(() => {})
  render()
}

function render(): void {
  if (root === null) return
  root.replaceChildren(renderModel(panelModel(state, Date.now() / 1000)))
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function actionButton(button: { label: string; danger: boolean; action: AttentionAction }, className: string): HTMLButtonElement {
  const node = el('button', className, button.label) as HTMLButtonElement
  node.type = 'button'
  if (button.danger) node.classList.add('danger')
  node.addEventListener('click', () => dispatch({ type: 'press', action: button.action }))
  return node
}

function renderModel(model: ReturnType<typeof panelModel>): HTMLElement {
  switch (model.kind) {
    case 'loading':
      return el('p', 'muted', 'Loading')
    case 'load-error': {
      const callout = el('div', 'callout warn')
      callout.append(el('div', 'callout-title', 'Could not load'), el('p', 'callout-body', 'Retrying…'))
      return callout
    }
    case 'not-connected': {
      const callout = el('div', 'callout warn')
      callout.append(el('div', 'callout-title', 'Not connected'), el('p', 'callout-body', 'Start pacer serve to see what needs you here.'))
      return callout
    }
    case 'ready': {
      const panel = el('div')
      panel.append(el('h1', 'heading', model.heading))
      if (model.confirm !== null) {
        const gate = el('div', model.confirm.danger ? 'confirm danger' : 'confirm')
        const controls = el('div', 'card-actions')
        const confirm = el('button', 'btn solid', 'Confirm') as HTMLButtonElement
        confirm.type = 'button'
        if (model.confirm.danger) confirm.classList.add('danger')
        confirm.addEventListener('click', () => dispatch({ type: 'confirm' }))
        const cancel = el('button', 'btn', 'Cancel') as HTMLButtonElement
        cancel.type = 'button'
        cancel.addEventListener('click', () => dispatch({ type: 'cancel' }))
        controls.append(confirm, cancel)
        gate.append(el('div', 'callout-title', model.confirm.title), el('p', 'callout-body', model.confirm.body), controls)
        panel.append(gate)
      }
      if (model.rows.length === 0) {
        panel.append(el('p', 'empty', model.empty))
      } else {
        for (const row of model.rows) {
          const card = el('div', 'card')
          card.dataset.id = row.id
          if (row.repoLabel !== undefined) card.append(el('span', 'card-repo', row.repoLabel))
          card.append(el('div', 'card-title', row.title))
          const meta = el('div', 'card-meta')
          meta.append(el('span', undefined, row.detail), el('span', undefined, '·'), el('span', 'card-time', row.time))
          const actions = el('div', 'card-actions')
          for (const button of row.actions) actions.append(actionButton(button, 'btn'))
          card.append(meta, actions)
          panel.append(card)
        }
      }
      return panel
    }
  }
}

// The worker's snapshot, then a live re-render per pacer.changed push. A rejected request
// (the worker is restarting, or crashed) must never leave the panel blank forever: show
// load-error and keep retrying on a short interval until one succeeds.
function loadSnapshot(): void {
  orca.plugin
    .request('pacer.snapshot')
    .then((answer) => dispatch({ type: 'snapshot', snapshot: answer }))
    .catch(() => {
      dispatch({ type: 'load-error' })
      setTimeout(loadSnapshot, 3_000)
    })
}
loadSnapshot()
orca.plugin.on('pacer.changed', (payload) => dispatch({ type: 'snapshot', snapshot: payload.snapshot }))

// Relative times go stale without a new event. Rebuilding the whole tree every 5s would drop
// focus/hover off whatever a keyboard or mouse user is on, so this only rewrites each existing
// card's `.card-time` text node in place - nothing else in the DOM is touched.
function tickTime(): void {
  if (root === null) return
  const model = panelModel(state, Date.now() / 1000)
  if (model.kind !== 'ready') return
  for (const row of model.rows) {
    const time = root.querySelector(`.card[data-id="${CSS.escape(row.id)}"] .card-time`)
    if (time !== null && time.textContent !== row.time) time.textContent = row.time
  }
}
setInterval(tickTime, 5_000)
