/** Board 5: test evidence, run branch, pull request link and the publish approval question. */
import { Alert } from "../../ds/Alert";
import { ButtonLink } from "../../ds/Button";
import { Pill } from "../../ds/Pill";
import { ArtifactLink, RunQuestionCard } from "./run-shared";
import type { BrowserApi } from "../../data/api";
import type { RunQuestionView } from "../../data/runs";
import { evidenceStatusLabel, type TestsAndPrData } from "../../../../src/view-model/run-board";

/** Only web links open from here; anything else is shown as text (a recorded PR url is data, not a command). */
function safeHttp(url: string): boolean {
  try { const u = new URL(url); return u.protocol === "https:" || u.protocol === "http:"; } catch { return false; }
}

export function TestsAndPr({ runId, data, questions, canAnswer, api, onAnswered, onConflict }: {
  runId: string;
  data: TestsAndPrData;
  /** The open publish approval questions, as full question views (same form as everywhere). */
  questions: RunQuestionView[];
  canAnswer: boolean;
  api: BrowserApi;
  onAnswered: () => void;
  onConflict: () => void;
}) {
  return (
    <div className="rv-section">
      <section className="rv-section" aria-label="Test evidence">
        <h2 className="rv-title">Test evidence</h2>
        {data.evidence.length === 0 ? <p className="rv-cap">No test evidence has been reported yet.</p> : data.evidence.map(ev => (
          <div key={`${ev.stepId}:${ev.branch ?? ""}`} className="rv-box" data-evidence={ev.stepId}>
            <span className="rv-row"><strong>{ev.stepId}</strong>{ev.report ? <ArtifactLink runId={runId} artifact={ev.report} /> : null}</span>
            {ev.summary ? <p className="rv-text">{ev.summary}</p> : null}
            <div className="rv-counts" role="group" aria-label="Totals">
              <Pill tone="good"><span aria-hidden="true">✓ </span>{ev.passed} passed</Pill>
              <Pill tone="bad"><span aria-hidden="true">✕ </span>{ev.failed} failed</Pill>
              <Pill tone="warn"><span aria-hidden="true">? </span>{ev.unverified} unverified</Pill>
            </div>
            <ul className="rv-surfaces" aria-label="Surfaces">
              {ev.surfaces.map(s => {
                const st = evidenceStatusLabel(s.status);
                return (
                  <li key={s.name} className="rv-box" data-surface={s.name} data-status={s.status}>
                    <span className="rv-row"><strong className="rv-grow rv-clip" title={s.name}>{s.name}</strong><Pill tone={st.tone}><span aria-hidden="true">{st.glyph} </span>{st.label}</Pill></span>
                    {s.steps.length ? <ol className="rv-list" aria-label={`Steps for ${s.name}`}>{s.steps.map((t, i) => <li key={i} className="rv-text">{t}</li>)}</ol> : null}
                    {s.artifacts.length ? <span className="rv-row">{s.artifacts.map(a => <ArtifactLink key={a.id} runId={runId} artifact={a} />)}</span> : null}
                    {s.missingArtifacts.length ? <p className="rv-cap">{s.missingArtifacts.length} attached file{s.missingArtifacts.length === 1 ? "" : "s"} could not be found.</p> : null}
                    {s.status === "unverified" ? <p className="rv-cap">Not checked: nothing was driven for this surface.</p> : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </section>

      <section className="rv-section" aria-label="Branch and pull request">
        <h2 className="rv-title">Branch and pull request</h2>
        <div className="rv-box">
          {data.branch ? <p className="rv-text">Run branch <span className="rv-mono">{data.branch}</span>{data.baseRef ? <> from <span className="rv-mono">{data.baseRef}</span></> : null}</p> : <p className="rv-cap">No run branch yet.</p>}
          {data.conflicts ? <Alert tone="warning" title="Merge conflict"><p>{data.conflicts} conflicting {data.conflicts === 1 ? "branch needs" : "branches need"} resolving before publishing.</p></Alert> : null}
          {data.prUrl
            ? safeHttp(data.prUrl)
              ? <p className="rv-text"><ButtonLink size="sm" variant="secondary" href={data.prUrl} target="_blank" rel="noopener noreferrer">Open pull request</ButtonLink> <span className="rv-mono">{data.prUrl}</span></p>
              : <p className="rv-text">Pull request <span className="rv-mono">{data.prUrl}</span></p>
            : <p className="rv-cap">No pull request has been opened.</p>}
        </div>
      </section>

      {questions.length ? (
        <section className="rv-section" aria-label="Publish approval">
          <h2 className="rv-title">Publish approval</h2>
          {questions.map(q => <RunQuestionCard key={q.id} question={q} canAnswer={canAnswer} api={api} onAnswered={onAnswered} onConflict={onConflict} />)}
        </section>
      ) : null}
    </div>
  );
}
