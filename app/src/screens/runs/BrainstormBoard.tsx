/** Board 2: brainstorm with the planner. The orchestrator's live session beside the spec forming from its artifacts. */
import type { TaskDetail } from "../../../../src/core/task-detail";
import type { SessionInfo } from "../../../../src/session/service";
import { Alert } from "../../ds/Alert";
import { useQuery } from "../task-shared";
import { SessionView } from "../session/SessionView";
import { ArtifactLink, ArtifactText, RunQuestionCard, type FetchText } from "./run-shared";
import type { BrowserApi } from "../../data/api";
import type { RunQuestionView } from "../../data/runs";
import type { ArtifactMeta } from "../../../../src/view-model/run-board";

const noop = () => {};

/** The planner's interactive lane: the same terminal the task screens use, read from the orchestrator's task. */
export function OrchestratorLane({ taskId }: { taskId: string }) {
  const task = useQuery<TaskDetail>("task.get", { id: taskId });
  const session = useQuery<SessionInfo>("task.session", { id: taskId });
  if (task.error || (!task.data && !task.loading)) return <Alert tone="warning" title="The planner's session is not available"><p>The run keeps going; open its task to see more.</p></Alert>;
  if (!task.data) return <p className="rv-cap" role="status">Opening the planner's session…</p>;
  const active = ["queued", "running"].includes(task.data.state);
  return (
    <div className="rv-lane" role="region" aria-label="Planner session">
      <SessionView task={task.data} session={session.data} active={active} footer={null} takeRequested={false} onTakeSent={noop} onFiles={noop} />
    </div>
  );
}

export function BrainstormBoard({ runId, taskId, spec, questions, canAnswer, api, onAnswered, onConflict, fetchText, revision }: {
  runId: string;
  taskId: string;
  spec: ArtifactMeta | undefined;
  /** Open questions from the planner, drawn by the shared form. */
  questions: RunQuestionView[];
  canAnswer: boolean;
  api: BrowserApi;
  onAnswered: () => void;
  onConflict: () => void;
  fetchText?: FetchText;
  /** Bumps on each run reload so the spec text is read again. */
  revision?: number;
}) {
  return (
    <div className="rv-section">
      {questions.length ? (
        <section className="rv-section" aria-label="Questions from the planner">
          <h2 className="rv-title">Questions from the planner</h2>
          {questions.map(q => <RunQuestionCard key={q.id} question={q} canAnswer={canAnswer} api={api} onAnswered={onAnswered} onConflict={onConflict} />)}
        </section>
      ) : null}
      <div className="rv-split">
        <section className="rv-section" aria-label="Planner conversation">
          <h2 className="rv-title">Planner</h2>
          <OrchestratorLane taskId={taskId} />
        </section>
        <section className="rv-section" aria-label="Spec">
          <h2 className="rv-title">Spec</h2>
          {spec
            ? <>
                <p className="rv-cap">Latest version: <ArtifactLink runId={runId} artifact={spec} /></p>
                <ArtifactText runId={runId} artifact={spec} revision={revision} fetchText={fetchText} />
              </>
            : <p className="rv-cap">The spec appears here as the planner writes it.</p>}
        </section>
      </div>
    </div>
  );
}
