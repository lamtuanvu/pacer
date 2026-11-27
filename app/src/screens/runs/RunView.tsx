/** One run (boards 1-5). A thin client: every fact is read from `run.get`, `question.list` and `msg.log`. */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { RunDetail } from "../../../../src/dashboard/screens/types";
import {
  boardAvailability, conversationRail, orchestratorNeedsAttention, executionWaves, pickSpecArtifact, artifactMetas,
  reviewerPanels, sentenceCase, stripSteps, testsAndPr, type BoardChild, type BoardInput, type BoardMessage, type BoardQuestion,
} from "../../../../src/view-model/run-board";
import {
  orchestratorBlock, pausedReasonLabel, runAge, runPriorityLabel, runStatus, waitsOnLabel, awaitsVerdict,
  RUN_QUESTIONS_ERROR, RUN_SEEN_ERROR,
} from "../../../../src/view-model/runs";
import { attentionStatus } from "../../../../src/view-model/words";
import type { RunQuestionView } from "../../data/runs";
import { runIdentity, useRetryFocus, useRunDetail, useRunSeen } from "./run-data";
import { useActions } from "../../data/action-context";
import { ActionButton } from "../ActionButton";
import { Alert } from "../../ds/Alert";
import { Button, ButtonLink } from "../../ds/Button";
import { Page } from "../../ds/Page";
import { EmptyState } from "../../ds/Patterns";
import { Pill } from "../../ds/Pill";
import { FrameSlot, PageHead, useFrame } from "../../shell/slots";
import { withQuery, type RouteQuery } from "../../router";
import { liveHref } from "./live-links";
import { useTaskContext } from "../task-shared";
import { BoardButton, RunQuestionCard, useRunViewStyles, ArtifactLink, ArtifactText, type FetchText } from "./run-shared";
import { RunStrip } from "./RunStrip";
import { ConversationRail } from "./ConversationRail";
import { BrainstormBoard } from "./BrainstormBoard";
import { ReviewerPanel } from "./ReviewerPanel";
import { ExecutionWaves } from "./ExecutionWaves";
import { TestsAndPr } from "./TestsAndPr";

type BoardId = "overview" | "brainstorm" | "review" | "execution" | "tests";
const BOARD_LABELS: Record<BoardId, string> = {
  overview: "Overview", brainstorm: "Brainstorm", review: "Reviewers", execution: "Execution", tests: "Tests and PR",
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function artifactFromHash(): string | null {
  try { return new URLSearchParams(location.hash.split("?")[1] ?? "").get("artifact"); } catch { return null; }
}

const isOpenForPerson = (q: RunQuestionView) => (q.status === undefined || q.status === "open") && (q.answerer === undefined || q.answerer === "person");

export function RunView({ runId, query, fetchText }: { runId: string; query: RouteQuery; fetchText?: FetchText }) {
  useRunViewStyles();
  const { state, api } = useTaskContext();
  const runner = useActions();
  const frame = useFrame();
  const ops = state.features.ops;
  const now = state.snapshot?.at ?? Date.now() / 1000;
  const [board, setBoard] = useState<BoardId>("overview");
  const [announce, setAnnounce] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const seen = useRunSeen(runId);
  const { store, detail: detailState, load } = useRunDetail(runId);
  useEffect(() => {
    // A different run in the same instance starts from its own overview.
    setBoard("overview");
    setAnnounce("");
  }, [runId]);
  const focusHeading = () => headingRef.current?.focus({ preventScroll: true });
  const retry = useRetryFocus(headingRef);
  const retryLoad = (e: Event) => { void retry(e.currentTarget, load); };

  const raw = detailState?.run ?? null;

  const view = useMemo(() => {
    if (!detailState?.run) return null;
    const questions = detailState.questions as RunQuestionView[];
    const detail = {
      run: detailState.run, steps: detailState.steps, graphs: detailState.graphs ?? [],
      ...(detailState.definition ? { definition: detailState.definition } : {}),
      ...(detailState.pendingApproval ? { pendingApproval: detailState.pendingApproval } : {}),
    } as unknown as RunDetail;
    const children: Record<string, BoardChild> = {};
    for (const [id, c] of Object.entries(detailState.children ?? {})) {
      children[id] = { run: { id }, steps: c.steps as BoardChild["steps"], ...(c.definition ? { definition: c.definition as BoardChild["definition"] } : {}) };
    }
    const liveness = new Map<string, NonNullable<NonNullable<typeof state.snapshot>["tasks"][number]["liveness"]>>();
    for (const t of state.snapshot?.tasks ?? []) if (t.liveness) liveness.set(t.id, t.liveness);
    const input: BoardInput = {
      detail, artifacts: detailState.artifacts, questions: questions as BoardQuestion[], decisions: detailState.decisions,
      messages: (detailState.messages ?? []) as BoardMessage[], children, liveness,
    };
    return { input, questions };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- state.snapshot.tasks is read for liveness only
  }, [detailState, state.snapshot?.tasks]);

  const run = isObj(raw) ? raw : null;
  const orchTaskId = typeof run?.orchestratorTaskId === "string" ? run.orchestratorTaskId : "";
  const canAnswer = ops.has("question.answer");
  const canMessage = !!orchTaskId && ops.has("msg.send");
  const requestedArtifact = artifactFromHash();

  const avail = view ? boardAvailability(view.input, !!orchTaskId) : { brainstorm: false, review: false, execution: false, tests: false };
  const offered: BoardId[] = ["overview", ...(avail.brainstorm ? ["brainstorm" as const] : []), ...(avail.review ? ["review" as const] : []),
    ...(avail.execution ? ["execution" as const] : []), ...(avail.tests ? ["tests" as const] : [])];
  const active: BoardId = offered.includes(board) ? board : "overview";

  const answered = () => {
    setAnnounce("Answer submitted");
    // The answered form leaves the page; keep keyboard focus on the run title instead of dropping it.
    queueMicrotask(focusHeading);
    void load();
  };
  const reloadQuestion = () => { setAnnounce("This question changed. Showing the latest version."); void load(); };
  const send = async (body: string) => {
    const call = runner ? <T,>(op: string, params?: unknown) => runner.call<T>(op, params) : api.call.bind(api);
    const result = await call("msg.send", { to: `task:${orchTaskId}`, body });
    await load();
    return result;
  };

  // Header facts
  const snapRun = state.snapshot?.runs?.find(r => r.id === runId);
  const { letter, runName, title } = runIdentity(runId, run, store.list, state.snapshot?.runs);
  const pausedReason = typeof run?.pausedReason === "string" ? run.pausedReason : typeof snapRun?.paused_reason === "string" ? snapRun.paused_reason : undefined;
  const status = runStatus(pausedReason ? "paused" : String(run?.status ?? "running"));
  const openQuestions = (view?.questions ?? []).filter(isOpenForPerson);
  const waits = !openQuestions.length && awaitsVerdict(runId, state.snapshot?.attention) ? "review"
    : snapRun?.waits_on ?? (openQuestions.length ? "you" : status.label === "Waiting" ? "orchestrator" : "-");
  const orch = isObj(run?.orchestrator) ? run!.orchestrator as { state?: string; planner?: string; reason?: string; next_wake_at?: number } : undefined;
  const orchLine = sentenceCase(orchestratorBlock(orch, now));
  const orchAttention = orchestratorNeedsAttention(orch);
  const runAttention = (state.snapshot?.attention ?? []).filter((item: { run?: { id: string } }) => item.run?.id === runId);
  const createdAt = typeof run?.createdAt === "number" ? run.createdAt : 0;
  const unavailable = !ops.has("run.get");
  const backHref = withQuery("#/runs", query);

  const rail = view ? (
    <ConversationRail entries={conversationRail({ ...view.input, questions: (view.input.questions ?? []).filter(q => !openQuestions.some(o => o.id === q.id)) }, orchTaskId || undefined)} now={now} canMessage={canMessage} onSend={send} messagesError={detailState?.messagesError} />
  ) : null;
  const railNode = frame ? <><FrameSlot name="right">{rail}</FrameSlot>{frame.inline ? rail : null}</> : rail;

  const specArtifact = view ? pickSpecArtifact(artifactMetas(view.input.artifacts), requestedArtifact) : undefined;
  const requestedMeta = view && requestedArtifact ? artifactMetas(view.input.artifacts).find(a => a.id === requestedArtifact) : undefined;

  return <>
    <PageHead>
      <header className="runs-header">
        <div className="runs-heading">
          <h1 ref={headingRef} tabIndex={-1}>{title}</h1>
        </div>
        <div className="runs-heading-links">
          <ButtonLink typography="board" size="sm" href={liveHref(runId, undefined, query)}>Live board</ButtonLink>
          <ButtonLink typography="board" size="sm" href={backHref}>All runs</ButtonLink>
        </div>
      </header>
    </PageHead>
    <p className="sr-only" role="status" aria-live="polite">{announce}</p>
    <Page width="full" className="rv" aria-label={runName}>
      {unavailable && <EmptyState title="Run unavailable" description="This service does not offer run.get yet." />}
      {detailState?.error && !raw && (
        <Alert tone="error" title="Couldn't load this run">
          <p>{detailState.error}</p>
          <Button size="sm" onClick={retryLoad}>Try again</Button>
        </Alert>
      )}
      {seen.failed ? (
        <Alert tone="error" title={RUN_SEEN_ERROR}>
          <Button size="sm" onClick={e => { void retry(e.currentTarget, seen.markSeen); }}>Mark as seen</Button>
        </Alert>
      ) : null}
      {detailState?.error && raw && (
        <Alert tone="warning" title={detailState.error === RUN_QUESTIONS_ERROR ? RUN_QUESTIONS_ERROR : "This run may be out of date"}>
          <p>{detailState.error === RUN_QUESTIONS_ERROR
            ? "The rest of the run is shown without them."
            : "The last refresh failed, so you are seeing the version loaded earlier."}</p>
          <Button size="sm" onClick={retryLoad}>Try again</Button>
        </Alert>
      )}
      {!unavailable && !raw && !detailState?.error && <p className="rv-cap" role="status">Loading run…</p>}
      {view && run && <>
        <div className="rv-facts" aria-label="Run facts" role="group">
          {letter ? <span className="rv-fact"><span className="pc-run-letter" role="img" aria-label={runName}>{letter}</span></span> : null}
          <span className="rv-fact"><Pill tone={status.tone}><span aria-hidden="true">{status.glyph} </span>{status.label}</Pill></span>
          <span className="rv-fact">Priority: {runPriorityLabel(typeof run.priority === "string" ? run.priority : undefined)}</span>
          <span className="rv-fact">Waits on: {waitsOnLabel(waits)}</span>
          <span className="rv-fact" title={String(run.workflow ?? "")}>{String(run.workflow ?? "")}</span>
          <span className="rv-fact">Started {runAge(createdAt, now)}</span>
        </div>
        {pausedReason ? <Alert tone="warning" title={pausedReasonLabel(pausedReason)}><p>Steps already running finish; nothing new starts until the run resumes.</p></Alert> : null}
        {orchAttention && !runAttention.some((item: any) => item.kind === "orchestrator_failed")
          ? <Alert tone="warning" title={orch?.state === "retrying" ? "The planner is retrying" : "The planner is blocked"}><p data-orchestrator>{orchLine}</p></Alert>
          : !orchAttention ? <p className="rv-cap" data-orchestrator>{orchLine}</p> : null}
        {runAttention.filter((item: any) => item.kind !== "question").length ? (
          <section className="rv-section" aria-label="Needs your attention">
            <h2 className="rv-title">Needs your attention</h2>
            {runAttention.filter((item: any) => item.kind !== "question").map((item: any) => {
              const status = attentionStatus(item, state.snapshot?.tasks ?? []);
              return <div key={item.id} className="ny-item" data-attention-id={item.id}>
                <span aria-hidden="true" className={`ny-glyph ny-glyph--${status.tone === "neutral" ? "info" : status.tone}`}>{status.glyph}</span>
                <div className="ny-gate">
                  <span className="ny-title-line"><span className="ny-title">{item.title}</span><Pill tone={status.tone}>{status.label}</Pill></span>
                  <span className="ny-reason">{item.detail}</span>
                </div>
                <span className="ny-actions">
                  {item.kind === "review" && item.taskId ? <ButtonLink typography="board" size="sm" href={`#/tasks/${encodeURIComponent(item.taskId)}/review`}>Review</ButtonLink> : null}
                  {item.actions.filter((action: any) => action.op !== "ui.open").map((action: any) => <ActionButton key={action.label} runner={runner} id={`${item.id}:${action.label}`} action={action} />)}
                </span>
              </div>;
            })}
          </section>
        ) : null}

        {offered.length > 1 ? (
          <div className="rv-boards" role="group" aria-label="Run boards">
            {offered.map(id => <BoardButton key={id} active={active === id} onClick={() => { setBoard(id); setAnnounce(`${BOARD_LABELS[id]} board shown`); }}>{BOARD_LABELS[id]}</BoardButton>)}
          </div>
        ) : null}

        {requestedMeta ? (
          <section className="rv-section" aria-label="Artifact">
            <h2 className="rv-title">{requestedMeta.label}</h2>
            <ArtifactText runId={runId} artifact={requestedMeta} revision={detailState?.stamp} fetchText={fetchText} />
          </section>
        ) : null}

        {active === "overview" && <>
          <section className="rv-section" aria-label="Steps">
            <h2 className="rv-title">Steps</h2>
            <RunStrip steps={stripSteps(view.input.detail, view.input.questions ?? [])} />
          </section>
          {openQuestions.length ? (
            <section className="rv-section" aria-label="Needs your answer">
              <h2 className="rv-title">Needs your answer</h2>
              {openQuestions.map(q => <RunQuestionCard key={q.id} question={q} canAnswer={canAnswer} api={api} onAnswered={answered} onConflict={reloadQuestion} />)}
            </section>
          ) : null}
          {railNode}
        </>}
        {active === "brainstorm" && orchTaskId ? (
          <BrainstormBoard runId={runId} taskId={orchTaskId} spec={specArtifact} questions={openQuestions.filter(q => !/publish/i.test(q.stepId ?? ""))}
            canAnswer={canAnswer} api={api} onAnswered={answered} onConflict={reloadQuestion} fetchText={fetchText} revision={detailState?.stamp} />
        ) : null}
        {active === "review" && <ReviewerPanel panels={reviewerPanels(view.input.detail, view.input.decisions)} />}
        {active === "execution" && <ExecutionWaves data={executionWaves(view.input)} now={now} />}
        {active === "tests" && (
          <TestsAndPr runId={runId} data={testsAndPr(view.input)} questions={openQuestions.filter(q => /publish/i.test(q.stepId ?? ""))}
            canAnswer={canAnswer} api={api} onAnswered={answered} onConflict={reloadQuestion} />
        )}
        {specArtifact && active === "overview" && !requestedMeta ? (
          <p className="rv-cap">Spec: <ArtifactLink runId={runId} artifact={specArtifact} /></p>
        ) : null}
      </>}
    </Page>
  </>;
}
