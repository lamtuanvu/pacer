import { parseFilePatch } from "../../model/diff";
import { Button } from "../../ds/Button";
export interface DiffProps { path: string; patch: string; binary?: boolean; truncated?: boolean; note?: string; onOpen?: () => void }
export function Diff({ path, patch, binary, truncated, note, onOpen }: DiffProps) {
  const file = parseFilePatch(patch, path);
  return <section aria-label={`Diff for ${path}`}>
    {note && <p className="muted">{note}</p>}
    {binary || file.binary ? <p>Binary file</p> : <pre className="diff" tabIndex={0}>{file.lines.slice(0, 2000).map((line, i) => <span key={i} className={`diff-${line.kind}`}>{line.text}</span>)}</pre>}
    {(truncated || file.lines.length > 2000) && <p className="muted">Showing the first 2,000 lines. <Button size="sm" onClick={onOpen}>Copy worktree path</Button></p>}
  </section>;
}
