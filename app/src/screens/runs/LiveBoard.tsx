/**
 * Board 6: the Live board. The run's engine graph as a pannable, zoomable SVG: steps are desks, fan-out branches are
 * parallel lanes, generated plans are zones that fill in as versions are approved, and each running agent has one
 * creature at its desk. A thin client: the layout comes from `run.get` data only, messages go through `msg.send`.
 */
import { useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import styles from "./live-board.css" with { type: "text" };
import { orchestratorBlock, runAge, runPriorityLabel, runStatus, waitsOnLabel, displayRunLetter, runLettersForList } from "../../../../src/view-model/runs";
import { sentenceCase, orchestratorNeedsAttention, pausedReasonLabel } from "../../../../src/view-model/run-board";
import { markRunSeen, mergeSnapshotRuns, type RunQuestionView } from "../../data/runs";
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
import { BoardCanvas, deskWords, plannerNoteFor, zoneSummary } from "./BoardCanvas";
import { BoardViewport } from "./BoardViewport";
import { layoutLiveBoard } from "./live-board-layout";
import { executorOf, layoutInputFromDetail, nodeLabel } from "./live-board-model";
import { CHANNEL_HINTS, CHANNEL_LABELS, messageTargets, sendToTargets, type MessageChannel } from "./live-board-messages";
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

export function LiveBoard({ runId, query, outputPollMs }: { runId: string; query: RouteQuery; outputPollMs?: number }) {
  useLiveStyles();
  const { state, api, ops, detail, load } = useRunDetail(runId);
  const runner = useActions();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const agentEls = useRef(new Map<string, SVGGElement>());
  const markerId = useId();
  const [announce, setAnnounce] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [channel, setChannel] = useState<MessageChannel>("planner");
  const [whisper, setWhisper] = useState<string>("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState("");
  const [sendError, setSendError] = useState("");
  const now = state.snapshot?.at ?? Date.now() / 1000;
  const raw = detail?.run ?? null;
  const run = isObj(raw) ? raw : null;
  const questions = (detail?.questions ?? []).filter(isOpenForPerson);

  const layout = useMemo(() => detail?.run
    ? layoutLiveBoard(layoutInputFromDetail(detail, questions))
    : null,
  // eslint-disable-next-line react-hooks/exhaustive-deps -- questions derive from detail
  [detail]);

  useEffect(() => { setSelected(null); setSent(""); setSendError(""); setAnnounce(""); }, [runId]);
  // Opening the board is looking at the run: the engine stamps "last seen" and the planner may write its summary.
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (seen.current === runId) return;
    seen.current = runId;
    void markRunSeen(api, runId, ops);
  }, [api, ops, runId]);

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
          <BoardViewport content={layout} resetKey={runId} markerId={markerId}
            ariaLabel={`Run graph, ${nodes.length} ${nodes.length === 1 ? "step" : "steps"}, ${agents.length} ${agents.length === 1 ? "agent" : "agents"} working`}>
            <BoardCanvas layout={layout} markerId={markerId} agents={agents.map(a => ({ taskId: a.taskId, nodeId: a.nodeId, x: a.x, y: a.y, executor: a.executor, label: a.label }))}
              plannerIdentity={plannerName} plannerNote={plannerNoteFor(orch?.state)} selectedTaskId={selected} onOpenAgent={openAgent}
              agentRef={(id, el) => { if (el) agentEls.current.set(id, el); else agentEls.current.delete(id); }} />
          </BoardViewport>
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
