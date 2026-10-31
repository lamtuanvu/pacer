import { useEffect, useState } from 'preact/hooks';
import type { TaskDetail } from '../../../../src/core/task-detail';
import { useTaskContext } from '../task-shared';
import { previewReader } from './output-preview';

/** Keep the overview a small transcript excerpt; the workspace owns the terminal. */
export function TaskOutputPreview({ task }: { task: TaskDetail }) {
  const { api } = useTaskContext();
  const [text, setText] = useState('');
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    setText(''); setError(false);
    void (async () => {
      let offsets = { stdout: 0, stderr: 0 }, stdout = previewReader(task.brief), stderr = previewReader(task.brief), source: string | undefined;
      while (active) {
        const chunk = await api.call<{stdout:string;stderr:string;source?:string;next?:typeof offsets}>('task.log', {id:task.id,...offsets});
        if (source && chunk.source !== source) { offsets = {stdout:0,stderr:0}; stdout = previewReader(task.brief); stderr = previewReader(task.brief); source = chunk.source; continue; }
        source = chunk.source;
        stdout.push(chunk.stdout); stderr.push(chunk.stderr);
        if (!chunk.next || chunk.next.stdout-offsets.stdout < 256*1024 && chunk.next.stderr-offsets.stderr < 256*1024) break;
        offsets = chunk.next;
      }
      if (active) setText([stderr.push('',true),stdout.push('',true)].filter(Boolean).join('\n').split('\n').slice(-2).join('\n'));
    })().catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [api,task.id,task.updatedAt,task.progress?.lastOutputAt,task.progress?.logBytes]);
  return error ? <p className="pc-task-now__output" role="status">Could not load task output.</p> : text ? <pre tabIndex={0} aria-label="Task output" className="pc-task-now__output pc-trace__mono">{text}</pre> : null;
}
