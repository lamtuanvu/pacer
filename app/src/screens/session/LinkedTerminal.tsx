import { useEffect, useRef, useState } from "preact/hooks";
import type { SessionFileRequest, SessionFileResult } from "../../../../src/session/files";
import { Button } from "../../ds/Button";
import { LazyTerminal } from "../../term/LazyTerminal";
import type { TerminalViewProps } from "../../term/term";

export type ReadSessionFile = (request: SessionFileRequest) => Promise<SessionFileResult>;

/** Keeps the PTY viewer mounted while a linked file is inspected. */
export function LinkedTerminal({ attempt, readFile, ...terminal }: TerminalViewProps & {
  attempt: number | null;
  readFile?: ReadSessionFile;
}) {
  const [file, setFile] = useState<SessionFileResult | null>(null);
  const [reference, setReference] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [Viewer, setViewer] = useState<typeof import("./FileViewer")["FileViewer"] | null>(null);
  const requestSeq = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const errorPanel = useRef<HTMLDivElement>(null);
  useEffect(() => { requestSeq.current++; setFile(null); setReference(""); setLoading(false); setError(""); setCopyStatus(""); }, [attempt, terminal.id]);
  useEffect(() => { if (error) errorPanel.current?.focus(); }, [error]);
  useEffect(() => {
    if (!file || Viewer) return;
    let active = true;
    void import("./FileViewer").then(module => { if (active) setViewer(() => module.FileViewer); })
      .catch(() => { if (active) { setFile(null); setError("Could not load file viewer."); } });
    return () => { active = false; };
  }, [file, Viewer]);
  const close = () => {
    requestSeq.current++; setFile(null); setError(""); setLoading(false);
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(".xterm-helper-textarea")?.focus());
  };
  const open = async (path: string, line?: number, column?: number) => {
    if (!readFile || !attempt) { setError("File preview is unavailable for this session."); return; }
    const target = `${path}${line ? `:${line}${column ? `:${column}` : ""}` : ""}`;
    const request = ++requestSeq.current;
    setReference(target); setLoading(true); setError(""); setCopyStatus("");
    try {
      const next = await readFile({ id: terminal.id, attempt, reference: target });
      if (request === requestSeq.current) setFile(next);
    } catch (reason) {
      if (request === requestSeq.current) { setFile(null); setError(reason instanceof Error ? reason.message : "File could not be opened."); }
    } finally { if (request === requestSeq.current) setLoading(false); }
  };
  return <div className="pc-linked-terminal" data-linked-terminal ref={root}>
    <div hidden={!!file || !!error || loading}><LazyTerminal {...terminal} onOpenFile={(path, line, column) => { void open(path, line, column); }}/></div>
    {loading && <p role="status">Opening file…</p>}
    {error && <div className="pc-file-viewer__error" role="status" aria-live="polite" tabIndex={-1} ref={errorPanel}><p>{error}</p><div><Button size="sm" onClick={close}>Back to terminal</Button> <Button size="sm" variant="quiet" onClick={() => { void (async () => { try { await navigator.clipboard.writeText(reference); setCopyStatus("Path copied"); } catch { setCopyStatus("Could not copy path"); } })(); }}>Copy path</Button></div>{copyStatus && <span role="status">{copyStatus}</span>}</div>}
    {file && (Viewer ? <Viewer key={`${file.path}:${file.modified}:${file.line ?? ""}:${file.column ?? ""}`} file={file} onClose={close} onRefresh={() => { void open(reference); }} onOpenFile={path => { void open(path); }}/> : <p role="status">Preparing viewer…</p>)}
  </div>;
}
