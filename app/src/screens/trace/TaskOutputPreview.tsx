import type { TaskDetail } from '../../../../src/core/task-detail';
import type { SessionInfo } from '../../../../src/session/service';
import { LazyTerminal } from '../../term/LazyTerminal';
import { Button } from '../../ds/Button';
import { useQuery } from '../task-shared';
import { useOutputTail } from '../needs-you/output-tail';

/** task.log is a plain transcript, never a source of terminal frames. */
export function TaskOutputPreview({ task }: { task: TaskDetail }) {
  const session = useQuery<SessionInfo>('task.session', { id: task.id }, String(task.updatedAt), true);
  if (session.error || !session.data) return <div className="pc-task-now__output" role="status">
    {session.error ? <>Could not load the session. <Button size="sm" onClick={session.reload}>Try again</Button></> : 'Loading session…'}
  </div>;
  const info = session.data;
  if (info.host === 'none') return <HeadlessOutput task={task}/>;
  if (info.host !== 'builtin' || !info.capabilities.snapshot) return <p className="pc-task-now__output">
    {info.host === 'orca' ? 'This session runs in Orca. Open the workspace to follow it in Orca.' : 'Terminal preview is unavailable for this session.'}
  </p>;
  return <div className="pc-task-now__terminal" role="region" aria-label="Session terminal preview">
    <LazyTerminal key={`${task.id}:${info.attempt ?? ''}`} id={task.id} url={info.attach.ws}
      label="Task overview preview" cols={info.cols} rows={info.rows} live={info.live}
      control={false} resize={false} preview/>
  </div>;
}

function HeadlessOutput({ task }: { task: TaskDetail }) {
  const log = useOutputTail(task.id, `${task.updatedAt}:${task.progress?.lastOutputAt}:${task.progress?.logBytes}`);
  if (log.error) return <p className="pc-task-now__output" role="status">Could not load task output.</p>;
  return log.text ? <pre tabIndex={0} aria-label="Task output" className="pc-task-now__output pc-trace__mono">{log.text}</pre> : null;
}
