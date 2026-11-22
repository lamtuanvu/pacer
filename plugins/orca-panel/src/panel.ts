// Thin DOM glue: all decisions live in panel-view.ts.
import {
  absoluteTime,
  actionButtonLabel,
  actionNeedsConfirm,
  attentionCardTone,
  attentionGlyph,
  buildDelegateParams,
  confirmTextFor,
  DELEGATE_KINDS,
  doneGlyph,
  executorLabelFor,
  executorMonogram,
  executorStateWords,
  initialPanelState,
  meterTone,
  modePillLabel,
  panelModel,
  phaseWords,
  plannerHeadline,
  reducePanel,
  reviewExpectRev,
  type ConfirmSpec,
  type PanelEvent,
  type PanelState,
  type RunRequest,
} from './panel-view'
import type { AttentionAction } from './pacer-client'
import type { AttentionRow, PanelSnapshot, PanelTask } from './protocol'

let state: PanelState = initialPanelState()
const root = document.getElementById('pacer-panel')
let menuButton: HTMLButtonElement | null = null

function dispatch(event: PanelEvent): void {
  const next = reducePanel(state, event)
  state = next.state
  render()
}

async function runRequest(run: RunRequest, successText?: string): Promise<void> {
  dispatch({ type: 'begin', pendingKey: run.pendingKey })
  try {
    if (run.kind === 'openWorkspace') {
      const answer = await orca.plugin.request('orca.openWorkspace', { workspaceId: run.workspaceId })
      dispatch({
        type: 'act-result',
        pendingKey: run.pendingKey,
        ok: answer.ok,
        error: answer.ok ? undefined : answer.error,
        successText: answer.ok ? 'Opened' : undefined,
      })
      return
    }
    const answer = await orca.plugin.request('pacer.act', { op: run.op, params: run.params })
    dispatch({
      type: 'act-result',
      pendingKey: run.pendingKey,
      ok: answer.ok,
      error: answer.ok ? undefined : answer.error,
      conflict: answer.ok ? undefined : answer.conflict,
      result: answer.ok ? answer.result : undefined,
      successText: answer.ok ? successText : undefined,
    })
  } catch (error) {
    dispatch({
      type: 'act-result',
      pendingKey: run.pendingKey,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function pill(text: string, tone: string = 'neutral'): HTMLElement {
  const toneClass =
    tone === 'good' || tone === 'warn' || tone === 'bad' || tone === 'info' ? ` pc-pill--${tone}` : ''
  return el('span', `pc-pill${toneClass}`, text)
}

function markSvg(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '18')
  svg.setAttribute('height', '18')
  svg.setAttribute('viewBox', '0 0 48 48')
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('pc-mark')
  const lane = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  lane.setAttribute('x', '4'); lane.setAttribute('y', '20'); lane.setAttribute('width', '40'); lane.setAttribute('height', '8')
  lane.setAttribute('rx', '4'); lane.setAttribute('fill', 'var(--line)')
  const used = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  used.setAttribute('x', '4'); used.setAttribute('y', '20'); used.setAttribute('width', '22'); used.setAttribute('height', '8')
  used.setAttribute('rx', '4'); used.setAttribute('fill', 'var(--ink)')
  const tick = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  tick.setAttribute('x', '29'); tick.setAttribute('y', '12'); tick.setAttribute('width', '4'); tick.setAttribute('height', '24')
  tick.setAttribute('rx', '2'); tick.setAttribute('fill', 'var(--track)')
  svg.append(lane, used, tick)
  return svg
}

function button(label: string, opts: {
  variant?: 'primary' | 'ghost' | 'secondary'
  size?: 'sm' | 'md'
  disabled?: boolean
  ariaLabel?: string
  className?: string
  onClick: () => void
}): HTMLButtonElement {
  const classes = ['pc-btn']
  if (opts.size === 'sm') classes.push('pc-btn--sm')
  if (opts.size === 'md' || opts.variant === 'primary') classes.push('pc-btn--md')
  if (opts.size === 'sm') { /* keep sm */ }
  if (opts.variant === 'primary') classes.push('pc-btn--primary')
  if (opts.variant === 'ghost') classes.push('pc-btn--ghost')
  if (opts.className) classes.push(opts.className)
  const node = el('button', classes.join(' '), label)
  node.type = 'button'
  if (opts.disabled) node.disabled = true
  if (opts.ariaLabel) node.setAttribute('aria-label', opts.ariaLabel)
  node.addEventListener('click', opts.onClick)
  return node
}

function statusLine(key: string): HTMLElement | null {
  const status = state.ui.statusByKey[key]
  if (!status) return null
  return el('p', `pc-status pc-status--${status.tone}`, status.text)
}

function renderConfirm(confirm: ConfirmSpec): HTMLElement {
  const box = el('div', 'pc-confirm')
  box.append(el('p', undefined, confirm.text))
  const actions = el('div', 'pc-confirm-actions')
  actions.append(
    button(confirm.confirmLabel, {
      size: 'sm',
      onClick: () => void runRequest(confirm.run, confirm.confirmLabel === 'Reject it' ? 'Rejected' : confirm.confirmLabel === 'Stop it' ? 'Stopped' : 'Done'),
    }),
    button(confirm.cancelLabel, {
      size: 'sm',
      variant: 'ghost',
      onClick: () => dispatch({ type: 'cancel-confirm' }),
    }),
  )
  box.append(actions)
  return box
}

function askOrRun(action: AttentionAction, pendingKey: string, successText: string, extraParams?: Record<string, unknown>): void {
  const params = { ...action.params, ...extraParams }
  const run: RunRequest = { kind: 'act', op: action.op, params, pendingKey }
  if (actionNeedsConfirm(action)) {
    dispatch({
      type: 'ask-confirm',
      confirm: {
        key: pendingKey,
        text: confirmTextFor(action),
        confirmLabel: action.label,
        cancelLabel: 'Cancel',
        run,
      },
    })
    return
  }
  void runRequest(run, successText)
}

function renderAttentionCard(item: AttentionRow, model: Extract<ReturnType<typeof panelModel>, { kind: 'ready' }>, now: number): HTMLElement {
  const tone = attentionCardTone(item.kind)
  const card = el('div', `pc-card${tone === 'default' ? '' : ` pc-card--${tone}`}`)
  card.dataset.id = item.id
  if (model.scope === 'global') {
    card.append(el('div', 'pc-repo-label', item.repoLabel ?? 'All repos'))
  }
  const head = el('div')
  head.style.display = 'flex'
  head.style.alignItems = 'flex-start'
  head.style.gap = '10px'
  const mono = executorMonogram(item.executor)
  if (mono) head.append(el('span', 'pc-mono-tile', mono))
  const glyph = attentionGlyph(item.kind)
  const titleWrap = el('div')
  titleWrap.style.minWidth = '0'
  titleWrap.style.flex = '1'
  const title = el('div', 'pc-row-title', `${glyph ? `${glyph} ` : ''}${item.title}`)
  const when = absoluteTime(item.since, now)
  const exec = executorLabelFor(item.executor, model.names)
  titleWrap.append(title, el('div', 'pc-caption', [exec, when, item.detail].filter(Boolean).join(' · ')))
  head.append(titleWrap)
  if (item.kind === 'review') head.append(pill('Review', 'info'))
  card.append(head)

  const confirm = state.ui.confirm
  if (confirm && confirm.key.startsWith(`att:${item.id}`)) {
    card.append(renderConfirm(confirm))
    return card
  }

  const busy = Object.keys(state.ui.pending).some((k) => k.startsWith(`att:${item.id}`))
  const actions = el('div', 'pc-actions')

  if (item.kind === 'question') {
    const answerId = `answer-${item.id}`
    const label = el('label', 'sr-only', 'Your answer')
    label.htmlFor = answerId
    const area = el('textarea')
    area.id = answerId
    area.rows = 2
    area.placeholder = 'Your answer'
    area.value = state.ui.answers[item.id] ?? ''
    area.addEventListener('input', () => dispatch({ type: 'set-answer', id: item.id, text: area.value }))
    card.append(label, area)
  }

  if (item.kind === 'review') {
    const taskId = item.taskId
    const expect = reviewExpectRev(model.snapshot, taskId)
    actions.append(
      button('Accept', {
        size: 'sm',
        disabled: busy || !taskId,
        onClick: () =>
          void runRequest(
            {
              kind: 'act',
              op: 'task.review',
              params: { id: taskId, verdict: 'accept', ...(expect ? { expect_rev: expect } : {}) },
              pendingKey: `att:${item.id}:accept`,
            },
            'Accepted',
          ),
      }),
      button('Reject', {
        size: 'sm',
        disabled: busy || !taskId,
        onClick: () => {
          const execName = executorLabelFor(item.executor, model.names)
          dispatch({
            type: 'ask-confirm',
            confirm: {
              key: `att:${item.id}:reject`,
              text: `Reject this result? ${execName} is told it was rejected.`,
              confirmLabel: 'Reject it',
              cancelLabel: 'Keep it',
              run: {
                kind: 'act',
                op: 'task.review',
                params: { id: taskId, verdict: 'reject', ...(expect ? { expect_rev: expect } : {}) },
                pendingKey: `att:${item.id}:reject`,
              },
            },
          })
        },
      }),
    )
  }

  for (const action of item.actions) {
    const isAnswer = action.op === 'task.answer' || action.op === 'dispatch.answer' || action.label === 'Answer'
    const isReviewOpen = item.kind === 'review' && action.op === 'ui.open'
    const label = actionButtonLabel(action, item.kind)
    const pendingKey = `att:${item.id}:${action.op}`
    if (item.kind === 'question' && isAnswer) {
      const text = (state.ui.answers[item.id] ?? '').trim()
      actions.append(
        button(label, {
          size: 'sm',
          disabled: busy || !text,
          onClick: () => askOrRun(action, pendingKey, 'Answer sent', { text }),
        }),
      )
      continue
    }
    actions.append(
      button(label, {
        size: 'sm',
        variant: isReviewOpen ? 'ghost' : 'secondary',
        disabled: busy,
        onClick: () => askOrRun(action, pendingKey, label),
      }),
    )
  }
  card.append(actions)
  const status = statusLine(`att:${item.id}:accept`) || statusLine(`att:${item.id}:reject`) ||
    item.actions.map((a) => statusLine(`att:${item.id}:${a.op}`)).find(Boolean)
  if (status) {
    status.setAttribute('role', 'status')
    status.setAttribute('aria-live', 'polite')
    card.append(status)
  }
  return card
}

function renderRunningRow(task: PanelTask, model: Extract<ReturnType<typeof panelModel>, { kind: 'ready' }>, now: number): HTMLElement {
  const row = el('div', 'pc-list-row')
  row.dataset.id = task.id
  const mono = executorMonogram(task.executor)
  if (mono) row.append(el('span', 'pc-mono-tile', mono))
  const mid = el('div')
  mid.style.minWidth = '0'
  mid.style.flex = '1'
  mid.append(el('div', 'pc-row-title ellipsis', task.title))
  const started = absoluteTime(task.attemptStartedAt ?? task.updatedAt, now)
  const parts = [
    model.scope === 'global' ? task.repoLabel : null,
    executorLabelFor(task.executor, model.names),
    phaseWords(task.phase),
    `started ${started}`,
  ].filter(Boolean)
  mid.append(el('div', 'pc-caption', parts.join(' · ')))
  row.append(mid)
  if (task.liveness?.stalled) {
    const mins = Math.max(1, Math.floor((now - task.liveness.since) / 60))
    row.append(pill(`No progress for ${mins} min`, 'warn'))
  }
  const actions = el('div', 'pc-actions')
  const busy = !!state.ui.pending[`run:${task.id}`] || !!state.ui.pending[`run:${task.id}:stop`]
  const confirm = state.ui.confirm
  if (confirm?.key === `run:${task.id}:stop`) {
    row.append(renderConfirm(confirm))
    return row
  }
  if (task.orcaWorkspaceId) {
    actions.append(
      button('Open worktree', {
        size: 'sm',
        variant: 'ghost',
        disabled: busy,
        onClick: () =>
          void runRequest({
            kind: 'openWorkspace',
            workspaceId: task.orcaWorkspaceId!,
            pendingKey: `run:${task.id}:open`,
          }),
      }),
    )
  }
  actions.append(
    button('Watch', {
      size: 'sm',
      variant: 'ghost',
      disabled: busy,
      onClick: () =>
        void runRequest(
          { kind: 'act', op: 'task.attach', params: { id: task.id, target: 'orca' }, pendingKey: `run:${task.id}:watch` },
          'Watching',
        ),
    }),
    button('Stop', {
      size: 'sm',
      variant: 'ghost',
      disabled: busy,
      onClick: () =>
        dispatch({
          type: 'ask-confirm',
          confirm: {
            key: `run:${task.id}:stop`,
            text: 'Stop this task?',
            confirmLabel: 'Stop it',
            cancelLabel: 'Keep it',
            run: {
              kind: 'act',
              op: 'task.stop',
              params: { id: task.id, expect_rev: task.rev },
              pendingKey: `run:${task.id}:stop`,
            },
          },
        }),
    }),
  )
  row.append(actions)
  return row
}

function renderMenu(snapshot: PanelSnapshot): HTMLElement {
  const menu = el('div', 'pc-menu')
  menu.setAttribute('role', 'menu')
  const item = (label: string, onClick: () => void) => {
    const b = el('button', undefined, label)
    b.type = 'button'
    b.setAttribute('role', 'menuitem')
    b.addEventListener('click', () => {
      dispatch({ type: 'toggle-menu', open: false })
      onClick()
    })
    menu.append(b)
  }
  if (snapshot.pause) {
    item('Resume delegation', () =>
      void runRequest({ kind: 'act', op: 'delegation.resume', params: {}, pendingKey: 'menu:resume' }, 'Resumed'),
    )
  } else {
    item('Pause for 1 hour', () =>
      void runRequest({ kind: 'act', op: 'delegation.pause', params: { for: '1h' }, pendingKey: 'menu:pause1h' }, 'Paused'),
    )
    item('Pause for 4 hours', () =>
      void runRequest({ kind: 'act', op: 'delegation.pause', params: { for: '4h' }, pendingKey: 'menu:pause4h' }, 'Paused'),
    )
    item('Pause until tomorrow', () =>
      void runRequest({ kind: 'act', op: 'delegation.pause', params: { for: '1d' }, pendingKey: 'menu:pause1d' }, 'Paused'),
    )
  }
  if (snapshot.planner?.modeHeldUntil) {
    item('Release the held mode', () =>
      void runRequest({ kind: 'act', op: 'mode.release', params: {}, pendingKey: 'menu:mode-release' }, 'Released'),
    )
  } else {
    item('Hold strict mode', () =>
      void runRequest({ kind: 'act', op: 'mode.hold', params: { mode: 'strict' }, pendingKey: 'menu:mode-hold' }, 'Held'),
    )
  }
  item('Open the pacer app', () =>
    void runRequest({ kind: 'act', op: 'ui.open', params: { view: 'overview' }, pendingKey: 'menu:open' }),
  )
  return menu
}

function renderDelegate(model: Extract<ReturnType<typeof panelModel>, { kind: 'ready' }>): HTMLElement {
  const section = el('section', 'pc-section')
  section.setAttribute('aria-label', 'Delegate')
  if (model.ui.view === 'delegate-done' && model.ui.delegated) {
    section.append(el('h2', 'pc-label', 'Delegate'))
    const card = el('div', 'pc-card')
    card.append(el('p', 'pc-status pc-status--good', `Running on ${model.ui.delegated.executorLabel}`))
    card.append(el('code', 'pc-selectable', model.ui.delegated.taskId))
    const actions = el('div', 'pc-actions')
    actions.append(
      button('Watch', {
        size: 'sm',
        onClick: () =>
          void runRequest(
            {
              kind: 'act',
              op: 'task.attach',
              params: { id: model.ui.delegated!.taskId, target: 'orca' },
              pendingKey: 'delegate:watch',
            },
            'Watching',
          ),
      }),
    )
    if (model.ui.delegated.orcaWorkspaceId) {
      actions.append(
        button('Open worktree', {
          size: 'sm',
          onClick: () =>
            void runRequest({
              kind: 'openWorkspace',
              workspaceId: model.ui.delegated!.orcaWorkspaceId!,
              pendingKey: 'delegate:open',
            }),
        }),
      )
    }
    actions.append(button('Back to the panel', { size: 'sm', variant: 'ghost', onClick: () => dispatch({ type: 'set-view', view: 'main' }) }))
    card.append(actions)
    section.append(card)
    return section
  }

  if (model.ui.view === 'delegate') {
    section.append(
      button('Back', { size: 'sm', variant: 'ghost', onClick: () => dispatch({ type: 'set-view', view: 'main' }) }),
      el('label', 'pc-label', 'Goal'),
    )
    const goal = el('textarea')
    goal.value = model.ui.goal
    goal.placeholder = `What should an executor do in ${model.snapshot.focusedRepo?.label ?? 'this repo'}?`
    goal.addEventListener('input', () => dispatch({ type: 'set-goal', goal: goal.value }))
    section.append(goal)
    section.append(el('div', 'pc-label', 'Kind'))
    const chips = el('div', 'pc-chips')
    for (const kind of DELEGATE_KINDS) {
      const chip = el('button', 'pc-chip', kind.label)
      chip.type = 'button'
      chip.setAttribute('aria-pressed', model.ui.delegateKind === kind.id ? 'true' : 'false')
      chip.addEventListener('click', () => dispatch({ type: 'set-delegate-kind', kind: kind.id }))
      chips.append(chip)
    }
    section.append(chips)
    section.append(el('label', 'pc-label', 'Executor'))
    const select = el('select')
    const next = model.next
    const nextLabel = next ? executorLabelFor(next.id, model.names) : 'Automatic'
    const auto = el('option', undefined, `Auto · ${nextLabel} runs next`)
    auto.value = 'auto'
    select.append(auto)
    for (const row of model.snapshot.executors) {
      const opt = el('option', undefined, executorLabelFor(row.id, model.names))
      opt.value = row.id
      if (!row.enabled || row.state === 'disabled' || row.state === 'down' || row.state === 'exhausted') {
        opt.disabled = true
        opt.textContent = `${executorLabelFor(row.id, model.names)} · ${executorStateWords(row).label}`
      }
      select.append(opt)
    }
    select.value = model.ui.delegateExecutor
    select.addEventListener('change', () => dispatch({ type: 'set-delegate-executor', executor: select.value }))
    section.append(select)
    section.append(el('div', 'pc-label', 'Where it works'))
    const where = el('div', 'pc-chips')
    for (const [id, label] of [['new', 'New worktree'], ['current', 'This worktree']] as const) {
      const chip = el('button', 'pc-chip', label)
      chip.type = 'button'
      chip.setAttribute('aria-pressed', model.ui.delegateWorktree === id ? 'true' : 'false')
      chip.addEventListener('click', () => dispatch({ type: 'set-delegate-worktree', worktree: id }))
      where.append(chip)
    }
    section.append(where)
    const accLabel = el('label', 'pc-label', 'Done when this passes')
    const acc = el('input', 'pc-mono') as HTMLInputElement
    acc.type = 'text'
    acc.value = model.ui.acceptance
    acc.placeholder = 'optional command'
    acc.addEventListener('input', () => dispatch({ type: 'set-acceptance', acceptance: acc.value }))
    section.append(accLabel, acc)
    const targetName =
      model.ui.delegateExecutor === 'auto'
        ? nextLabel
        : executorLabelFor(model.ui.delegateExecutor, model.names)
    const submit = button(`Delegate to ${targetName}`, {
      variant: 'primary',
      size: 'md',
      disabled: !model.ui.goal.trim() || !model.snapshot.focusedRepo || !!model.ui.pending['delegate'],
      onClick: () => {
        if (!model.snapshot.focusedRepo) return
        const params = buildDelegateParams({
          goal: model.ui.goal,
          repoPath: model.snapshot.focusedRepo.path,
          kind: model.ui.delegateKind,
          executor: model.ui.delegateExecutor,
          worktree: model.ui.delegateWorktree,
          acceptance: model.ui.acceptance,
          requestId: `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        })
        void runRequest(
          { kind: 'act', op: 'task.delegate', params, pendingKey: 'delegate' },
          `Running on ${targetName}`,
        )
      },
    })
    section.append(submit)
    if (model.ui.delegateError) section.append(el('p', 'pc-status pc-status--bad', model.ui.delegateError))
    return section
  }

  // Compact delegate on main
  const label = el('label', 'pc-label', 'Delegate from this worktree')
  label.htmlFor = 'goal'
  const goal = el('textarea')
  goal.id = 'goal'
  goal.rows = 3
  goal.placeholder = `What should an executor do in ${model.snapshot.focusedRepo?.label ?? 'this repo'}?`
  goal.value = model.ui.goal
  goal.addEventListener('input', () => dispatch({ type: 'set-goal', goal: goal.value }))
  const row = el('div')
  row.style.display = 'flex'
  row.style.alignItems = 'center'
  row.style.gap = '8px'
  const nextName = model.next ? executorLabelFor(model.next.id, model.names) : 'an executor'
  const caption = el('span', 'pc-caption', `Runs on ${nextName} · new worktree · `)
  const options = el('a', undefined, 'Options')
  options.href = '#'
  options.addEventListener('click', (e) => {
    e.preventDefault()
    dispatch({ type: 'set-view', view: 'delegate' })
  })
  caption.append(options)
  const delegate = button('Delegate', {
    variant: 'primary',
    size: 'md',
    disabled: !model.ui.goal.trim() || !model.snapshot.focusedRepo || !!model.ui.pending['delegate'],
    onClick: () => {
      if (!model.snapshot.focusedRepo) return
      const params = buildDelegateParams({
        goal: model.ui.goal,
        repoPath: model.snapshot.focusedRepo.path,
        kind: 'auto',
        executor: 'auto',
        worktree: 'new',
        acceptance: '',
        requestId: `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      })
      void runRequest(
        { kind: 'act', op: 'task.delegate', params, pendingKey: 'delegate' },
        `Running on ${nextName}`,
      )
    },
  })
  row.append(caption, delegate)
  section.append(label, goal, row)
  if (model.ui.delegateError) section.append(el('p', 'pc-status pc-status--bad', model.ui.delegateError))
  return section
}

function renderReady(model: Extract<ReturnType<typeof panelModel>, { kind: 'ready' }>, now: number): HTMLElement {
  const shell = el('div', 'pc-shell')
  const snapshot = model.snapshot

  if (model.ui.view === 'delegate' || model.ui.view === 'delegate-done') {
    const main = el('main', 'pc-main')
    main.append(renderDelegate(model))
    shell.append(main)
    return shell
  }

  const header = el('header', 'pc-header')
  header.append(markSvg(), el('span', 'pc-wordmark', 'pacer'))
  const mode = modePillLabel(snapshot)
  header.append(pill(mode.text, mode.tone))
  header.append(el('span', 'pc-header-spacer'))
  const live = el('span', 'pc-live')
  live.append(el('span', 'pc-live-dot'), document.createTextNode('Live'))
  header.append(live)
  menuButton = button('', {
    variant: 'ghost',
    size: 'sm',
    className: 'pc-btn--icon',
    ariaLabel: 'More actions',
    onClick: () => dispatch({ type: 'toggle-menu' }),
  })
  menuButton.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="5" cy="12" r="1"></circle><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle></svg>'
  header.append(menuButton)
  if (model.ui.menuOpen) header.append(renderMenu(snapshot))
  shell.append(header)

  const main = el('main', 'pc-main')

  // Planner
  const plannerCard = el('div', 'pc-card pc-card--sunken')
  const planner = snapshot.planner
  const resetLabel = planner?.resetsAt ? absoluteTime(planner.resetsAt, now) : ''
  const headRow = el('div')
  headRow.style.display = 'flex'
  headRow.style.alignItems = 'baseline'
  headRow.style.justifyContent = 'space-between'
  headRow.style.gap = '12px'
  headRow.append(el('h1', 'pc-headline', plannerHeadline(planner, resetLabel)))
  if (planner && typeof planner.usedPct === 'number') {
    headRow.append(el('span', 'pc-number', `${Math.round(planner.usedPct)}%`))
  }
  plannerCard.append(headRow)
  if (planner && typeof planner.usedPct === 'number') {
    const tone = meterTone(planner.verdict, planner.stale)
    const meter = el('div', 'pc-meter')
    meter.setAttribute('role', 'progressbar')
    meter.setAttribute('aria-valuenow', String(Math.round(planner.usedPct)))
    meter.setAttribute(
      'aria-label',
      `${planner.agent} weekly usage ${Math.round(planner.usedPct)} percent, pace ${Math.round(planner.pacePct ?? 0)} percent`,
    )
    const fill = el('div', `pc-meter-fill pc-meter-fill--${tone}`)
    fill.style.width = `${Math.min(100, Math.max(0, planner.usedPct))}%`
    meter.append(fill)
    if (typeof planner.pacePct === 'number') {
      const tick = el('div', 'pc-meter-tick')
      tick.style.left = `calc(${Math.min(100, Math.max(0, planner.pacePct))}% - 1px)`
      meter.append(tick)
    }
    plannerCard.append(meter)
    const windowWord = planner.window ? `${planner.window}` : 'week'
    const caption = planner.stale
      ? `${planner.agent} · stale`
      : `${planner.agent} · ${Math.round(planner.usedPct)}% of ${windowWord} used · pace ${Math.round(planner.pacePct ?? 0)}% · resets ${resetLabel || '—'}`
    plannerCard.append(el('p', 'pc-caption', caption))
    if (planner.advice) {
      const advice = el('p', undefined, planner.advice)
      advice.style.margin = '0'
      advice.style.color = 'var(--ink-secondary)'
      plannerCard.append(advice)
    }
  } else {
    plannerCard.append(el('p', 'pc-caption', 'Usage unknown.'))
  }
  main.append(plannerCard)

  // Scope
  if (snapshot.focusedRepo) {
    const nav = el('nav', 'pc-scope')
    nav.setAttribute('aria-label', 'Scope')
    const repoBtn = el('button', undefined, `This repo · ${snapshot.focusedRepo.label}`)
    repoBtn.type = 'button'
    if (model.scope === 'repo') repoBtn.setAttribute('aria-current', 'page')
    repoBtn.addEventListener('click', () => dispatch({ type: 'set-scope', scope: 'repo' }))
    const allBtn = el('button')
    allBtn.type = 'button'
    allBtn.append(document.createTextNode('All repos'))
    if (model.globalNeedsYou > 0) allBtn.append(el('span', 'pc-badge', String(model.globalNeedsYou)))
    if (model.scope === 'global') allBtn.setAttribute('aria-current', 'page')
    allBtn.addEventListener('click', () => dispatch({ type: 'set-scope', scope: 'global' }))
    nav.append(repoBtn, allBtn)
    main.append(nav)
  } else {
    main.append(el('p', 'pc-caption', "This workspace isn't a repo pacer knows."))
  }

  // Pause banner
  if (snapshot.pause) {
    const until = snapshot.pause.until ? absoluteTime(snapshot.pause.until, now) : 'later'
    const card = el('div', 'pc-card pc-card--warn')
    card.append(el('div', 'pc-headline', `Delegation is paused until ${until}`))
    card.append(el('p', 'pc-caption', 'New tasks wait in the queue; running ones finish.'))
    card.append(
      button('Resume now', {
        size: 'sm',
        onClick: () =>
          void runRequest({ kind: 'act', op: 'delegation.resume', params: {}, pendingKey: 'pause:resume' }, 'Resumed'),
      }),
    )
    main.append(card)
  }

  if (model.scope === 'repo' && snapshot.focusedRepo) {
    main.append(renderDelegate(model))
  }

  if (model.scope === 'global') {
    const byRepo = el('section', 'pc-section')
    byRepo.setAttribute('aria-label', 'By repo')
    byRepo.append(el('h2', 'pc-label', 'By repo'))
    const list = el('div', 'pc-list')
    for (const repo of snapshot.repos) {
      const row = el('div', 'pc-list-row')
      const mid = el('div')
      mid.style.flex = '1'
      mid.style.minWidth = '0'
      const title = el('div', 'pc-row-title ellipsis', repo.label)
      if (snapshot.focusedRepo?.key === repo.key) {
        title.textContent = `${repo.label} · this worktree`
      }
      mid.append(title)
      mid.append(
        el(
          'div',
          'pc-caption',
          repo.running > 0 || repo.doneToday > 0
            ? `${repo.running} running · ${repo.doneToday} done today`
            : 'Nothing running',
        ),
      )
      row.append(mid)
      if (repo.needsYou > 0) row.append(pill(String(repo.needsYou), 'bad'))
      if (repo.orcaWorkspaceId) {
        row.append(
          button('Open in Orca', {
            size: 'sm',
            variant: 'ghost',
            onClick: () =>
              void runRequest({
                kind: 'openWorkspace',
                workspaceId: repo.orcaWorkspaceId!,
                pendingKey: `repo:${repo.key}:open`,
              }),
          }),
        )
      }
      list.append(row)
    }
    byRepo.append(list)
    main.append(byRepo)
  }

  // Needs you
  const needs = el('section', 'pc-section')
  needs.setAttribute('aria-label', 'Needs you')
  const needsHead = el('div', 'pc-section-head')
  needsHead.append(el('h2', 'pc-label', 'Needs you'))
  if (model.attention.length > 0) needsHead.append(pill(String(model.attention.length), 'bad'))
  needs.append(needsHead)
  if (model.attention.length === 0) {
    const empty = el('div', 'pc-empty', `Nothing needs you in ${model.scope === 'repo' ? snapshot.focusedRepo?.label ?? 'this repo' : 'any repo'}.`)
    needs.append(empty)
    if (model.scope === 'repo' && model.otherNeedsYou > 0) {
      const link = el('a', undefined, `${model.otherNeedsYou} in other repos`)
      link.href = '#'
      link.addEventListener('click', (e) => {
        e.preventDefault()
        dispatch({ type: 'set-scope', scope: 'global' })
      })
      needs.append(link)
    }
  } else {
    for (const item of model.attention) needs.append(renderAttentionCard(item, model, now))
  }
  main.append(needs)

  // Running
  const running = el('section', 'pc-section')
  running.setAttribute('aria-label', 'Running')
  const runHead = el('div', 'pc-section-head')
  runHead.append(el('h2', 'pc-label', 'Running'), pill(String(model.running.length)))
  running.append(runHead)
  if (model.running.length === 0) {
    const nextName = model.next ? executorLabelFor(model.next.id, model.names) : 'An executor'
    running.append(el('div', 'pc-empty', `Nothing running here. ${nextName} runs next.`))
  } else {
    const list = el('div', 'pc-list')
    for (const task of model.running) list.append(renderRunningRow(task, model, now))
    running.append(list)
  }
  main.append(running)

  // Who runs next
  const who = el('section', 'pc-section')
  who.setAttribute('aria-label', 'Who runs next')
  const ready = snapshot.executors.filter((e) => e.enabled && (e.state === 'ready' || e.untested)).length
  const out = snapshot.executors.filter((e) => e.state === 'exhausted' || e.state === 'down' || e.state === 'disabled').length
  const whoHead = el('div', 'pc-section-head')
  whoHead.append(el('h2', 'pc-label', 'Who runs next'), el('span', 'pc-caption', `${ready} ready · ${out} out`))
  who.append(whoHead)
  const whoList = el('div', 'pc-list')
  for (const row of snapshot.executors) {
    const item = el('div', 'pc-list-row')
    const rank = el('span', `pc-rank${row.next ? ' pc-rank--next' : ''}`, row.next || row.state === 'ready' ? String(row.rank) : '–')
    item.append(rank)
    const mid = el('div')
    mid.style.flex = '1'
    mid.append(el('div', 'pc-row-title ellipsis', executorLabelFor(row.id, model.names)))
    mid.append(el('div', 'pc-caption', `${row.next ? 'Next · ' : ''}${row.sub}`))
    item.append(mid)
    const words = executorStateWords(row)
    item.append(pill(words.label, words.tone))
    whoList.append(item)
  }
  who.append(whoList)
  main.append(who)

  // Done today
  const done = el('section', 'pc-section')
  done.setAttribute('aria-label', 'Done today')
  const doneHead = el('div', 'pc-section-head')
  doneHead.append(el('h2', 'pc-label', 'Done today'), pill(String(model.doneToday.length)))
  done.append(doneHead)
  const doneList = el('div', 'pc-list')
  for (const task of model.doneVisible) {
    const row = el('div', 'pc-list-row')
    const g = doneGlyph(task)
    const glyph = el('span', undefined, g.glyph)
    glyph.style.color = g.tone === 'good' ? 'var(--good-fg)' : g.tone === 'bad' ? 'var(--bad-fg)' : 'var(--ink-muted)'
    glyph.setAttribute('aria-label', g.label)
    row.append(glyph)
    const mid = el('div')
    mid.style.flex = '1'
    mid.style.minWidth = '0'
    mid.append(el('div', 'pc-row-title ellipsis', task.title))
    mid.append(
      el(
        'div',
        'pc-caption',
        `${executorLabelFor(task.executor, model.names)} · ${absoluteTime(task.updatedAt, now)}`,
      ),
    )
    row.append(mid)
    doneList.append(row)
  }
  done.append(doneList)
  if (model.doneMore > 0) {
    const more = el('a', undefined, `${model.doneMore} more in the pacer app`)
    more.href = '#'
    more.addEventListener('click', (e) => {
      e.preventDefault()
      void runRequest({ kind: 'act', op: 'ui.open', params: { view: 'tasks' }, pendingKey: 'done:more' })
    })
    done.append(more)
  }
  main.append(done)

  shell.append(main)

  const footer = el('footer', 'pc-footer')
  footer.append(
    button('Open the pacer app', {
      size: 'md',
      onClick: () =>
        void runRequest({ kind: 'act', op: 'ui.open', params: { view: 'overview' }, pendingKey: 'footer:open' }),
    }),
  )
  footer.append(el('p', 'pc-caption', 'Settings, accounts and routing live in the app.'))
  shell.append(footer)
  return shell
}

function renderModel(model: ReturnType<typeof panelModel>, now: number): HTMLElement {
  switch (model.kind) {
    case 'loading':
      return el('p', 'pc-caption', 'Loading')
    case 'load-error': {
      const card = el('div', 'pc-card pc-card--warn')
      card.append(el('div', 'pc-headline', 'Could not reach the plugin worker'))
      card.append(el('p', 'pc-caption', 'retrying'))
      return card
    }
    case 'not-connected': {
      const shell = el('div', 'pc-shell')
      const main = el('main', 'pc-main')
      const card = el('div', 'pc-card pc-card--sunken')
      card.append(el('h1', 'pc-headline', "pacer isn't running."))
      card.append(
        el(
          'p',
          'pc-caption',
          'The pacer app starts it. This panel reconnects by itself as soon as the service answers.',
        ),
      )
      card.append(
        button('Open the pacer app', {
          variant: 'primary',
          size: 'md',
          onClick: () =>
            void runRequest({ kind: 'act', op: 'ui.open', params: { view: 'overview' }, pendingKey: 'offline:open' }),
        }),
      )
      card.append(el('p', 'pc-caption', 'No app on this machine? Start it from a terminal:'))
      card.append(el('code', 'pc-selectable', 'pacer serve'))
      main.append(card)
      shell.append(main)
      return shell
    }
    case 'ready':
      return renderReady(model, now)
  }
}

function render(): void {
  if (root === null) return
  const active = document.activeElement
  const focusId =
    active instanceof HTMLElement && root.contains(active) ? active.id || active.getAttribute('data-focus') : null
  const selection =
    active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement
      ? { start: active.selectionStart, end: active.selectionEnd }
      : null
  const now = Date.now() / 1000
  root.replaceChildren(renderModel(panelModel(state, now), now))
  if (focusId) {
    const next = root.querySelector(`#${CSS.escape(focusId)}`) as HTMLInputElement | HTMLTextAreaElement | null
    if (next) {
      next.focus()
      if (selection && 'setSelectionRange' in next && selection.start != null && selection.end != null) {
        try {
          next.setSelectionRange(selection.start, selection.end)
        } catch {
          /* ignore */
        }
      }
    }
  }
  if (state.ui.menuOpen && menuButton) {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dispatch({ type: 'toggle-menu', open: false })
        menuButton?.focus()
        document.removeEventListener('keydown', onKey)
      }
    }
    document.addEventListener('keydown', onKey)
  }
}

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

// Relative "No progress for N min" only: update text nodes in place.
setInterval(() => {
  if (root === null || state.snapshot === null || !state.snapshot.connected) return
  const now = Date.now() / 1000
  for (const task of state.snapshot.running) {
    if (!task.liveness?.stalled) continue
    const mins = Math.max(1, Math.floor((now - task.liveness.since) / 60))
    const node = root.querySelector(`[data-id="${CSS.escape(task.id)}"] .pc-pill--warn`)
    if (node) node.textContent = `No progress for ${mins} min`
  }
}, 30_000)
