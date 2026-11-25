/**
 * Board 6: the Live board. The run's engine graph as a pannable, zoomable SVG: steps are desks, fan-out branches are
 * parallel lanes, generated plans are zones that fill in as versions are approved, and each running agent has one
 * creature at its desk. A thin client: the layout comes from `run.get` data only, messages go through `msg.send`.
 */
import { useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import styles from "./live-board.css" with { type: "text" };
import { orchestratorBlock, runAge, runPriorityLabel, runStatus, stepMarkerGlyph, stepMarkerFor, waitsOnLabel, displayRunLetter, runLettersForList } from "../../../../src/view-model/runs";
import { sentenceCase, orchestratorNeedsAttention, pausedReasonLabel } from "../../../../src/view-model/run-board";
import { mergeSnapshotRuns, type RunQuestionView } from "../../data/runs";
import { useActions } from "../../data/action-context";
import { Alert } from "../../ds/Alert";
import { Button, ButtonLink } from "../../ds/Button";
import { Field, TextArea } from "../../ds/Controls";
import { Page } from "../../ds/Page";
import { EmptyState, RadioChoices } from "../../ds/Patterns";
import { Pill } from "../../ds/Pill";
import { PageHead } from "../../shell/slots";
import type { RouteQuery } from "../../router";
import { RunQuestionCard } from "./run-shared";
import { AgentOutput } from "./AgentOutput";
import { Creature, PersonFigure, creatureHeight } from "./MascotArt";
import { DESK_H, FIGURE, STATION_H, STATION_W, layoutLiveBoard, type BoardNode } from "./live-board-layout";
import { executorOf, layoutInputFromDetail, nodeLabel, shortLabel } from "./live-board-model";
import { CHANNEL_HINTS, CHANNEL_LABELS, messageTargets, sendToTargets, type MessageChannel } from "./live-board-messages";
import { fitView, keyAction, panBy, zoomAt, ZOOM_STEP, type BoardView } from "./live-board-view";
import { liveHref, runViewHref, sessionHref } from "./live-links";
import { useRunDetail } from "./run-data";

const styled = new WeakSet<Document>();
/** Adopt the board stylesheet once per document. A missing CSSStyleSheet (bare test DOM) is not an error. */
export function useLiveStyles() {
  useEffect(() => {
    if (styled.has(document)) return;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(styles);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    } catch { /* styles are progressive here: labels and lists stay readable */ }
    styled.add(document);
  }, []);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isOpenForPerson = (q: RunQuestionView) => (q.status === undefined || q.status === "open") && (q.answerer === undefined || q.answerer === "person");

/** The words a desk shows: a glyph and a status word, never colour alone (UI-2, UI-10). */
export function deskWords(n: Pick<BoardNode, "status" | "waitsOnYou">): { glyph: string; label: string; cls: string } {
  if (n.waitsOnYou) return { glyph: stepMarkerGlyph("waits_you"), label: "Waits on you", cls: "you" };
  if (n.status === "pending") return { glyph: stepMarkerGlyph("unknown"), label: "Not started", cls: "pending" };
  const s = runStatus(n.status);
  return { glyph: stepMarkerGlyph(stepMarkerFor({ status: n.status })), label: s.label, cls: n.status };
}

const FALLBACK_VIEWPORT = { width: 960, height: 540 };

export function LiveBoard({ runId, query, outputPollMs }: { runId: string; query: RouteQuery; outputPollMs?: number }) {
  useLiveStyles();
  const { state, api, ops, detail, load } = useRunDetail(runId);
  const runner = useActions();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const agentEls = useRef(new Map<string, SVGGElement>());
  const markerId = useId();
  const [view, setView] = useState<BoardView>({ x: 0, y: 0, k: 1 });
  const [dragging, setDragging] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [channel, setChannel] = useState<MessageChannel>("planner");
  const [whisper, setWhisper] = useState<string>("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState("");
  const [sendError, setSendError] = useState("");
  const fittedFor = useRef<string | null>(null);
  const now = state.snapshot?.at ?? Date.now() / 1000;
  const raw = detail?.run ?? null;
  const run = isObj(raw) ? raw : null;
  const questions = (detail?.questions ?? []).filter(isOpenForPerson);

  const layout = useMemo(() => detail?.run
    ? layoutLiveBoard(layoutInputFromDetail(detail, questions))
    : null,
  // eslint-disable-next-line react-hooks/exhaustive-deps -- questions derive from detail
  [detail]);

  const viewportSize = () => {
    const r = viewportRef.current?.getBoundingClientRect?.();
    return r && r.width > 0 && r.height > 0 ? { width: r.width, height: r.height } : FALLBACK_VIEWPORT;
  };
  const fit = () => { if (layout) { setView(fitView(layout, viewportSize())); setAnnounce("Board fitted to the window"); } };
  useEffect(() => {
    // Fit once per run when the graph first arrives; later refreshes keep the view the person set.
    if (layout && fittedFor.current !== runId) { fittedFor.current = runId; setView(fitView(layout, viewportSize())); }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fit once when the layout first exists
  }, [layout, runId]);
  useEffect(() => { setSelected(null); setSent(""); setSendError(""); setAnnounce(""); }, [runId]);

  const tasks = state.snapshot?.tasks as ReadonlyArray<{ id: string; executor?: string | null }> | undefined;
  const agents = useMemo(() => (layout?.agents ?? []).map(a => {
    const node = layout!.nodes.find(n => n.id === a.nodeId)!;
    const executor = executorOf(a.taskId, tasks);
    return { ...a, node, executor, label: nodeLabel(node) };
  }), [layout, tasks]);
  const selectedAgent = agents.find(a => a.taskId === selected) ?? null;
  // An agent that stops working leaves the board; its output panel goes with it.
  useEffect(() => { if (selected && !selectedAgent && detail?.run) setSelected(null); }, [selected, selectedAgent, detail?.run]);
  const whisperTask = agents.some(a => a.taskId === whisper) ? whisper : selectedAgent?.taskId ?? agents[0]?.taskId ?? "";

  const orchTaskId = typeof run?.orchestratorTaskId === "string" ? run.orchestratorTaskId : "";
  const orch = isObj(run?.orchestrator) ? run!.orchestrator as { state?: string; planner?: string; reason?: string; next_wake_at?: number } : undefined;
  const plannerName = orch?.planner ? `planner:${orch.planner}` : "planner";
  const canMessage = ops.has("msg.send") && (!!orchTaskId || agents.length > 0);
  const canAnswer = ops.has("question.answer");

  const act = (a: ReturnType<typeof keyAction>) => {
    if (!a) return;
    const size = viewportSize();
    if (a.type === "pan") { setView(v => panBy(v, a.dx, a.dy)); return; }
    if (a.type === "fit") { fit(); return; }
    setView(v => {
      const next = zoomAt(v, a.factor, size.width / 2, size.height / 2);
      return next;
    });
  };
  const zoomPct = Math.round(view.k * 100);
  useEffect(() => { if (layout) setAnnounce(`Zoom ${zoomPct}%`); /* announce zoom only */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomPct]);

  const onKeyDown = (e: KeyboardEvent) => {
    const a = keyAction(e);
    if (!a) return;
    e.preventDefault();
    act(a);
  };
  const isAgentTarget = (t: EventTarget | null) => !!(t as Element | null)?.closest?.("[data-agent]");
  const onPointerDown = (e: PointerEvent) => {
    if ((e.button ?? 0) !== 0 || isAgentTarget(e.target)) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    drag.current = { ...d, x: e.clientX, y: e.clientY };
    setView(v => panBy(v, dx, dy));
  };
  const endDrag = (e: PointerEvent) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
  };
  const onWheel = (e: WheelEvent) => {
    // A plain wheel scrolls the page; a pinch or Ctrl/Cmd wheel zooms at the pointer.
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const r = viewportRef.current?.getBoundingClientRect?.();
    setView(v => zoomAt(v, e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, e.clientX - (r?.left ?? 0), e.clientY - (r?.top ?? 0)));
  };

  const openAgent = (taskId: string) => {
    setSelected(taskId);
    setWhisper(taskId);
    const a = agents.find(x => x.taskId === taskId);
    setAnnounce(a ? `Showing live output of ${a.executor} on ${a.label}` : "");
  };
  const closeOutput = () => {
    const id = selected;
    setSelected(null);
    setAnnounce("Live output closed");
    // Focus goes back to the agent that opened the panel, so keyboard users keep their place on the board.
    queueMicrotask(() => { if (id) agentEls.current.get(id)?.focus(); });
  };

  const send = async () => {
    const text = body.trim();
    if (!text || sending) return;
    const targets = messageTargets(channel, { orchestratorTaskId: orchTaskId || undefined, agentTaskIds: agents.map(a => a.taskId), whisperTaskId: whisperTask || undefined });
    if (!targets.ok) { setSendError(targets.reason); setSent(""); return; }
    setSending(true); setSendError(""); setSent("");
    const call = runner ? <T,>(op: string, params?: unknown) => runner.call<T>(op, params) : api.call.bind(api);
    const outcome = await sendToTargets((to, b) => call("msg.send", { to, body: b }), targets.to, text);
    setSending(false);
    if (!outcome.failed.length) {
      setBody("");
      setSent(channel === "planner" ? "Message sent to the planner."
        : channel === "whisper" ? "Message sent to the agent."
          : `Message sent to ${outcome.sent.length} ${outcome.sent.length === 1 ? "recipient" : "recipients"}.`);
    } else {
      setSendError(`${outcome.failed.length} of ${targets.to.length} could not be reached: ${outcome.failed[0]!.message}`);
      if (outcome.sent.length) setSent(`Sent to ${outcome.sent.length}.`);
    }
    void load();
  };

  // Header facts
  const snapRun = state.snapshot?.runs?.find(r => r.id === runId);
  const letter = runLettersForList(mergeSnapshotRuns([], state.snapshot?.runs)).get(runId) ?? displayRunLetter({ id: runId, letter: snapRun?.letter });
  const pausedReason = typeof run?.pausedReason === "string" ? run.pausedReason : typeof snapRun?.paused_reason === "string" ? snapRun.paused_reason : undefined;
  const status = runStatus(pausedReason ? "paused" : String(run?.status ?? "running"));
  const title = typeof run?.title === "string" && run.title ? run.title : typeof run?.workflow === "string" ? run.workflow : runId;
  const waits = snapRun?.waits_on ?? (questions.length ? "you" : status.label === "Waiting" ? "orchestrator" : "-");
  const createdAt = typeof run?.createdAt === "number" ? run.createdAt : 0;
  const orchLine = sentenceCase(orchestratorBlock(orch, now));
  const unavailable = !ops.has("run.get");
  const nodes = layout?.nodes ?? [];
  const agentByNode = new Map(agents.map(a => [a.nodeId, a]));

  return <>
    <PageHead>
      <header className="lb-header">
        <div className="lb-heading"><h1 ref={headingRef} tabIndex={-1}>{title}</h1></div>
        <div className="lb-links">
          <ButtonLink typography="board" size="sm" href={runViewHref(runId, query)}>Run view</ButtonLink>
          <ButtonLink typography="board" size="sm" href={liveHref(runId, "journey", query)}>Replay journey</ButtonLink>
          <ButtonLink typography="board" size="sm" href={liveHref(undefined, undefined, query)}>All runs</ButtonLink>
        </div>
      </header>
    </PageHead>
    <p className="sr-only" role="status" aria-live="polite">{announce}</p>
    <Page width="full" className="lb" aria-label={`Live board for run ${letter}`}>
      {unavailable && <EmptyState title="Live board unavailable" description="This service does not offer run.get yet." />}
      {detail?.error && !raw && (
        <Alert tone="error" title="Couldn't load this run">
          <p>{detail.error}</p>
          <Button size="sm" onClick={() => { void load(); }}>Try again</Button>
        </Alert>
      )}
      {detail?.error && raw && (
        <Alert tone="warning" title="This board may be out of date">
          <p>The last refresh failed, so you are seeing the version loaded earlier.</p>
          <Button size="sm" onClick={() => { void load(); }}>Try again</Button>
        </Alert>
      )}
      {!unavailable && !raw && !detail?.error && <p className="lb-cap" role="status">Loading the board…</p>}
      {layout && run && <>
        <div className="lb-facts" role="group" aria-label="Run facts">
          <span className="pc-run-letter" role="img" aria-label={`Run ${letter}`}>{letter}</span>
          <Pill tone={status.tone}><span aria-hidden="true">{status.glyph} </span>{status.label}</Pill>
          <span>Priority: {runPriorityLabel(typeof run.priority === "string" ? run.priority : undefined)}</span>
          <span>Waits on: {waitsOnLabel(waits)}</span>
          <span>Started {runAge(createdAt, now)}</span>
        </div>
        {pausedReason ? <Alert tone="warning" title={pausedReasonLabel(pausedReason)}><p>Steps already running finish; nothing new starts until the run resumes.</p></Alert> : null}
        {orchestratorNeedsAttention(orch)
          ? <Alert tone="warning" title={orch?.state === "retrying" ? "The planner is retrying" : "The planner is blocked"}><p>{orchLine}</p></Alert>
          : <p className="lb-cap">{orchLine}</p>}

        <section className="lb-section" aria-label="Live board">
          <div className="lb-toolbar" role="group" aria-label="Board view">
            <Button size="sm" onClick={() => act({ type: "zoom", factor: 1 / ZOOM_STEP })}>Zoom out</Button>
            <Button size="sm" onClick={() => act({ type: "zoom", factor: ZOOM_STEP })}>Zoom in</Button>
            <Button size="sm" variant="quiet" onClick={() => act({ type: "fit" })}>Fit board</Button>
            <span className="lb-cap" data-zoom>{zoomPct}%</span>
          </div>
          <p className="lb-cap" id={`${markerId}-hint`}>Drag to pan. With the board focused, arrow keys pan (Shift for further), + and - zoom, 0 fits the board.</p>
          <div
            ref={viewportRef}
            className={`lb-viewport${dragging ? " is-dragging" : ""}`}
            tabIndex={0}
            role="group"
            aria-roledescription="pannable board"
            aria-label={`Run graph, ${nodes.length} ${nodes.length === 1 ? "step" : "steps"}, ${agents.length} ${agents.length === 1 ? "agent" : "agents"} working`}
            aria-describedby={`${markerId}-hint`}
            onKeyDown={onKeyDown}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onWheel={onWheel}
          >
            <svg className="lb-svg" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <marker id={`${markerId}-arrow`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                  <path className="lb-arrow" d="M0 0 L8 4 L0 8 z" />
                </marker>
              </defs>
              <g className="lb-world" data-world transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
                {/* The planner's place, and the person's: stations, not graph nodes. */}
                <g transform={`translate(${layout.planner.x} ${layout.planner.y})`} data-station="planner">
                  <rect className="lb-station-box" width={STATION_W} height={STATION_H} />
                  <Creature identity={plannerName} x={12} y={STATION_H - creatureHeight(40) - 10} size={40} planner />
                  <text className="lb-station-label" x={64} y={34}>Planner</text>
                  <text className="lb-station-note" x={64} y={52}>{shortLabel(orch?.state ? sentenceCase(orch.state) : "Idle", 14)}</text>
                </g>
                {layout.person.at === null ? (
                  <g transform={`translate(${layout.person.x} ${layout.person.y})`} data-station="person">
                    <rect className="lb-station-box" width={STATION_W} height={STATION_H} />
                    <PersonFigure x={12} y={STATION_H - creatureHeight(40) - 10} size={40} />
                    <text className="lb-station-label" x={64} y={34}>You</text>
                    <text className="lb-station-note" x={64} y={52}>Nothing waits on you</text>
                  </g>
                ) : null}
                {layout.zones.map(z => (
                  <g key={z.id} data-zone={z.id}>
                    <rect className={`lb-zone${z.approved ? " lb-zone--filled" : ""}`} x={z.x} y={z.y} width={z.w} height={z.h} rx="8" />
                    <text className="lb-zone-label" x={z.x + 12} y={z.y + 20}>Generated plan · {shortLabel(z.stepId, 20)}</text>
                    <text className="lb-zone-note" x={z.x + 12} y={z.y + 38}>{zoneSummary(z)}</text>
                  </g>
                ))}
                {layout.bands.map(b => (
                  <g key={b.id}>
                    <rect className="lb-band" x={b.x} y={b.y} width={b.w} height={b.h} rx="8" />
                    <text className="lb-band-label" x={b.x + 12} y={b.y + 18}>Fan-out · {shortLabel(b.stepId, 18)} · {b.lanes} {b.lanes === 1 ? "lane" : "lanes"}</text>
                  </g>
                ))}
                {layout.edges.map(e => {
                  const mid = Math.max(24, (e.x2 - e.x1) / 2);
                  return <path key={e.id} className="lb-edge" data-edge={e.id} d={`M${e.x1} ${e.y1} C${e.x1 + mid} ${e.y1} ${e.x2 - mid} ${e.y2} ${e.x2} ${e.y2}`} markerEnd={`url(#${markerId}-arrow)`} />;
                })}
                {nodes.map(n => {
                  const words = deskWords(n);
                  const agent = agentByNode.get(n.id);
                  return (
                    <g key={n.id} className={`lb-desk lb-desk--${words.cls}`} data-node={n.id} transform={`translate(${n.x} ${n.y})`}>
                      <rect className="lb-desk-box" width={n.w} height={n.h} />
                      <text className="lb-desk-label" x={10} y={22}>{shortLabel(nodeLabel(n))}</text>
                      <text className="lb-desk-state" x={agent ? FIGURE + 18 : 10} y={n.h - 16}>{words.glyph} {words.label}</text>
                    </g>
                  );
                })}
                {layout.person.at !== null ? (
                  <g data-station="person" data-at={layout.person.at}>
                    <PersonFigure x={layout.person.x} y={layout.person.y} size={FIGURE} />
                    <text className="lb-station-label" x={layout.person.x - 30} y={layout.person.y + 22}>You</text>
                  </g>
                ) : null}
                {agents.map(a => (
                  <g
                    key={a.taskId}
                    className="lb-agent"
                    data-agent={a.taskId}
                    ref={(el: SVGGElement | null) => { if (el) agentEls.current.set(a.taskId, el); else agentEls.current.delete(a.taskId); }}
                    role="button"
                    tabindex={0}
                    aria-pressed={selected === a.taskId}
                    aria-label={`${a.executor} working on ${a.label}. Open live output`}
                    onClick={() => openAgent(a.taskId)}
                    onKeyDown={(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openAgent(a.taskId); } }}
                  >
                    <rect className="lb-agent-ring" x={a.x - 3} y={a.y - 3} width={FIGURE + 6} height={creatureHeight(FIGURE) + 6} />
                    <Creature identity={a.executor} x={a.x} y={a.y} size={FIGURE} />
                  </g>
                ))}
              </g>
            </svg>
          </div>
        </section>

        {selectedAgent ? (
          <AgentOutput api={api} taskId={selectedAgent.taskId} executor={selectedAgent.executor} stepLabel={selectedAgent.label}
            sessionHref={sessionHref(selectedAgent.taskId, query)} onClose={closeOutput} {...(outputPollMs ? { pollMs: outputPollMs } : {})} />
        ) : null}

        <section className="lb-section" aria-labelledby={`${markerId}-agents`}>
          <h2 className="lb-title" id={`${markerId}-agents`}>Agents at work</h2>
          {agents.length === 0 ? <p className="lb-cap">No agent is working on this run right now.</p> : (
            <ul className="lb-list">
              {agents.map(a => (
                <li key={a.taskId} className="lb-item">
                  <Button size="sm" variant={selected === a.taskId ? "secondary" : "quiet"} aria-pressed={selected === a.taskId} onClick={() => openAgent(a.taskId)}>
                    Open live output
                  </Button>
                  <span className="lb-item-name">{a.executor}</span>
                  <span className="lb-cap">working on {a.label}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {questions.length ? (
          <section className="lb-section" aria-label="Needs your answer">
            <h2 className="lb-title">Needs your answer</h2>
            {questions.map(q => (
              <RunQuestionCard key={q.id} question={q} canAnswer={canAnswer} api={api}
                onAnswered={() => { setAnnounce("Answer submitted"); queueMicrotask(() => headingRef.current?.focus({ preventScroll: true })); void load(); }}
                onConflict={() => { setAnnounce("This question changed. Showing the latest version."); void load(); }} />
            ))}
          </section>
        ) : null}

        {canMessage ? (
          <section className="lb-section" aria-labelledby={`${markerId}-send`}>
            <h2 className="lb-title" id={`${markerId}-send`}>Message</h2>
            <form className="lb-send" onSubmit={e => { e.preventDefault(); void send(); }}>
              <RadioChoices label="Send to" name={`${markerId}-lane`} value={channel} onChange={v => { setChannel(v as MessageChannel); setSendError(""); setSent(""); }}
                options={(["party", "whisper", "planner"] as const).map(c => ({ value: c, label: CHANNEL_LABELS[c], disabled: (c === "planner" && !orchTaskId) || (c === "whisper" && agents.length === 0) }))} />
              <p className="lb-cap">{CHANNEL_HINTS[channel]}</p>
              {channel === "whisper" && agents.length > 0 ? (
                <RadioChoices label="Agent" name={`${markerId}-agent`} value={whisperTask} onChange={setWhisper}
                  options={agents.map(a => ({ value: a.taskId, label: `${a.executor} · ${a.label}` }))} />
              ) : null}
              <Field label="Message">
                <TextArea value={body} rows={3} maxLength={4000} onInput={e => setBody((e.currentTarget as HTMLTextAreaElement).value)} />
              </Field>
              <div className="lb-row">
                <Button type="submit" size="sm" variant="secondary" disabled={sending || !body.trim()}>
                  {sending ? "Sending…" : channel === "planner" ? "Send to planner" : channel === "whisper" ? "Send to agent" : "Send to everyone"}
                </Button>
                {!body.trim() && !sending ? <span className="lb-cap">Write a message to send it</span> : null}
              </div>
              <p className="lb-cap" role="status" aria-live="polite">{sent}</p>
              {sendError ? <p className="lb-cap" role="alert">{sendError}</p> : null}
            </form>
          </section>
        ) : null}

        <section className="lb-section" aria-labelledby={`${markerId}-steps`}>
          <h2 className="lb-title" id={`${markerId}-steps`}>Steps on the board</h2>
          {nodes.length === 0 ? <p className="lb-cap">No steps have started yet.</p> : (
            <ul className="lb-list">
              {nodes.map(n => {
                const w = deskWords(n);
                const agent = agentByNode.get(n.id);
                return (
                  <li key={n.id} className="lb-item" data-step-item={n.id}>
                    <span className="lb-item-name">{nodeLabel(n)}</span>
                    <Pill tone={n.waitsOnYou ? "warn" : runStatus(n.status).tone}><span aria-hidden="true">{w.glyph} </span>{w.label}</Pill>
                    {agent ? <span className="lb-cap">{agent.executor} is on it</span> : null}
                  </li>
                );
              })}
              {layout.zones.map(z => <li key={z.id} className="lb-item"><span className="lb-item-name">Generated plan · {z.stepId}</span><span className="lb-cap">{zoneSummary(z)}</span></li>)}
            </ul>
          )}
        </section>
      </>}
    </Page>
  </>;
}

/** What a zone says about its versions: the engine's own version statuses, in plain words. */
export function zoneSummary(z: { versions: Array<{ version: number; status: string; stepCount: number }>; approved: number; drawn: number }): string {
  if (!z.versions.length) return "No plan yet";
  const latest = z.versions[z.versions.length - 1]!;
  const head = `v${latest.version} ${latest.status} · ${latest.stepCount} ${latest.stepCount === 1 ? "step" : "steps"}`;
  if (!z.approved) return `${head} · not approved yet`;
  return `${head} · ${z.drawn} ${z.drawn === 1 ? "step" : "steps"} started`;
}
