/** Board 3: the reviewer panel. One lane per fan-out branch, findings per reviewer, the join verdict and the decision. */
import { useId } from "preact/hooks";
import { Pill } from "../../ds/Pill";
import { StepState } from "./run-shared";
import { actorLabel, decisionKindLabel, type ReviewerPanelData } from "../../../../src/view-model/run-board";

const VERDICT_TONE: Record<string, "good" | "warn"> = { pass: "good", revise: "warn" };
const VERDICT_LABEL: Record<string, string> = { pass: "Pass", revise: "Needs changes" };

function Verdict({ verdict }: { verdict: string }) {
  const glyph = verdict === "pass" ? "✓" : verdict === "revise" ? "!" : "·";
  return <Pill tone={VERDICT_TONE[verdict] ?? "neutral"}><span aria-hidden="true">{glyph} </span>{VERDICT_LABEL[verdict] ?? verdict}</Pill>;
}

function Panel({ panel }: { panel: ReviewerPanelData }) {
  const id = useId();
  const done = panel.lanes.filter(l => l.status === "done").length;
  return (
    <section className="rv-section" aria-labelledby={`${id}-h`} data-panel={panel.stepId}>
      <h2 className="rv-title" id={`${id}-h`}>{panel.stepId}</h2>
      <p className="rv-cap rv-num">{done} of {panel.lanes.length} reviewers finished</p>
      <ul className="rv-lanes rv-list" aria-label={`Reviewers for ${panel.stepId}`}>
        {panel.lanes.map(lane => (
          <li key={lane.branch} className="rv-box" data-reviewer={lane.branch}>
            <span className="rv-row">
              <strong className="rv-grow rv-clip">{lane.branch}</strong>
              <StepState marker={lane.marker} status={lane.status} />
            </span>
            {lane.verdict ? <span className="rv-row"><Verdict verdict={lane.verdict} /></span> : null}
            {lane.summary ? <p className="rv-text">{lane.summary}</p> : null}
            {lane.findings.length ? (
              <>
                <p className="rv-cap">Findings</p>
                <ul className="rv-ul" aria-label={`Findings from ${lane.branch}`}>
                  {lane.findings.map((f, i) => <li key={i} className="rv-text">{f}</li>)}
                </ul>
              </>
            ) : lane.status === "done" ? <p className="rv-cap">No findings reported.</p> : null}
            {lane.error ? <p className="rv-text" role="note">This reviewer stopped: {lane.error}</p> : null}
          </li>
        ))}
      </ul>
      <div className="rv-box" aria-label={`Join result for ${panel.stepId}`} role="group">
        <span className="rv-row">
          <strong>Panel verdict</strong>
          {panel.join?.verdict ? <Verdict verdict={panel.join.verdict} /> : panel.join ? <StepState marker="done" status={panel.join.status} /> : <Pill tone="neutral">Waiting for reviewers</Pill>}
        </span>
        {panel.join?.summary ? <p className="rv-text">{panel.join.summary}</p> : null}
        {panel.decisions.length ? (
          <ul className="rv-list" aria-label="Decisions on this review">
            {panel.decisions.map(d => (
              <li key={d.id} className="rv-text"><strong>{actorLabel(d.actor)}: {decisionKindLabel(d.kind)}{d.choice ? ` (${d.choice})` : ""}.</strong> {d.reason}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

export function ReviewerPanel({ panels }: { panels: ReviewerPanelData[] }) {
  if (!panels.length) return <p className="rv-cap">This run has no parallel review.</p>;
  return <>{panels.map(p => <Panel key={`${p.stepId}:${p.attempt}`} panel={p} />)}</>;
}
