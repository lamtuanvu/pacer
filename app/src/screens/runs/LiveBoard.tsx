/**
 * Board 6: the Live board. The run's engine graph as a pannable, zoomable SVG: steps are desks, fan-out branches are
 * parallel lanes, generated plans are zones that fill in as versions are approved, and each running agent has one
 * creature at its desk. A thin client: the layout comes from `run.get` data only, messages go through `msg.send`.
 */
import { useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import styles from "./live-board.css" with { type: "text" };
import { orchestratorBlock, pausedReasonLabel, runAge, runPriorityLabel, runStatus, waitsOnLabel, RUN_QUESTIONS_ERROR, RUN_SEEN_ERROR } from "../../../../src/view-model/runs";
import { sentenceCase, orchestratorNeedsAttention } from "../../../../src/view-model/run-board";
import type { RunQuestionView } from "../../data/runs";
import { useActions } from "../../data/action-context";
import { Alert } from "../../ds/Alert";
import { Button, ButtonLink } from "../../ds/Button";
import { Field, TextArea } from "../../ds/Controls";
import { Page } from "../../ds/Page";
import { EmptyState, RadioChoices } from "../../ds/Patterns";
import { Pill } from "../../ds/Pill";
import { SectionHeading } from "../../ds/SectionHeading";
import { PageHead } from "../../shell/slots";
import type { RouteQuery } from "../../router";
import { RunLoadAlerts, RunQuestionCard } from "./run-shared";
import { AgentOutput } from "./AgentOutput";
import { BoardCanvas, deskWords, plannerNoteFor, zoneSummary } from "./BoardCanvas";
import { BoardViewport } from "./BoardViewport";
import { FIGURE, layoutLiveBoard } from "./live-board-layout";
import { executorName, executorOf, layoutInputFromDetail, nodeLabel } from "./live-board-model";
import { CHANNEL_HINTS, CHANNEL_LABELS, messageTargets, sendToTargets, summarizeSend, type MessageChannel } from "./live-board-messages";
import { liveHref, runViewHref, sessionHref } from "./live-links";
import { runIdentity, useRetryFocus, useRunDetail, useRunSeen } from "./run-data";

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

export function LiveBoard({ runId, query, outputPollMs }: { runId: string; query: RouteQuery; outputPollMs?: number }) {
  useLiveStyles();
  const seen = useRunSeen(runId);
  const { state, api, ops, store, detail, load } = useRunDetail(runId);
  const runner = useActions();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const agentEls = useRef(new Map<string, SVGGElement>());
  const markerId = useId();
  const [announce, setAnnounce] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  /** The lane and the agent are kept as chosen: a message is never quietly sent somewhere else. */
  const [channel, setChannel] = useState<MessageChannel | null>(null);
  const [whisper, setWhisper] = useState<string>("");
  const [reveal, setReveal] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const sendingRef = useRef(false);
  /** One request id per recipient and text, so sending the same text again cannot store it twice. */
  const requests = useRef(new Map<string, string>());
  const outputClose = useRef<HTMLButtonElement | null>(null);
  const panelAgent = useRef<{ taskId: string; name: string; label: string } | null>(null);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState("");
  const [sendError, setSendError] = useState("");
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const now = state.snapshot?.at ?? Date.now() / 1000;
  const raw = detail?.run ?? null;
  const run = isObj(raw) ? raw : null;
  const questions = (detail?.questions ?? []).filter(isOpenForPerson);

  const layout = useMemo(() => detail?.run
    ? layoutLiveBoard(layoutInputFromDetail(detail, questions))
    : null,
  // eslint-disable-next-line react-hooks/exhaustive-deps -- questions derive from detail
  [detail]);

  useEffect(() => { setSelected(null); setSent(""); setSendError(""); setAnnounce(""); setChannel(null); setWhisper(""); }, [runId]);
  const tasks = state.snapshot?.tasks as ReadonlyArray<{ id: string; executor?: string | null }> | undefined;
  const agents = useMemo(() => (layout?.agents ?? []).map(a => {
    const node = layout!.nodes.find(n => n.id === a.nodeId)!;
    const executor = executorOf(a.taskId, tasks);
    return { ...a, node, executor, name: executorName(executor), label: nodeLabel(node) };
  }), [layout, tasks]);
  const selectedAgent = agents.find(a => a.taskId === selected) ?? null;
  // An agent that stops working leaves the board; its output panel stays, with its last output, until closed.
  if (selectedAgent) panelAgent.current = { taskId: selectedAgent.taskId, name: selectedAgent.name, label: selectedAgent.label };
  const panel = selected && panelAgent.current?.taskId === selected ? panelAgent.current : null;
  // Read before the page updates: the agent that holds focus may be about to leave the board.
  const focusedAgent = useRef<string | null>(null);
  focusedAgent.current = typeof document === "undefined" ? null
    : document.activeElement?.getAttribute?.("data-agent") ?? document.activeElement?.getAttribute?.("data-agent-open") ?? null;
  useEffect(() => {
    const held = focusedAgent.current;
    if (!held || agents.some(a => a.taskId === held)) return;
    ((held === selected ? outputClose.current : null) ?? headingRef.current)?.focus({ preventScroll: true });
  }, [agents]);
  const orchTaskId = typeof run?.orchestratorTaskId === "string" ? run.orchestratorTaskId : "";
  const orch = isObj(run?.orchestrator) ? run!.orchestrator as { state?: string; planner?: string; reason?: string; next_wake_at?: number } : undefined;
  const plannerName = orch?.planner ? `planner:${orch.planner}` : "planner";
  // A chosen lane stays on screen even when nobody is left, so the page can say why it cannot send.
  const canMessage = ops.has("msg.send") && (!!orchTaskId || agents.length > 0 || channel !== null);
  const canAnswer = ops.has("question.answer");
  const canOpen = ops.has("task.log");
  const disabledLane: Record<MessageChannel, boolean> = { party: !orchTaskId && agents.length === 0, whisper: agents.length === 0, planner: !orchTaskId };
  const defaultLane = (["planner", "party", "whisper"] as const).find(c => !disabledLane[c]) ?? null;
  const lane: MessageChannel = channel ?? defaultLane ?? "planner";
  // The default is pinned once shown, so a later refresh cannot move a half-written message to another lane.
  useEffect(() => { if (channel === null && canMessage && defaultLane) setChannel(defaultLane); }, [channel, canMessage, defaultLane]);
  // New words or a new lane make a new message: it gets new request ids.
  const chooseLane = (next: MessageChannel) => {
    requests.current.clear();
    setChannel(next); setSendError(""); setSent("");
    if (next === "whisper" && !whisper) setWhisper(selectedAgent?.taskId ?? agents[0]?.taskId ?? "");
  };
  useEffect(() => { if (lane === "whisper" && !whisper && agents[0]) setWhisper(selected ?? agents[0].taskId); }, [lane, whisper, agents, selected]);
  const targetContext = { orchestratorTaskId: orchTaskId || undefined, agentTaskIds: agents.map(a => a.taskId), whisperTaskId: whisper || undefined };
  const laneTargets = messageTargets(lane, targetContext);

  const openAgent = (taskId: string) => {
    setSelected(taskId);
    setWhisper(taskId);
    const a = agents.find(x => x.taskId === taskId);
    setAnnounce(a ? `Showing live output of ${a.name} on ${a.label}` : "");
  };
  const closeOutput = () => {
    const id = selected;
    setSelected(null);
    setAnnounce("Live output closed");
    // Focus goes back to the agent that opened the panel, or to the title when it has left the board.
    queueMicrotask(() => { if (id) (agentEls.current.get(id) ?? headingRef.current)?.focus(); });
  };

  const send = async () => {
    const text = body.trim();
    if (!text || sendingRef.current) return;
    const targets = messageTargets(lane, targetContext);
    // The disabled button already says why.
    if (!targets.ok) return;
    sendingRef.current = true;
    const typed = body;
    setSending(true); setSendError(""); setSent("");
    const call = runner ? <T,>(op: string, params?: unknown) => runner.call<T>(op, params) : api.call.bind(api);
    const requestId = (to: string, b: string) => {
      const key = `${to}\0${b}`;
      const held = requests.current.get(key) ?? crypto.randomUUID();
      requests.current.set(key, held);
      return held;
    };
    const outcome = await sendToTargets((to, b) => call("msg.send", { to, body: b, request_id: requestId(to, b) }), targets.to, text);
    sendingRef.current = false;
    setSending(false);
    const summary = summarizeSend(outcome.results);
    // The text stays in the box while any recipient refused it; anything typed meanwhile stays too.
    if (outcome.results.every(r => !r.refusal)) {
      requests.current.clear();
      // Only words typed after the sent ones are separated out; an edit that changed the last word stays whole.
      setBody(current => {
        const rest = current.startsWith(typed) ? current.slice(typed.length) : null;
        return rest !== null && /^(\s|$)/.test(rest) ? rest.trimStart() : current;
      });
      // Send disables itself once the box is empty; focus goes back to the box, not nowhere.
      queueMicrotask(() => messageRef.current?.focus());
    }
    if (summary.problem) setSendError(summary.text); else setSent(summary.text);
    void load();
  };

  // Header facts
  const snapRun = state.snapshot?.runs?.find(r => r.id === runId);
  const { letter, runName, title } = runIdentity(runId, run, store.list, state.snapshot?.runs);
  const pausedReason = typeof run?.pausedReason === "string" ? run.pausedReason : typeof snapRun?.paused_reason === "string" ? snapRun.paused_reason : undefined;
  const status = runStatus(pausedReason ? "paused" : String(run?.status ?? "running"));
  const waits = snapRun?.waits_on ?? (questions.length ? "you" : status.label === "Waiting" ? "orchestrator" : "-");
  const createdAt = typeof run?.createdAt === "number" ? run.createdAt : 0;
  const orchLine = sentenceCase(orchestratorBlock(orch, now));
  const unavailable = !ops.has("run.get");
  const retry = useRetryFocus(headingRef);
  const nodes = layout?.nodes ?? [];
  // The You station says nothing waits only when the questions were read and none is open.
  const personNote = detail?.error === RUN_QUESTIONS_ERROR ? "Questions not loaded"
    : questions.length ? "A question waits for you"
      : detail?.error ? "May be out of date" : "Nothing waits on you";
  const agentByNode = new Map(agents.map(a => [a.nodeId, a]));

  return <>
    <PageHead>
      <header className="lb-header">
        <div className="lb-heading"><h1 ref={headingRef} tabIndex={-1}>{title}</h1></div>
        <div className="lb-links">
          <ButtonLink typography="board" size="sm" href={runViewHref(runId, query)}>Run view</ButtonLink>
          <ButtonLink typography="board" size="sm" href={liveHref(runId, "journey", query)}>Replay journey</ButtonLink>
          <ButtonLink typography="board" size="sm" href={liveHref(undefined, undefined, query)}>Several runs</ButtonLink>
        </div>
      </header>
    </PageHead>
    <p className="sr-only" role="status" aria-live="polite">{announce}</p>
    <Page width="full" className="lb" aria-label={letter ? `Live board for run ${letter}` : "Live board"}>
      {unavailable && <EmptyState title="Live board unavailable" description="This service does not offer run.get yet." />}
      <RunLoadAlerts error={detail?.error} loaded={!!raw} staleTitle="This board may be out of date" onRetry={e => { void retry(e.currentTarget, load); }} />
      {seen.failed ? (
        <Alert tone="error" title={RUN_SEEN_ERROR}>
          <Button size="sm" onClick={e => { void retry(e.currentTarget, seen.markSeen); }}>Mark as seen</Button>
        </Alert>
      ) : null}
      {!unavailable && !raw && !detail?.error && <p className="lb-cap" role="status">Loading the board…</p>}
      {layout && run && <>
        <div className="lb-facts" role="group" aria-label="Run facts">
          {letter ? <span className="pc-run-letter" role="img" aria-label={runName}>{letter}</span> : null}
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
          <BoardViewport content={layout} resetKey={runId} markerId={markerId} reveal={reveal}
            ariaLabel={`Run graph, ${nodes.length} ${nodes.length === 1 ? "step" : "steps"}, ${agents.length} ${agents.length === 1 ? "agent" : "agents"} working`}>
            <BoardCanvas layout={layout} markerId={markerId} agents={agents.map(a => ({ taskId: a.taskId, nodeId: a.nodeId, x: a.x, y: a.y, executor: a.executor, name: a.name, label: a.label }))}
              plannerIdentity={plannerName} plannerNote={plannerNoteFor(orch?.state)} personNote={personNote} selectedTaskId={selected} onOpenAgent={canOpen ? openAgent : undefined}
              onFocusAgent={id => { const a = agents.find(x => x.taskId === id); if (a) setReveal({ x: a.x, y: a.y, w: FIGURE, h: FIGURE }); }}
              agentRef={(id, el) => { if (el) agentEls.current.set(id, el); else agentEls.current.delete(id); }} />
          </BoardViewport>
        </section>

        {panel && canOpen ? (
          <AgentOutput key={panel.taskId} api={api} taskId={panel.taskId} executor={panel.name} stepLabel={panel.label} left={!selectedAgent} closeRef={outputClose}
            sessionHref={sessionHref(panel.taskId, query)} onClose={closeOutput} {...(outputPollMs ? { pollMs: outputPollMs } : {})} />
        ) : null}

        <section className="lb-section" aria-labelledby={`${markerId}-agents`}>
          <SectionHeading id={`${markerId}-agents`}>Agents at work</SectionHeading>
          {agents.length === 0 ? <p className="lb-cap">No agent is working on this run right now.</p> : (
            <ul className="lb-list">
              {agents.map(a => (
                <li key={a.taskId} className="lb-item">
                  {canOpen ? (
                    <Button size="sm" data-agent-open={a.taskId} variant={selected === a.taskId ? "secondary" : "quiet"} aria-pressed={selected === a.taskId} aria-label={`Open live output of ${a.name} on ${a.label}`} onClick={() => openAgent(a.taskId)}>
                      Open live output
                    </Button>
                  ) : null}
                  <span className="lb-item-name">{a.name}</span>
                  <span className="lb-cap">working on {a.label}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {questions.length ? (
          <section className="lb-section" aria-label="Needs your answer">
            <SectionHeading>Needs your answer</SectionHeading>
            {questions.map(q => (
              <RunQuestionCard key={q.id} question={q} canAnswer={canAnswer} api={api}
                onAnswered={() => { setAnnounce("Answer submitted"); queueMicrotask(() => headingRef.current?.focus({ preventScroll: true })); void load(); }}
                onConflict={() => { setAnnounce("This question changed. Showing the latest version."); void load(); }} />
            ))}
          </section>
        ) : null}

        {canMessage ? (
          <section className="lb-section" aria-labelledby={`${markerId}-send`}>
            <SectionHeading id={`${markerId}-send`}>Message</SectionHeading>
            <form className="lb-send" onSubmit={e => { e.preventDefault(); void send(); }}>
              <RadioChoices label="Send to" name={`${markerId}-lane`} value={lane} onChange={v => chooseLane(v as MessageChannel)}
                options={(["party", "whisper", "planner"] as const).map(c => ({ value: c, label: CHANNEL_LABELS[c], disabled: disabledLane[c] }))} />
              <p className="lb-cap">{CHANNEL_HINTS[lane]}</p>
              {lane === "whisper" && agents.length > 0 ? (
                <RadioChoices label="Agent" name={`${markerId}-agent`} value={whisper} onChange={v => { requests.current.clear(); setWhisper(v); setSendError(""); }}
                  options={agents.map(a => ({ value: a.taskId, label: `${a.name} · ${a.label}` }))} />
              ) : null}
              <Field label="Your message">
                <TextArea ref={messageRef} value={body} rows={3} maxLength={4000} onInput={e => { requests.current.clear(); setBody((e.currentTarget as HTMLTextAreaElement).value); }} />
              </Field>
              <div className="lb-row">
                <Button type="submit" size="sm" variant="secondary" disabled={sending || !body.trim() || !laneTargets.ok}>
                  {sending ? "Sending…" : lane === "planner" ? "Send to planner" : lane === "whisper" ? "Send to agent" : "Send to everyone"}
                </Button>
                {/* Always present, so the reason is announced when it appears. */}
                <span className={laneTargets.ok ? "sr-only" : "lb-cap"} role="status">{laneTargets.ok ? "" : laneTargets.reason}</span>
                {laneTargets.ok && !body.trim() && !sending ? <span className="lb-cap">Write a message to send it</span> : null}
              </div>
              <p className="lb-cap" role="status" aria-live="polite">{sent}</p>
              {sendError ? <p className="lb-cap" role="alert">{sendError}</p> : null}
            </form>
          </section>
        ) : null}

        <section className="lb-section" aria-labelledby={`${markerId}-steps`}>
          <SectionHeading id={`${markerId}-steps`}>Steps on the board</SectionHeading>
          {nodes.length === 0 ? <p className="lb-cap">No steps have started yet.</p> : (
            <ul className="lb-list">
              {nodes.map(n => {
                const w = deskWords(n);
                const agent = agentByNode.get(n.id);
                return (
                  <li key={n.id} className="lb-item" data-step-item={n.id}>
                    <span className="lb-item-name">{nodeLabel(n)}</span>
                    <Pill tone={n.waitsOnYou ? "warn" : runStatus(n.status).tone}><span aria-hidden="true">{w.glyph} </span>{w.label}</Pill>
                    {agent ? <span className="lb-cap">{agent.name} is on it</span> : null}
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
