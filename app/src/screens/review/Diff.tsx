import { parseFilePatch } from "../../model/diff";
import { Button } from "../../ds/Button";
import { numberDiffLines, splitDiffRows, type NumberedDiffLine } from "./model";
export interface DiffProps { path: string; patch: string; binary?: boolean; truncated?: boolean; note?: string; onOpen?: () => void; layout?: "unified" | "split" }
function Line({line, before}: {line?: NumberedDiffLine; before?: boolean}) {
  return <div className={`pc-diff-line diff-${line?.kind ?? "context"}`}><span>{before ? line?.old : line?.next ?? line?.old}</span><span>{line?.mark}</span><span>{line?.text || " "}</span></div>;
}
export function Diff({ path, patch, binary, truncated, note, onOpen, layout }: DiffProps) {
  const file = parseFilePatch(patch, path), lines = file.lines.slice(0, 2000), numbered = layout ? numberDiffLines(lines) : [];
  return <section aria-label={`Diff for ${path}`}>
    {note && <p className="muted">{note}</p>}
    {binary || file.binary ? <p>Binary file</p> : !patch ? <p className="muted">No diff available for this file.</p> : layout === "split" ? <div className="pc-diff-split" tabIndex={0} aria-label="Split diff">{splitDiffRows(numbered).map((row, i) => <div className="pc-diff-pair" key={i}><Line line={row.before} before/><Line line={row.after}/></div>)}</div> : layout === "unified" ? <div className="pc-diff-unified" tabIndex={0}>{numbered.map((line, i) => <Line key={i} line={line}/>)}</div> : <pre className="diff" tabIndex={0}>{lines.map((line, i) => <span key={i} className={`diff-${line.kind}`}>{line.text}</span>)}</pre>}
    {(truncated || file.lines.length > 2000) && <p className="muted">Showing the first 2,000 lines.{onOpen && <> <Button size="sm" onClick={onOpen}>Copy worktree path</Button></>}</p>}
  </section>;
}
