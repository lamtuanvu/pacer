/** Board 7: replay of a run's journey from recorded decisions, step rows and graph versions. Read-only. */
import { useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import { orchestratorBlock, runStatus } from "../../../../src/view-model/runs";
import { useLiveStyles } from "./LiveBoard";
import { Button, ButtonLink } from "../../ds/Button";
import { SectionHeading } from "../../ds/SectionHeading";
import { Range } from "../../ds/Controls";
import { Page } from "../../ds/Page";
import { EmptyState, RadioChoices } from "../../ds/Patterns";
import { PageHead } from "../../shell/slots";
import type { RouteQuery } from "../../router";
import { BoardCanvas } from "./BoardCanvas";
import { BoardViewport } from "./BoardViewport";
import { agentPlace, layoutLiveBoard } from "./live-board-layout";
import { executorName, executorOf, layoutInputFromDetail, nodeLabel } from "./live-board-model";
import { buildJourney, frameAt } from "./journey";
import { liveHref, runViewHref } from "./live-links";
import { runIdentity, useRetryFocus, useRunDetail } from "./run-data";
import { RunLoadAlerts } from "./run-shared";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const STEP_MS = 1200;
const SPEEDS = [{ value: "1", label: "1x" }, { value: "2", label: "2x" }, { value: "4", label: "4x" }] as const;

export function JourneyPlayback({ runId, query, stepMs = STEP_MS }: { runId: string; query: RouteQuery; stepMs?: number }) {
  useLiveStyles();
  const { state, ops, store, detail, load } = useRunDetail(runId);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const retry = useRetryFocus(headingRef);
  const markerId = useId();
  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState("1");
  const raw = detail?.run ?? null;
  const run = isObj(raw) ? raw : null;
  const tasks = state.snapshot?.tasks as ReadonlyArray<{ id: string; executor?: string | null }> | undefined;

  const layout = useMemo(() => detail?.run ? layoutLiveBoard(layoutInputFromDetail(detail, [])) : null, [detail]);
  const journey = useMemo(() => {
    if (!layout || !run) return null;
    const def = isObj(detail?.definition) && isObj((detail!.definition as Record<string, unknown>).steps) ? (detail!.definition as { steps: Record<string, { type: string }> }).steps : undefined;
    return buildJourney({
      run: { createdAt: typeof run.createdAt === "number" ? run.createdAt : undefined, updatedAt: typeof run.updatedAt === "number" ? run.updatedAt : undefined, status: String(run.status ?? ""), title: typeof run.title === "string" ? run.title : undefined },
      layout, decisions: detail?.decisions, stepTypes: def, executorOf: id => executorOf(id, tasks), executorName,
    });
  }, [layout, run, detail?.decisions, detail?.definition, tasks]);
  const last = (journey?.events.length ?? 0) - 1;

  useEffect(() => { setIndex(-1); setPlaying(false); }, [runId]);
  // A refresh can shorten the journey; never leave the index past its end.
  useEffect(() => { if (index > last) setIndex(Math.max(-1, last)); }, [last, index]);
  useEffect(() => {
    if (!playing) return;
    if (index >= last) { setPlaying(false); return; }
    const t = setTimeout(() => setIndex(i => Math.min(last, i + 1)), stepMs / Number(speed));
    return () => clearTimeout(t);
  }, [playing, index, last, speed, stepMs]);

  // Playing stops by itself at the end, so the end never reads as playing.
  const running = playing && index < last;
  const frame = layout && journey ? frameAt(journey, layout, index) : null;
  const agents = useMemo(() => (frame?.working ?? []).map(w => {
    const node = layout!.nodes.find(n => n.id === w.nodeId)!;
    return { taskId: w.taskId, nodeId: w.nodeId, executor: w.executor, name: executorName(w.executor), label: nodeLabel(node), ...agentPlace(node) };
  }), [frame, layout]);

  const { title } = runIdentity(runId, run, store.list, state.snapshot?.runs);
  const orch = isObj(run?.orchestrator) ? run!.orchestrator as { state?: string; planner?: string; reason?: string; next_wake_at?: number } : undefined;
  const humanAt = frame && layout
    ? layout.nodes.find(n => frame.visible.has(n.id) && ["waiting", "running"].includes(frame.status.get(n.id) ?? "") && isHumanStep(detail?.definition, n.stepId))?.id ?? null
    : null;
  const unavailable = !ops.has("run.get");
  const finished = journey?.finished ?? false;
  const go = (i: number) => { setPlaying(false); setIndex(Math.max(-1, Math.min(last, i))); };
  // A button that disables itself when pressed (Restart at the start, Step forward at the end) must not drop keyboard focus: it goes to Play.
  const playRef = useRef<HTMLButtonElement>(null);
  const goKeepingFocus = (i: number, disablesAt: "start" | "end") => {
    go(i);
    if (disablesAt === "start" ? i < 0 : i >= last) queueMicrotask(() => playRef.current?.focus());
  };
  const status = run ? runStatus(String(run.status ?? "running")) : null;
  const eventText = frame?.event ? frame.event.text : index < 0 && last >= 0 ? "Ready. Press Play to replay the run." : "";

  return <>
    <PageHead>
      <header className="lb-header">
        <div className="lb-heading"><h1 ref={headingRef} tabIndex={-1}>{title}</h1></div>
        <div className="lb-links">
          <ButtonLink typography="board" size="sm" href={liveHref(runId, undefined, query)}>Live board</ButtonLink>
          <ButtonLink typography="board" size="sm" href={runViewHref(runId, query)}>Run view</ButtonLink>
        </div>
      </header>
    </PageHead>
    <Page width="full" className="lb" aria-label="Journey playback">
      {unavailable && <EmptyState title="Replay unavailable" description="This service does not offer run.get yet." />}
      <RunLoadAlerts error={detail?.error} loaded={!!raw} staleTitle="This replay may be out of date" onRetry={e => { void retry(e.currentTarget, load); }} />
      {!unavailable && !raw && !detail?.error && <p className="lb-cap" role="status">Loading the journey…</p>}
      {layout && journey && frame && run && <>
        {journey.events.length === 0 ? <EmptyState title="Nothing to replay yet" description="This run has recorded no steps or decisions." /> : <>
          <p className="lb-cap">{finished ? `Replay of a finished run (${status!.label.toLowerCase()}). Read-only: nothing here changes the run.` : "This run is still in progress, so the replay shows what has happened so far. Read-only: nothing here changes the run."}</p>
          <div className="lb-player" role="group" aria-label="Playback">
            <Button size="sm" onClick={() => goKeepingFocus(-1, "start")} disabled={index < 0}>Restart</Button>
            <Button size="sm" onClick={() => goKeepingFocus(index - 1, "start")} disabled={index < 0}>Step back</Button>
            <Button size="sm" variant="secondary" ref={playRef} onClick={() => { if (!running && index >= last) setIndex(-1); setPlaying(!running); }}>{running ? "Pause" : index >= last ? "Play again" : "Play"}</Button>
            <Button size="sm" onClick={() => goKeepingFocus(index + 1, "end")} disabled={index >= last}>Step forward</Button>
            <Button size="sm" variant="quiet" onClick={() => goKeepingFocus(last, "end")} disabled={index >= last}>Jump to end</Button>
            <RadioChoices label="Speed" name={`${markerId}-speed`} value={speed} onChange={setSpeed} options={SPEEDS} />
          </div>
          <Range className="lb-scrub" label={`Position: event ${index + 1} of ${journey.events.length}`} min={0} max={journey.events.length} value={index + 1}
            aria-valuetext={`Event ${index + 1} of ${journey.events.length}${frame.event ? `: ${frame.event.text}` : ""}`}
            onInput={e => go(Number((e.currentTarget as HTMLInputElement).value) - 1)} />
          <p className="lb-now" role="status" aria-live="polite" data-now>{eventText}</p>
          {frame.event?.detail ? <p className="lb-cap">{frame.event.detail}</p> : null}

          <section className="lb-section" aria-label="Journey board">
            <BoardViewport content={layout} resetKey={runId} markerId={markerId}
              ariaLabel={`Replay of the run graph: ${frame.visible.size} of ${layout.nodes.length} steps so far, ${agents.length} ${agents.length === 1 ? "agent" : "agents"} working`}>
              <BoardCanvas layout={layout} markerId={markerId} agents={agents} plannerIdentity={orch?.planner ? `planner:${orch.planner}` : "planner"}
                plannerNote="Replay"
                visible={n => frame.visible.has(n.id)} statusOf={n => ({ status: frame.status.get(n.id) ?? n.status, waitsOnYou: false })}
                zoneLine={z => frame.zones.get(z.id)?.line ?? null} zoneApproved={z => frame.zones.get(z.id)?.approved ?? false}
                personAt={humanAt} personNote="Watching the replay" />
            </BoardViewport>
          </section>

          <section className="lb-section" aria-labelledby={`${markerId}-events`}>
            <SectionHeading id={`${markerId}-events`}>Events</SectionHeading>
            <ol className="lb-list" aria-label="Journey events">
              {journey.events.map(e => {
                const state = e.index < index ? "played" : e.index === index ? "now" : "next";
                return (
                  <li key={e.index} className={`lb-item lb-item--${state}`} aria-current={state === "now" ? "step" : undefined} data-event={e.index}>
                    <Button size="sm" variant="quiet" aria-label={`Go to event ${e.index + 1}: ${e.text}`} onClick={() => go(e.index)}>Event {e.index + 1}</Button>
                    <span className="lb-cap lb-item-state">{state === "now" ? "Now" : state === "played" ? "Played" : "Next"}</span>
                    <span className="lb-item-name">{e.text}</span>
                    {e.detail ? <span className="lb-cap">{e.detail}</span> : null}
                  </li>
                );
              })}
            </ol>
          </section>
        </>}
      </>}
    </Page>
  </>;
}

function isHumanStep(definition: unknown, stepId: string): boolean {
  if (!isObj(definition) || !isObj(definition.steps)) return false;
  const step = definition.steps[stepId];
  return isObj(step) && step.type === "human";
}
