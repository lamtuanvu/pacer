// Thin DOM glue: all decisions live in panel-view.ts.
import {
  absoluteTime,
  answerActionParams,
  answerDisabled,
  classifyTask,
  controlBusy,
  doneGlyph,
  executorShortLabel,
  initialPanelState,
  panelModel,
  plannerAgentDisplay,
  reducePanel,
  reviewExpectRev,
  showOpenWorktree,
  stalledMinutes,
  stalledPillText,
  summaryText,
  taskGlyph,
  taskStatusText,
  taskStatusTone,
  worktreeTasks,
  type PanelEvent,
  type PanelState,
  type RunRequest,
} from './panel-view'
import type { AttentionAction } from './pacer-client'
import type { AttentionRow, PanelSnapshot, PanelTask } from './protocol'

let state: PanelState = initialPanelState()
const root = document.getElementById('pacer-panel')

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

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function markSvg(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('viewBox', '0 0 48 48')
  svg.setAttribute('aria-hidden', 'true')
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

function button(label: string, opts: { variant?: 'primary' | 'ghost' | 'secondary'; size?: 'sm' | 'md'; disabled?: boolean; onClick: () => void; className?: string }): HTMLButtonElement {
  const classes = ['pc-btn']
  if (opts.size === 'sm') classes.push('pc-btn--sm')
  if (opts.size === 'md') classes.push('pc-btn--md')
  if (opts.variant === 'primary') classes.push('pc-btn--primary')
  if (opts.variant === 'ghost') classes.push('pc-btn--ghost')
  if (opts.className) classes.push(opts.className)
  const node = el('button', classes.join(' '), label)
  node.type = 'button'
  if (opts.disabled) node.disabled = true
  node.addEventListener('click', opts.onClick)
  return node
}

function verdictWords(verdict?: string): string {
  const map: Record<string, string> = {
    behind: 'behind pace',
    on_pace: 'on pace',
    ahead: 'ahead of pace',
    out: 'out of quota',
  }
  return verdict ? (map[verdict] ?? verdict) : ''
}

function renderHeader(snapshot: PanelSnapshot): HTMLElement {
  const header = el('header', undefined)
  header.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid var(--line);'
  header.append(markSvg())
  const spacer = el('span')
  spacer.style.flexGrow = '1'
  header.append(spacer)
  const planner = snapshot.planner
  if (planner && typeof planner.usedPct === 'number') {
    const text = `${plannerAgentDisplay(planner.agent)} ${Math.round(planner.usedPct)}% · ${verdictWords(planner.verdict)}`
    header.append(el('span', undefined, text))
    const span = header.lastChild as HTMLElement
    span.style.cssText = 'font-size:12px;line-height:16px;color:var(--ink-muted);'
  }
  return header
}


function renderNeedsRow(item: AttentionRow, model: Extract<ReturnType<typeof panelModel>, { kind: 'ready' }>, now: number): HTMLElement {
  const isOpen = state.ui.expandedTaskId === `need:${item.id}`
  const row = el('div', 'pc-needs-row')
  row.dataset.row = `need:${item.id}`
  const btn = el('button', 'row')
  btn.type = 'button'
  btn.dataset.focus = 'toggle'
  btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false')
  btn.addEventListener('click', () => dispatch({ type: 'toggle-task', id: isOpen ? null : `need:${item.id}` }))
  const glyph = el('span', undefined, '◐')
  glyph.style.cssText = 'flex:none;width:14px;text-align:center;color:var(--warn-fg);'
  btn.append(glyph)
  const title = el('span', undefined, item.title)
  title.style.cssText = 'flex-grow:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;'
  btn.append(title)
  const status = el('span', undefined, item.kind === 'review' ? 'review asked' : 'message for you')
  status.style.cssText = 'flex:none;font-size:12px;color:var(--warn-fg);'
  btn.append(status)
  row.append(btn)
  if (isOpen) {
    const detail = el('div')
    detail.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:0 12px 12px 34px;'
    const when = absoluteTime(item.since, now)
    const exec = executorShortLabel(item.executor)
    detail.append(el('span', undefined, [item.detail, exec, when].filter(Boolean).join(' · ')))
    ;(detail.lastChild as HTMLElement).style.cssText = 'font-size:12px;line-height:16px;color:var(--ink-secondary);'
    const actions = el('div')
    actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;'
    // Accept/Reject for review
    if (item.kind === 'review') {
      const taskId = item.taskId
      const expect = reviewExpectRev(model.snapshot, taskId)
      actions.append(button('Accept', { size: 'sm', onClick: () => {
        const pendingKey = `att:${item.id}:accept`
        dispatch({ type: 'begin', pendingKey })
        void runRequest({ kind: 'act', op: 'task.review', params: { id: taskId, verdict: 'accept', ...(expect != null ? { expect_rev: expect } : {}) }, pendingKey }, 'Accepted')
      } }))
      actions.append(button('Reject', { size: 'sm', onClick: () => {
        const pendingKey = `att:${item.id}:reject`
        const who = executorShortLabel(item.executor) ?? 'The executor'
        dispatch({ type: 'ask-confirm', confirm: { key: pendingKey, text: `Reject this result? ${who} is told it was rejected; the worktree stays for a retry.`, confirmLabel: 'Reject it', cancelLabel: 'Keep it', successText: 'Rejected', run: { kind: 'act', op: 'task.review', params: { id: taskId, verdict: 'reject', ...(expect != null ? { expect_rev: expect } : {}) }, pendingKey } } })
      } }))
    }
    // service actions
    for (const a of item.actions ?? []) {
      const pendingKey = `att:${item.id}:${a.op}`
      actions.append(button(a.label, { size: 'sm', variant: 'ghost', onClick: () => {
        dispatch({ type: 'begin', pendingKey })
        void runRequest({ kind: 'act', op: a.op, params: { ...a.params }, pendingKey }, a.label)
      } }))
    }
    detail.append(actions)
    const confirmBox = renderConfirm(`att:${item.id}:`)
    if (confirmBox) detail.append(confirmBox)
    row.append(detail)
  }
  return row
}

/** The in-row confirm (Stop, Reject) for the pending action whose key starts with `prefix`. */
function renderConfirm(prefix: string): HTMLElement | null {
  const confirm = state.ui.confirm
  if (!confirm || !confirm.key.startsWith(prefix)) return null
  const box = el('div', undefined)
  box.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:8px;background:var(--surface-lane);'
  box.append(el('p', undefined, confirm.text))
  ;(box.lastChild as HTMLElement).style.margin = '0'
  const acts = el('div')
  acts.style.cssText = 'display:flex;gap:8px;'
  acts.append(button(confirm.confirmLabel, { size: 'sm', onClick: () => void runRequest(confirm.run, confirm.successText) }))
  acts.append(button(confirm.cancelLabel, { size: 'sm', variant: 'ghost', onClick: () => dispatch({ type: 'cancel-confirm' }) }))
  box.append(acts)
  return box
}

function renderTaskRow(task: PanelTask, model: Extract<ReturnType<typeof panelModel>, { kind: 'ready' }>, now: number): HTMLElement {
  const isOpen = state.ui.expandedTaskId === task.id
  const rowWrap = el('div', 'pc-task-row')
  rowWrap.dataset.row = task.id
  const btn = el('button', 'row')
  btn.type = 'button'
  btn.dataset.focus = 'toggle'
  btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false')
  btn.addEventListener('click', () => dispatch({ type: 'toggle-task', id: isOpen ? null : task.id }))
  const g = taskGlyph(task)
  const glyph = el('span', undefined, g.glyph)
  glyph.style.cssText = `flex:none;width:14px;text-align:center;color:${g.colorVar};`
  btn.append(glyph)
  const title = el('span', undefined, task.title)
  title.style.cssText = 'flex-grow:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
  btn.append(title)
  const status = el('span', undefined, taskStatusText(task, now))
  const stColor = { warn: 'var(--warn-fg)', bad: 'var(--bad-fg)', muted: 'var(--ink-muted)' }[taskStatusTone(task)]
  status.style.cssText = `flex:none;font-size:12px;color:${stColor};`
  btn.append(status)
  rowWrap.append(btn)
  if (isOpen) {
    const detail = el('div')
    detail.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:0 12px 12px 34px;'
    const execLabel = executorShortLabel(task.executor) ?? 'The executor'
    let detailText = ''
    const cl = classifyTask(task)
    if (cl === 'asked') {
      const when = absoluteTime(task.updatedAt, now)
      detailText = `${execLabel} asked the caller (this worktree's agent) · ${when}. The caller usually answers; answer yourself only to override.`
    } else if (cl === 'caller-deciding') {
      detailText = `${execLabel} · waiting on caller's decision`
    } else if (cl === 'running') {
      const phase = task.phase ?? 'working'
      const phaseMap: Record<string,string> = { driving:"you're driving", starting:'starting', working:'editing', testing:'testing', idle:'idle', 'lost-contact':'lost contact', queued:'queued' }
      const pw = phaseMap[phase] ?? phase
      detailText = `${execLabel} · ${pw} · started ${absoluteTime(task.attemptStartedAt ?? task.updatedAt, now)}`
    } else if (cl === 'queued') {
      const next = executorShortLabel(task.nextExecutor) ?? 'an executor'
      detailText = `Waits for ${next} · queued ${absoluteTime(task.updatedAt, now)}`
    } else {
      detailText = task.title
    }
    detail.append(el('span', undefined, detailText))
    const span = detail.lastChild as HTMLElement
    span.style.cssText = 'font-size:12px;line-height:16px;color:var(--ink-secondary);'

    // question box
    if (cl === 'asked' && task.question) {
      const qbox = el('p', undefined, task.question)
      qbox.style.cssText = 'margin:0;padding:8px 10px;border-radius:8px;border:1px solid var(--line);font-size:12px;line-height:16px;'
      detail.append(qbox)
    }
    // answer yourself flow
    if (cl === 'asked') {
      const isAnswering = state.ui.answeringTaskId === task.id
      if (isAnswering) {
        const ta = el('textarea') as HTMLTextAreaElement
        ta.placeholder = 'Your answer instead of the caller\'s'
        ta.value = state.ui.answers[task.id] ?? ''
        ta.addEventListener('input', () => dispatch({ type: 'set-answer', id: task.id, text: ta.value }))
        detail.append(ta)
      }
      const actions = el('div')
      actions.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin-left:-12px;'
      if (cl === 'asked') {
        if (state.ui.answeringTaskId === task.id) {
          // Send answer + Cancel
          const sendBtn = button('Send answer', { size: 'sm', variant: 'ghost', disabled: answerDisabled(state.ui.answers[task.id] ?? '', controlBusy(state.ui.pending, `run:${task.id}:answer`)), onClick: () => {
            const action = { label: 'Answer', op: 'task.answer', params: { id: task.id } } as AttentionAction
            const text = (state.ui.answers[task.id] ?? '').trim()
            const params = answerActionParams(action, text, task.rev)
            const pendingKey = `run:${task.id}:answer`
            dispatch({ type: 'begin', pendingKey })
            void runRequest({ kind: 'act', op: 'task.answer', params, pendingKey }, 'Answer sent')
          } })
          actions.append(sendBtn)
          actions.append(button('Cancel', { size: 'sm', variant: 'ghost', onClick: () => dispatch({ type: 'cancel-answer', id: task.id }) }))
        } else {
          actions.append(button('Answer yourself', { size: 'sm', variant: 'ghost', onClick: () => dispatch({ type: 'start-answer', id: task.id }) }))
        }
      }
      // Watch, Open worktree, Stop
      const busy = controlBusy(state.ui.pending, `run:${task.id}:watch`) || controlBusy(state.ui.pending, `run:${task.id}:stop`)
      actions.append(button('Watch', { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => {
        const pendingKey = `run:${task.id}:watch`
        dispatch({ type: 'begin', pendingKey })
        void runRequest({ kind: 'act', op: 'task.attach', params: { id: task.id, target: 'orca' }, pendingKey }, 'Watching')
      } }))
      if (showOpenWorktree(task.orcaWorkspaceId)) {
        actions.append(button('Open worktree', { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => {
          const pendingKey = `run:${task.id}:open`
          dispatch({ type: 'begin', pendingKey })
          void runRequest({ kind: 'openWorkspace', workspaceId: task.orcaWorkspaceId!, pendingKey })
        } }))
      }
      actions.append(button('Stop', { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => {
        dispatch({ type: 'ask-confirm', confirm: { key: `run:${task.id}:stop`, text: 'Stop this task?', confirmLabel: 'Stop it', cancelLabel: 'Keep it', successText: 'Stopped', run: { kind: 'act', op: 'task.stop', params: { id: task.id, expect_rev: task.rev }, pendingKey: `run:${task.id}:stop` } } })
      } }))
      detail.append(actions)
    } else if (cl === 'running') {
      const actions = el('div')
      actions.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin-left:-12px;'
      const busy = controlBusy(state.ui.pending, `run:${task.id}:watch`) || controlBusy(state.ui.pending, `run:${task.id}:stop`)
      actions.append(button('Watch', { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => {
        const pendingKey = `run:${task.id}:watch`
        dispatch({ type: 'begin', pendingKey })
        void runRequest({ kind: 'act', op: 'task.attach', params: { id: task.id, target: 'orca' }, pendingKey }, 'Watching')
      } }))
      if (showOpenWorktree(task.orcaWorkspaceId)) {
        actions.append(button('Open worktree', { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => {
          const pendingKey = `run:${task.id}:open`
          dispatch({ type: 'begin', pendingKey })
          void runRequest({ kind: 'openWorkspace', workspaceId: task.orcaWorkspaceId!, pendingKey })
        } }))
      }
      actions.append(button('Stop', { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => {
        dispatch({ type: 'ask-confirm', confirm: { key: `run:${task.id}:stop`, text: 'Stop this task?', confirmLabel: 'Stop it', cancelLabel: 'Keep it', successText: 'Stopped', run: { kind: 'act', op: 'task.stop', params: { id: task.id, expect_rev: task.rev }, pendingKey: `run:${task.id}:stop` } } })
      } }))
      detail.append(actions)
    } else if (cl === 'queued') {
      const actions = el('div')
      actions.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin-left:-12px;'
      actions.append(button('Stop', { size: 'sm', variant: 'ghost', onClick: () => {
        dispatch({ type: 'ask-confirm', confirm: { key: `run:${task.id}:stop`, text: 'Stop this task?', confirmLabel: 'Stop it', cancelLabel: 'Keep it', successText: 'Stopped', run: { kind: 'act', op: 'task.stop', params: { id: task.id, expect_rev: task.rev }, pendingKey: `run:${task.id}:stop` } } })
      } }))
      detail.append(actions)
    } else if (cl === 'failed') {
      const att = (model.snapshot.attention ?? []).find((a) => a.taskId === task.id && (a.kind === 'failed' || a.kind === 'limit'))
      const actions = el('div')
      actions.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin-left:-12px;'
      if (att) {
        for (const a of att.actions ?? []) {
          actions.append(button(a.label, { size: 'sm', variant: 'ghost', onClick: () => {
            const pendingKey = `att:${att.id}:${a.op}`
            dispatch({ type: 'begin', pendingKey })
            void runRequest({ kind: 'act', op: a.op, params: { ...a.params }, pendingKey }, a.label)
          } }))
        }
      }
      detail.append(actions)
    }

    const confirmBox = renderConfirm(`run:${task.id}:`)
    if (confirmBox) detail.append(confirmBox)
    rowWrap.append(detail)
  }
  return rowWrap
}


function renderReady(model: Extract<ReturnType<typeof panelModel>, { kind: 'ready' }>, now: number): HTMLElement {
  const shell = el('div', 'pc-shell')
  shell.style.cssText = 'display:flex;flex-direction:column;min-height:100%;'
  const snapshot = model.snapshot
  shell.append(renderHeader(snapshot))

  const main = el('main')
  main.style.cssText = 'display:flex;flex-direction:column;gap:16px;padding:12px 16px 16px;flex:1;'

  // no focus
  if (!snapshot.focusedWorkspace) {
    main.append(el('p', undefined, 'Focus an Orca worktree to see the tasks delegated from it.'))
    const p = main.lastChild as HTMLElement
    p.style.color = 'var(--ink-secondary)'
    shell.append(main)
    return shell
  }

  const tasks = model.tasks
  const empty = tasks.length === 0 && model.needsYou.length === 0

  // title line
  const titleRow = el('div')
  titleRow.style.cssText = 'display:flex;flex-wrap:wrap;align-items:baseline;column-gap:8px;row-gap:2px;'
  titleRow.append(el('h1', undefined, `From ${snapshot.focusedWorkspace.name}`))
  const h1 = titleRow.firstChild as HTMLElement
  h1.style.cssText = 'margin:0;font-size:14px;line-height:20px;font-weight:650;white-space:nowrap;'
  titleRow.append(el('span', undefined, model.summary))
  const cap = titleRow.lastChild as HTMLElement
  cap.style.cssText = 'font-size:12px;line-height:16px;color:var(--ink-muted);'
  main.append(titleRow)

  if (empty) {
    const p = el('p', undefined, 'Nothing delegated from this worktree yet.')
    p.style.color = 'var(--ink-secondary)'
    p.style.margin = '0'
    main.append(p)
  }

  // Needs you
  if (model.needsYou.length > 0) {
    const section = el('section')
    section.setAttribute('aria-label', 'Needs you')
    section.style.cssText = 'display:flex;flex-direction:column;gap:6px;'
    const h2 = el('h2', undefined, `NEEDS YOU · ${model.needsYou.length}`)
    h2.style.cssText = 'margin:0;font-size:11px;line-height:14px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:var(--bad-fg);'
    section.append(h2)
    const box = el('div')
    box.style.cssText = 'display:flex;flex-direction:column;border:1px solid var(--warn-line);border-radius:10px;background:var(--warn-tint);overflow:hidden;'
    for (const item of model.needsYou) box.append(renderNeedsRow(item, model, now))
    section.append(box)
    main.append(section)
  }

  // Tasks
  if (tasks.length > 0) {
  const tsection = el('section')
  tsection.setAttribute('aria-label', 'Tasks')
  tsection.style.cssText = 'display:flex;flex-direction:column;gap:6px;'
  const th2 = el('h2', undefined, `TASKS · ${tasks.length}`)
  th2.style.cssText = 'margin:0;font-size:11px;line-height:14px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:var(--ink-muted);'
  tsection.append(th2)
  const tbox = el('div')
  tbox.style.cssText = 'display:flex;flex-direction:column;border:1px solid var(--line);border-radius:10px;overflow:hidden;'
  for (const t of tasks) tbox.append(renderTaskRow(t, model, now))
  tsection.append(tbox)
  main.append(tsection)
  }

  // Done
  const doneSection = el('section')
  doneSection.dataset.row = 'done'
  doneSection.setAttribute('aria-label', 'Done')
  doneSection.style.cssText = 'display:flex;flex-direction:column;gap:6px;'
  const doneBtn = el('button', 'row')
  doneBtn.type = 'button'
  doneBtn.dataset.focus = 'toggle'
  doneBtn.style.cssText = 'padding:4px 0;min-height:28px;'
  doneBtn.setAttribute('aria-expanded', state.ui.doneOpen ? 'true' : 'false')
  doneBtn.addEventListener('click', () => dispatch({ type: 'toggle-done' }))
  const chev = el('span', undefined, state.ui.doneOpen ? '▾' : '▸')
  chev.style.cssText = 'flex:none;width:14px;color:var(--ink-muted);'
  doneBtn.append(chev)
  const doneLabel = el('span', undefined, `DONE · ${model.doneTasks.length + model.doneMore}`)
  doneLabel.style.cssText = 'font-size:11px;line-height:14px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:var(--ink-muted);'
  doneBtn.append(doneLabel)
  doneSection.append(doneBtn)
  if (state.ui.doneOpen) {
    const dbox = el('div')
    dbox.style.cssText = 'display:flex;flex-direction:column;border:1px solid var(--line);border-radius:10px;'
    for (const d of model.doneTasks) {
      const drow = el('div')
      drow.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 12px;border-top:1px solid var(--surface-lane);font-size:12px;line-height:16px;'
      const g = doneGlyph(d)
      const dg = el('span', undefined, g.glyph)
      dg.style.cssText = `flex:none;width:14px;text-align:center;color:${g.tone === 'good' ? 'var(--good-fg)' : g.tone === 'bad' ? 'var(--bad-fg)' : g.tone === 'warn' ? 'var(--warn-fg)' : 'var(--ink-muted)'};`
      dg.setAttribute('aria-label', g.label)
      drow.append(dg)
      const dt = el('span', undefined, d.title)
      dt.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink);'
      drow.append(dt)
      const meta = el('span', undefined, [executorShortLabel(d.executor), absoluteTime(d.updatedAt, now)].filter(Boolean).join(' · '))
      meta.style.cssText = 'flex:none;color:var(--ink-muted);'
      drow.append(meta)
      dbox.append(drow)
    }
    doneSection.append(dbox)
    if (model.doneMore > 0) {
      const more = button(`${model.doneMore} more in the pacer app`, { size: 'sm', variant: 'ghost', className: 'pc-link-btn', onClick: () => {
        const pendingKey = 'done:more'
        dispatch({ type: 'begin', pendingKey })
        void runRequest({ kind: 'act', op: 'ui.open', params: { view: 'tasks' }, pendingKey })
      } })
      doneSection.append(more)
    }
  }
  main.append(doneSection)

  shell.append(main)
  return shell
}

function renderModel(model: ReturnType<typeof panelModel>, now: number): HTMLElement {
  switch (model.kind) {
    case 'loading':
      return el('p', undefined, 'Loading')
    case 'load-error': {
      const card = el('div')
      card.style.cssText = 'border:1px solid var(--warn-line);background:var(--warn-tint);border-radius:10px;padding:12px;gap:10px;display:flex;flex-direction:column;'
      card.append(el('div', undefined, 'Could not reach the plugin worker'))
      const h = card.firstChild as HTMLElement
      h.style.cssText = 'font-size:16px;line-height:22px;font-weight:650;'
      card.append(el('p', undefined, 'retrying'))
      return card
    }
    case 'not-connected': {
      const shell = el('div', 'pc-shell')
      shell.style.cssText = 'display:flex;flex-direction:column;min-height:100%;'
      shell.append(renderHeader(model.snapshot))
      const main = el('main')
      main.style.cssText = 'display:flex;flex-direction:column;gap:16px;padding:12px 16px 16px;flex:1;'
      const card = el('div')
      card.style.cssText = 'border:1px solid var(--line);background:var(--surface-card);border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:12px;'
      const h = el('h1', undefined, "pacer isn't running.")
      h.style.cssText = 'margin:0;font-size:16px;line-height:22px;font-weight:650;'
      card.append(h)
      card.append(el('p', undefined, 'The pacer app starts it. This panel reconnects by itself as soon as the service answers.'))
      if (model.lastSeenAt) {
        card.append(el('span', undefined, `Last seen ${absoluteTime(model.lastSeenAt, now)} · retrying every few seconds`))
      }
      card.append(button('Open the pacer app', { size: 'md', variant: 'primary', onClick: () => {
        const pendingKey = 'offline:open'
        dispatch({ type: 'begin', pendingKey })
        void runRequest({ kind: 'act', op: 'ui.open', params: { view: 'overview' }, pendingKey })
      } }))
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

/** Where focus was before a re-render: its row, and the control within it (toggle, textarea, or button by label). */
type FocusMark = { row: string | null; key: string; start: number | null; end: number | null }

function focusMark(): FocusMark | null {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || !root?.contains(active)) return null
  const row = active.closest<HTMLElement>('[data-row]')?.dataset.row ?? null
  if (active instanceof HTMLTextAreaElement) return { row, key: 'textarea', start: active.selectionStart, end: active.selectionEnd }
  return { row, key: active.dataset.focus ?? `label:${active.textContent ?? ''}`, start: null, end: null }
}

function restoreFocus(mark: FocusMark): void {
  if (root === null) return
  const scope = mark.row ? root.querySelector<HTMLElement>(`[data-row="${CSS.escape(mark.row)}"]`) : root
  if (!scope) return
  let target: HTMLElement | null = null
  if (mark.key === 'textarea') target = scope.querySelector('textarea')
  else if (mark.key.startsWith('label:')) {
    const label = mark.key.slice('label:'.length)
    target = Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === label && !b.disabled) ?? null
  } else target = scope.querySelector(`[data-focus="${CSS.escape(mark.key)}"]`)
  // The control went away (confirm closed, answer sent): fall back to the row's own toggle.
  target ??= scope.querySelector<HTMLElement>('[data-focus="toggle"]')
  if (!target) return
  target.focus()
  if (target instanceof HTMLTextAreaElement && mark.start != null && mark.end != null) target.setSelectionRange(mark.start, mark.end)
}

let prevAnsweringId: string | null = null

function render(): void {
  if (root === null) return
  const mark = focusMark()
  const now = Date.now() / 1000
  root.replaceChildren(renderModel(panelModel(state, now), now))
  const answering = state.ui.answeringTaskId ?? null
  if (answering && answering !== prevAnsweringId) {
    root.querySelector<HTMLTextAreaElement>(`[data-row="${CSS.escape(answering)}"] textarea`)?.focus()
  } else if (mark) {
    restoreFocus(mark)
  }
  prevAnsweringId = answering
}

// orca global is provided by host; declare for TS
declare const orca: any

orca.plugin.on('pacer.changed', (e: { snapshot: PanelSnapshot }) => {
  dispatch({ type: 'snapshot', snapshot: e.snapshot })
})

// The worker can be restarting (reinstall, update); keep asking until it answers, as the card promises.
function loadSnapshot(): void {
  orca.plugin.request('pacer.snapshot').then((snap: PanelSnapshot) => {
    dispatch({ type: 'snapshot', snapshot: snap })
  }).catch(() => {
    dispatch({ type: 'load-error' })
    setTimeout(loadSnapshot, 3000)
  })
}
loadSnapshot()

export {}
