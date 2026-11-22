// Thin DOM glue: all decisions live in panel-view.ts.
import {
  absoluteTime,
  actionButtonLabel,
  actionNeedsConfirm,
  answerActionParams,
  answerDisabled,
  attentionCaption,
  attentionCardTone,
  attentionGlyph,
  buildDelegateParams,
  byRepoCaption,
  confirmTextFor,
  DELEGATE_KINDS,
  DELEGATE_SUBMIT_KEY,
  delegatedCaption,
  delegateWhyCaption,
  doneGlyph,
  emptyNeedsYouCopy,
  emptyRunningCopy,
  executorLabelFor,
  executorMonogram,
  executorOptionDisabled,
  executorStateWords,
  headerStatus,
  initialPanelState,
  isAnswerAction,
  isReviewOpenAction,
  menuItems,
  meterTone,
  modePillLabel,
  panelModel,
  pauseBannerExtra,
  phaseWords,
  plannerAgentDisplay,
  plannerCaption,
  plannerHeadline,
  rankChipText,
  reducePanel,
  rejectConfirmText,
  reviewExpectRev,
  runningCaption,
  shouldShowAdvice,
  showOpenWorktree,
  showsAnswerComposer,
  showsReviewVerdicts,
  stalledMinutes,
  successTextForAction,
  successTextForConfirm,
  visibleByRepos,
  whoRunsCounts,
  worktreeRadioCaption,
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
let menuKeyHandler: ((e: KeyboardEvent) => void) | null = null
let prevMenuOpen = false
let prevView: PanelState['ui']['view'] = 'main'

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
      now: Date.now() / 1000,
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
  fullWidth?: boolean
  onClick: () => void
}): HTMLButtonElement {
  const classes = ['pc-btn']
  if (opts.size === 'sm') classes.push('pc-btn--sm')
  if (opts.size === 'md' || opts.variant === 'primary') classes.push('pc-btn--md')
  if (opts.variant === 'primary') classes.push('pc-btn--primary')
  if (opts.variant === 'ghost') classes.push('pc-btn--ghost')
  if (opts.fullWidth) classes.push('pc-btn--block')
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
  const node = el('p', `pc-status pc-status--${status.tone}`, status.text)
  node.setAttribute('role', 'status')
  node.setAttribute('aria-live', 'polite')
  return node
}

function renderConfirm(confirm: ConfirmSpec): HTMLElement {
  const box = el('div', 'pc-confirm')
  box.append(el('p', undefined, confirm.text))
  const actions = el('div', 'pc-confirm-actions')
  actions.append(
    button(confirm.confirmLabel, {
      size: 'sm',
      onClick: () => void runRequest(confirm.run, successTextForConfirm(confirm)),
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

function askOrRun(
  action: AttentionAction,
  pendingKey: string,
  kind: string,
  extraParams?: Record<string, unknown>,
): void {
  const params = { ...action.params, ...extraParams }
  const run: RunRequest = { kind: 'act', op: action.op, params, pendingKey }
  const successText = successTextForAction(action, kind)
  if (actionNeedsConfirm(action)) {
    dispatch({
      type: 'ask-confirm',
      confirm: {
        key: pendingKey,
        text: confirmTextFor(action),
        confirmLabel: action.label,
        cancelLabel: 'Cancel',
        successText,
        run,
      },
    })
    return
  }
  void runRequest(run, successText)
}

function renderHeader(snapshot: PanelSnapshot, connected: boolean): HTMLElement {
  const header = el('header', 'pc-header')
  header.append(markSvg(), el('span', 'pc-wordmark', 'pacer'))
  if (connected) {
    const mode = modePillLabel(snapshot)
    header.append(pill(mode.text, mode.tone))
  }
  header.append(el('span', 'pc-header-spacer'))
  const live = el('span', 'pc-live')
  live.append(el('span', `pc-live-dot${connected ? '' : ' off'}`), document.createTextNode(connected ? 'Live' : 'Not connected'))
  header.append(live)
  if (connected) {
    menuButton = button('', {
      variant: 'ghost',
      size: 'sm',
      className: 'pc-btn--icon',
      ariaLabel: 'More actions',
      onClick: () => dispatch({ type: 'toggle-menu' }),
    })
    menuButton.id = 'menu-button'
    menuButton.setAttribute('aria-haspopup', 'menu')
    menuButton.setAttribute('aria-expanded', state.ui.menuOpen ? 'true' : 'false')
    menuButton.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="5" cy="12" r="1"></circle><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle></svg>'
    header.append(menuButton)
    if (state.ui.menuOpen) header.append(renderMenu(snapshot))
  } else {
    menuButton = null
  }
  const status = headerStatus(state.ui.statusByKey)
  if (status) {
    const line = el('p', `pc-header-status pc-status pc-status--${status.tone}`, status.text)
    line.setAttribute('role', 'status')
    line.setAttribute('aria-live', 'polite')
    header.append(line)
  }
  return header
}

function detachMenuKeyHandler(): void {
  if (menuKeyHandler) {
    document.removeEventListener('keydown', menuKeyHandler)
    menuKeyHandler = null
  }
}

function attachMenuKeyHandler(menu: HTMLElement): void {
  detachMenuKeyHandler()
  const items = () => Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
  menuKeyHandler = (e: KeyboardEvent) => {
    if (!state.ui.menuOpen) {
      detachMenuKeyHandler()
      return
    }
    const list = items()
    if (e.key === 'Escape') {
      e.preventDefault()
      dispatch({ type: 'toggle-menu', open: false })
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (list.length === 0) return
      const i = list.indexOf(document.activeElement as HTMLButtonElement)
      const next =
        e.key === 'ArrowDown'
          ? list[(i + 1) % list.length]!
          : list[(i <= 0 ? list.length : i) - 1]!
      next.focus()
    }
  }
  document.addEventListener('keydown', menuKeyHandler)
}

function renderMenu(snapshot: PanelSnapshot): HTMLElement {
  const menu = el('div', 'pc-menu')
  menu.id = 'pc-menu'
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', 'More actions')
  const now = Date.now() / 1000
  for (const item of menuItems(snapshot, now)) {
    if (item.kind === 'divider') {
      menu.append(el('div', 'pc-menu-divider'))
      continue
    }
    const b = el('button', 'pc-menu-item')
    b.type = 'button'
    b.setAttribute('role', 'menuitem')
    b.append(el('span', undefined, item.label))
    if (item.caption) b.append(el('span', 'pc-caption', item.caption))
    b.addEventListener('click', () => {
      dispatch({ type: 'toggle-menu', open: false })
      void runRequest(item.run, item.successText)
    })
    menu.append(b)
  }
  return menu
}

function renderAttentionCard(item: AttentionRow, model: Extract<ReturnType<typeof panelModel>, { kind: 'ready' }>, now: number): HTMLElement {
  const tone = attentionCardTone(item.kind)
  const card = el('div', `pc-card${tone === 'default' ? '' : ` pc-card--${tone}`}`)
  card.dataset.id = item.id
  if (model.scope === 'global') {
    card.append(el('div', 'pc-repo-label', item.repoLabel ?? 'All repos'))
  }
  const head = el('div', 'pc-card-head')
  const mono = executorMonogram(item.executor)
  if (mono) head.append(el('span', 'pc-mono-tile', mono))
  const glyph = attentionGlyph(item.kind)
  const titleWrap = el('div', 'pc-card-body')
  const title = el('div', 'pc-row-title', `${glyph ? `${glyph} ` : ''}${item.title}`)
  const when = absoluteTime(item.since, now)
  const exec = executorLabelFor(item.executor, model.names)
  titleWrap.append(title, el('div', 'pc-caption', attentionCaption({ executorLabel: exec, when, detail: item.detail })))
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

  if (showsAnswerComposer(item.kind)) {
    const answerId = `answer-${item.id}`
    const label = el('label', 'sr-only', 'Your answer')
    label.htmlFor = answerId
    const area = el('textarea')
    area.id = answerId
    area.name = `answer-${item.id}`
    area.rows = 2
    area.placeholder = 'Your answer'
    area.value = state.ui.answers[item.id] ?? ''
    area.addEventListener('input', () => dispatch({ type: 'set-answer', id: item.id, text: area.value }))
    card.append(label, area)
  }

  if (showsReviewVerdicts(item.kind)) {
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
              params: { id: taskId, verdict: 'accept', ...(expect != null ? { expect_rev: expect } : {}) },
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
              text: rejectConfirmText(execName),
              confirmLabel: 'Reject it',
              cancelLabel: 'Keep it',
              successText: 'Rejected',
              run: {
                kind: 'act',
                op: 'task.review',
                params: { id: taskId, verdict: 'reject', ...(expect != null ? { expect_rev: expect } : {}) },
                pendingKey: `att:${item.id}:reject`,
              },
            },
          })
        },
      }),
    )
  }

  for (const action of item.actions) {
    const label = actionButtonLabel(action, item.kind)
    const pendingKey = `att:${item.id}:${action.op}`
    if (showsAnswerComposer(item.kind) && isAnswerAction(action)) {
      const text = (state.ui.answers[item.id] ?? '').trim()
      const expect = reviewExpectRev(model.snapshot, item.taskId)
      actions.append(
        button(label, {
          size: 'sm',
          disabled: answerDisabled(text, busy),
          onClick: () => askOrRun(action, pendingKey, item.kind, answerActionParams(action, text, expect)),
        }),
      )
      continue
    }
    actions.append(
      button(label, {
        size: 'sm',
        variant: isReviewOpenAction(item.kind, action) ? 'ghost' : 'secondary',
        disabled: busy,
        onClick: () => askOrRun(action, pendingKey, item.kind),
      }),
    )
  }
  card.append(actions)
  const status =
    statusLine(`att:${item.id}:accept`) ||
    statusLine(`att:${item.id}:reject`) ||
    item.actions.map((a) => statusLine(`att:${item.id}:${a.op}`)).find(Boolean)
  if (status) card.append(status)
  return card
}

function renderRunningRow(task: PanelTask, model: Extract<ReturnType<typeof panelModel>, { kind: 'ready' }>, now: number): HTMLElement {
  const row = el('div', 'pc-list-row pc-list-row--running')
  row.dataset.id = task.id
  const mono = executorMonogram(task.executor)
  if (mono) row.append(el('span', 'pc-mono-tile', mono))
  const mid = el('div', 'pc-running-col')
  mid.append(el('div', 'pc-row-title ellipsis', task.title))
  const started = absoluteTime(task.attemptStartedAt ?? task.updatedAt, now)
  mid.append(
    el(
      'div',
      'pc-caption',
      runningCaption({
        scope: model.scope,
        repoLabel: task.repoLabel,
        executorLabel: executorLabelFor(task.executor, model.names),
        phase: phaseWords(task.phase),
        started,
      }),
    ),
  )
  if (task.liveness?.stalled) {
    mid.append(pill(`No progress for ${stalledMinutes(task.liveness.since, now)} min`, 'warn'))
  }
  const confirm = state.ui.confirm
  if (confirm?.key === `run:${task.id}:stop`) {
    mid.append(renderConfirm(confirm))
    row.append(mid)
    return row
  }
  const actions = el('div', 'pc-running-actions')
  const busy = !!state.ui.pending[`run:${task.id}`] || !!state.ui.pending[`run:${task.id}:stop`]
  if (showOpenWorktree(task.orcaWorkspaceId)) {
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
            successText: 'Stopped',
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
  mid.append(actions)
  row.append(mid)
  return row
}

function renderDelegate(model: Extract<ReturnType<typeof panelModel>, { kind: 'ready' }>, now: number): HTMLElement {
  const section = el('section', 'pc-section')
  section.setAttribute('aria-label', 'Delegate')
  const repoLabel = model.snapshot.focusedRepo?.label ?? 'this repo'

  if (model.ui.view === 'delegate-done' && model.ui.delegated) {
    const shell = el('div', 'pc-shell')
    const header = el('header', 'pc-header')
    const back = button('', {
      variant: 'ghost',
      size: 'sm',
      className: 'pc-btn--icon',
      ariaLabel: 'Back to the panel',
      onClick: () => dispatch({ type: 'set-view', view: 'main' }),
    })
    back.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"></path></svg>'
    header.append(back, el('h1', 'pc-headline', `Delegate in ${repoLabel}`))
    shell.append(header)
    const main = el('main', 'pc-main')
    const card = el('div', 'pc-card pc-card--sunken')
    const head = el('div', 'pc-delegate-done-head')
    head.append(el('span', 'pc-status pc-status--good', '✓'))
    head.append(el('strong', 'pc-headline', `Running on ${model.ui.delegated.executorLabel}`))
    card.append(head)
    card.append(el('p', undefined, model.ui.delegated.goal))
    card.append(
      el(
        'span',
        'pc-caption',
        delegatedCaption(model.ui.delegated.worktree, absoluteTime(model.ui.delegated.startedAt, now)),
      ),
    )
    card.append(el('code', 'pc-selectable pc-code-box', model.ui.delegated.taskId))
    main.append(card)
    const actions = el('div', 'pc-actions')
    actions.append(
      button('Watch', {
        size: 'md',
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
    if (showOpenWorktree(model.ui.delegated.orcaWorkspaceId)) {
      actions.append(
        button('Open worktree', {
          size: 'md',
          onClick: () =>
            void runRequest({
              kind: 'openWorkspace',
              workspaceId: model.ui.delegated!.orcaWorkspaceId!,
              pendingKey: 'delegate:open',
            }),
        }),
      )
    }
    main.append(actions)
    const backLink = button('Back to the panel', {
      size: 'sm',
      variant: 'ghost',
      onClick: () => dispatch({ type: 'set-view', view: 'main' }),
    })
    backLink.classList.add('pc-back-link')
    main.append(backLink)
    shell.append(main)
    return shell
  }

  if (model.ui.view === 'delegate') {
    const shell = el('div', 'pc-shell')
    const header = el('header', 'pc-header')
    const back = button('', {
      variant: 'ghost',
      size: 'sm',
      className: 'pc-btn--icon',
      ariaLabel: 'Back to the panel',
      onClick: () => dispatch({ type: 'set-view', view: 'main' }),
    })
    back.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"></path></svg>'
    header.append(back, el('h1', 'pc-headline', `Delegate in ${repoLabel}`))
    shell.append(header)
    const main = el('main', 'pc-main')
    const goalLabel = el('label', 'pc-label', 'Goal')
    goalLabel.htmlFor = 'delegate-goal'
    const goal = el('textarea')
    goal.id = 'delegate-goal'
    goal.name = 'delegate-goal'
    goal.rows = 5
    goal.value = model.ui.goal
    goal.placeholder = `What should an executor do in ${repoLabel}?`
    goal.addEventListener('input', () => dispatch({ type: 'set-goal', goal: goal.value }))
    main.append(goalLabel, goal)

    main.append(el('div', 'pc-label', 'Kind'))
    const chips = el('div', 'pc-chips')
    for (const kind of DELEGATE_KINDS) {
      const chip = el('button', 'pc-chip', kind.label)
      chip.type = 'button'
      chip.setAttribute('aria-pressed', model.ui.delegateKind === kind.id ? 'true' : 'false')
      chip.addEventListener('click', () => dispatch({ type: 'set-delegate-kind', kind: kind.id }))
      chips.append(chip)
    }
    main.append(chips)

    const execLabel = el('label', 'pc-label', 'Executor')
    execLabel.htmlFor = 'delegate-executor'
    const select = el('select')
    select.id = 'delegate-executor'
    select.name = 'delegate-executor'
    const next = model.next
    const nextLabel = next ? executorLabelFor(next.id, model.names) : 'Automatic'
    const auto = el('option', undefined, `Auto · ${nextLabel} runs next`)
    auto.value = 'auto'
    select.append(auto)
    for (const row of model.snapshot.executors) {
      const name = executorLabelFor(row.id, model.names) ?? row.id
      const opt = el('option', undefined, name)
      opt.value = row.id
      if (executorOptionDisabled(row)) {
        opt.disabled = true
        opt.textContent = `${name} · ${executorStateWords(row).label}`
      }
      select.append(opt)
    }
    select.value = model.ui.delegateExecutor
    select.addEventListener('change', () => dispatch({ type: 'set-delegate-executor', executor: select.value }))
    main.append(execLabel, select)
    main.append(
      el(
        'p',
        'pc-caption pc-why',
        delegateWhyCaption(model.ui.delegateExecutor, next, model.names, model.snapshot.executors),
      ),
    )

    const where = el('fieldset', 'pc-radio-list')
    where.append(el('legend', 'pc-label', 'Where it works'))
    for (const id of ['new', 'current'] as const) {
      const label = el('label', 'pc-radio')
      const input = el('input') as HTMLInputElement
      input.type = 'radio'
      input.name = 'delegate-worktree'
      input.value = id
      input.checked = model.ui.delegateWorktree === id
      input.addEventListener('change', () => dispatch({ type: 'set-delegate-worktree', worktree: id }))
      const text = el('span', 'pc-radio-text')
      text.append(el('strong', undefined, id === 'new' ? 'New worktree' : 'This worktree'))
      text.append(el('span', 'pc-caption', worktreeRadioCaption(id)))
      label.append(input, text)
      where.append(label)
    }
    main.append(where)

    const accLabel = el('label', 'pc-label', 'Done when this passes')
    accLabel.htmlFor = 'delegate-acceptance'
    const optional = el('span', 'pc-label-soft', ' · optional')
    accLabel.append(optional)
    const acc = el('input', 'pc-mono') as HTMLInputElement
    acc.id = 'delegate-acceptance'
    acc.name = 'delegate-acceptance'
    acc.type = 'text'
    acc.value = model.ui.acceptance
    acc.placeholder = 'optional command'
    acc.addEventListener('input', () => dispatch({ type: 'set-acceptance', acceptance: acc.value }))
    main.append(accLabel, acc)

    const targetName =
      model.ui.delegateExecutor === 'auto'
        ? nextLabel
        : executorLabelFor(model.ui.delegateExecutor, model.names)
    const row = el('div', 'pc-delegate-submit')
    row.append(
      button(`Delegate to ${targetName}`, {
        variant: 'primary',
        size: 'md',
        disabled: !model.ui.goal.trim() || !model.snapshot.focusedRepo || !!model.ui.pending[DELEGATE_SUBMIT_KEY],
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
            { kind: 'act', op: 'task.delegate', params, pendingKey: DELEGATE_SUBMIT_KEY },
            `Running on ${targetName}`,
          )
        },
      }),
      button('Cancel', {
        size: 'md',
        onClick: () => dispatch({ type: 'set-view', view: 'main' }),
      }),
    )
    main.append(row)
    if (model.ui.delegateError) main.append(el('p', 'pc-status pc-status--bad', model.ui.delegateError))
    shell.append(main)
    return shell
  }

  // Compact delegate on main
  const label = el('label', 'pc-label', 'Delegate from this worktree')
  label.htmlFor = 'goal'
  const goal = el('textarea')
  goal.id = 'goal'
  goal.name = 'goal'
  goal.rows = 3
  goal.placeholder = `What should an executor do in ${repoLabel}?`
  goal.value = model.ui.goal
  goal.addEventListener('input', () => dispatch({ type: 'set-goal', goal: goal.value }))
  const row = el('div', 'pc-delegate-compact')
  const nextName = model.next ? executorLabelFor(model.next.id, model.names) : 'an executor'
  const caption = el('span', 'pc-caption')
  caption.append(document.createTextNode(`Runs on ${nextName} · new worktree · `))
  const options = button('Options', {
    variant: 'ghost',
    size: 'sm',
    className: 'pc-link-btn',
    onClick: () => dispatch({ type: 'set-view', view: 'delegate' }),
  })
  caption.append(options)
  const delegate = button('Delegate', {
    variant: 'primary',
    size: 'md',
    disabled: !model.ui.goal.trim() || !model.snapshot.focusedRepo || !!model.ui.pending[DELEGATE_SUBMIT_KEY],
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
        { kind: 'act', op: 'task.delegate', params, pendingKey: DELEGATE_SUBMIT_KEY },
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
    return renderDelegate(model, now)
  }

  shell.append(renderHeader(snapshot, true))
  const main = el('main', 'pc-main')

  const plannerCard = el('div', 'pc-card pc-card--sunken')
  const planner = snapshot.planner
  const resetLabel = planner?.resetsAt ? absoluteTime(planner.resetsAt, now) : ''
  const headRow = el('div', 'pc-planner-head')
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
    const agentLabel = plannerAgentDisplay(planner.agent)
    meter.setAttribute(
      'aria-label',
      `${agentLabel} weekly usage ${Math.round(planner.usedPct)} percent, pace ${Math.round(planner.pacePct ?? 0)} percent`,
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
    plannerCard.append(el('p', 'pc-caption', plannerCaption(planner, resetLabel)))
    if (shouldShowAdvice(planner.advice, planner.verdict)) {
      const advice = el('p', 'pc-advice', planner.advice)
      plannerCard.append(advice)
    }
  } else {
    plannerCard.append(el('p', 'pc-caption', 'Usage unknown.'))
  }
  main.append(plannerCard)

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

  if (snapshot.pause) {
    const until = snapshot.pause.until ? absoluteTime(snapshot.pause.until, now) : 'later'
    const card = el('div', 'pc-card pc-card--warn')
    const title = el('div', 'pc-headline')
    title.append(el('span', 'pc-warn-glyph', '◐'), document.createTextNode(` Delegation is paused until ${until}`))
    card.append(title)
    const captionParts = ['New tasks wait in the queue; running ones finish.']
    // Pause "at" is not on the wire; show by when known.
    const extra = pauseBannerExtra(snapshot.pause, null)
    if (extra) captionParts.push(extra)
    card.append(el('p', 'pc-caption', captionParts.join(' ')))
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
    main.append(renderDelegate(model, now))
  }

  if (model.scope === 'global') {
    const { rows: byRepoRows, more: byRepoMore } = visibleByRepos(snapshot.repos)
    if (byRepoRows.length > 0) {
      const byRepo = el('section', 'pc-section')
      byRepo.setAttribute('aria-label', 'By repo')
      byRepo.append(el('h2', 'pc-label', 'By repo'))
      const list = el('div', 'pc-list')
      for (const repo of byRepoRows) {
        const row = el('div', 'pc-list-row')
        const mid = el('div', 'pc-card-body')
        const title = el('div', 'pc-row-title ellipsis', repo.label)
        if (snapshot.focusedRepo?.key === repo.key) {
          title.textContent = `${repo.label} · this worktree`
        }
        mid.append(title, el('div', 'pc-caption', byRepoCaption(repo)))
        row.append(mid)
        if (repo.needsYou > 0) row.append(pill(String(repo.needsYou), 'bad'))
        if (showOpenWorktree(repo.orcaWorkspaceId)) {
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
      if (byRepoMore > 0) {
        byRepo.append(
          button(`${byRepoMore} more in the pacer app`, {
            variant: 'ghost',
            size: 'sm',
            className: 'pc-link-btn',
            onClick: () =>
              void runRequest({
                kind: 'act',
                op: 'ui.open',
                params: { view: 'overview' },
                pendingKey: 'by-repo:more',
              }),
          }),
        )
      }
      main.append(byRepo)
    }
  }

  const needs = el('section', 'pc-section')
  needs.setAttribute('aria-label', 'Needs you')
  const needsHead = el('div', 'pc-section-head')
  needsHead.append(el('h2', 'pc-label', 'Needs you'))
  if (model.attention.length > 0) needsHead.append(pill(String(model.attention.length), 'bad'))
  needs.append(needsHead)
  if (model.attention.length === 0) {
    needs.append(el('div', 'pc-empty', emptyNeedsYouCopy(model.scope, snapshot.focusedRepo?.label)))
    if (model.scope === 'repo' && model.otherNeedsYou > 0) {
      const link = button(`${model.otherNeedsYou} in other repos`, {
        variant: 'ghost',
        size: 'sm',
        className: 'pc-link-btn',
        onClick: () => dispatch({ type: 'set-scope', scope: 'global' }),
      })
      needs.append(link)
    }
  } else {
    for (const item of model.attention) needs.append(renderAttentionCard(item, model, now))
  }
  main.append(needs)

  const running = el('section', 'pc-section')
  running.setAttribute('aria-label', 'Running')
  const runHead = el('div', 'pc-section-head')
  runHead.append(el('h2', 'pc-label', 'Running'), pill(String(model.running.length)))
  running.append(runHead)
  if (model.running.length === 0) {
    const nextName = model.next ? executorLabelFor(model.next.id, model.names) : null
    running.append(el('div', 'pc-empty', emptyRunningCopy(nextName)))
  } else {
    const list = el('div', 'pc-list')
    for (const task of model.running) list.append(renderRunningRow(task, model, now))
    running.append(list)
  }
  main.append(running)

  const who = el('section', 'pc-section')
  who.setAttribute('aria-label', 'Who runs next')
  const counts = whoRunsCounts(snapshot.executors)
  const whoHead = el('div', 'pc-section-head')
  whoHead.append(el('h2', 'pc-label', 'Who runs next'), el('span', 'pc-caption', `${counts.ready} ready · ${counts.out} out`))
  who.append(whoHead)
  const whoList = el('div', 'pc-list')
  for (const row of snapshot.executors) {
    const item = el('div', 'pc-list-row')
    const rank = el('span', `pc-rank${row.next ? ' pc-rank--next' : ''}`, rankChipText(row))
    item.append(rank)
    const mid = el('div', 'pc-card-body')
    mid.append(el('div', 'pc-row-title ellipsis', executorLabelFor(row.id, model.names) ?? row.id))
    mid.append(el('div', 'pc-caption', `${row.next ? 'Next · ' : ''}${row.sub}`))
    item.append(mid)
    const words = executorStateWords(row)
    item.append(pill(words.label, words.tone))
    whoList.append(item)
  }
  who.append(whoList)
  main.append(who)

  const done = el('section', 'pc-section')
  done.setAttribute('aria-label', 'Done today')
  const doneHead = el('div', 'pc-section-head')
  doneHead.append(el('h2', 'pc-label', 'Done today'), pill(String(model.doneToday.length)))
  done.append(doneHead)
  const doneList = el('div', 'pc-list')
  for (const task of model.doneVisible) {
    const row = el('div', 'pc-list-row pc-list-row--done')
    const g = doneGlyph(task)
    const glyph = el('span', 'pc-done-glyph', g.glyph)
    glyph.style.color =
      g.tone === 'good' ? 'var(--good-fg)' : g.tone === 'bad' ? 'var(--bad-fg)' : g.tone === 'warn' ? 'var(--warn-fg)' : 'var(--ink-muted)'
    glyph.setAttribute('aria-label', g.label)
    row.append(glyph)
    row.append(el('span', 'pc-done-title', task.title))
    row.append(
      el(
        'span',
        'pc-done-meta',
        `${executorLabelFor(task.executor, model.names) ?? 'Automatic'} · ${absoluteTime(task.updatedAt, now)}`,
      ),
    )
    doneList.append(row)
  }
  done.append(doneList)
  if (model.doneMore > 0) {
    done.append(
      button(`${model.doneMore} more in the pacer app`, {
        variant: 'ghost',
        size: 'sm',
        className: 'pc-link-btn',
        onClick: () =>
          void runRequest({ kind: 'act', op: 'ui.open', params: { view: 'tasks' }, pendingKey: 'done:more' }),
      }),
    )
  }
  main.append(done)

  shell.append(main)

  const footer = el('footer', 'pc-footer')
  footer.append(
    button('Open the pacer app', {
      size: 'md',
      fullWidth: true,
      onClick: () =>
        void runRequest({ kind: 'act', op: 'ui.open', params: { view: 'overview' }, pendingKey: 'footer:open' }),
    }),
  )
  footer.append(el('p', 'pc-caption pc-footer-caption', 'Settings, accounts and routing live in the app.'))
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
      shell.append(renderHeader(model.snapshot, false))
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
      card.append(el('code', 'pc-code-box', 'pacer serve'))
      main.append(card)
      shell.append(main)
      return shell
    }
    case 'ready':
      return renderReady(model, now)
  }
}

/** Stable selector for any focused text control (id, data-focus, or name). */
function focusSelector(active: Element | null): string | null {
  if (!(active instanceof HTMLElement) || !root?.contains(active)) return null
  if (active.id) return `#${CSS.escape(active.id)}`
  const dataFocus = active.getAttribute('data-focus')
  if (dataFocus) return `[data-focus="${CSS.escape(dataFocus)}"]`
  if (
    (active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLSelectElement) &&
    active.name
  ) {
    return `${active.tagName.toLowerCase()}[name="${CSS.escape(active.name)}"]`
  }
  return null
}

function render(): void {
  if (root === null) return
  const active = document.activeElement
  const selector = focusSelector(active)
  const selection =
    active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement
      ? { start: active.selectionStart, end: active.selectionEnd }
      : null
  const now = Date.now() / 1000
  const openingMenu = state.ui.menuOpen && !prevMenuOpen
  const closingMenu = !state.ui.menuOpen && prevMenuOpen
  const openingDelegate = state.ui.view === 'delegate' && prevView !== 'delegate'
  root.replaceChildren(renderModel(panelModel(state, now), now))

  if (openingDelegate) {
    const goal = root.querySelector('#delegate-goal') as HTMLTextAreaElement | null
    goal?.focus()
  } else if (openingMenu) {
    const first = root.querySelector<HTMLButtonElement>('#pc-menu [role="menuitem"]')
    first?.focus()
  } else if (closingMenu) {
    menuButton?.focus()
  } else if (selector) {
    const next = root.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null
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

  if (state.ui.menuOpen) {
    const menu = root.querySelector('#pc-menu') as HTMLElement | null
    if (menu) attachMenuKeyHandler(menu)
  } else {
    detachMenuKeyHandler()
  }

  prevMenuOpen = state.ui.menuOpen
  prevView = state.ui.view
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

setInterval(() => {
  if (root === null || state.snapshot === null || !state.snapshot.connected) return
  const now = Date.now() / 1000
  for (const task of state.snapshot.running) {
    if (!task.liveness?.stalled) continue
    const mins = stalledMinutes(task.liveness.since, now)
    const node = root.querySelector(`[data-id="${CSS.escape(task.id)}"] .pc-pill--warn`)
    if (node) node.textContent = `No progress for ${mins} min`
  }
}, 30_000)
