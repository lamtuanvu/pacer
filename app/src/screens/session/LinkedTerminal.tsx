import { useEffect, useRef, useState } from "preact/hooks";
import type { SessionFileRequest, SessionFileResult } from "../../../../src/session/files";
import { Button } from "../../ds/Button";
import { LazyTerminal } from "../../term/LazyTerminal";
import type { TerminalViewProps } from "../../term/term";

export type ReadSessionFile = (request: SessionFileRequest) => Promise<SessionFileResult>;
type Viewer = typeof import("./FileViewer")["FileViewer"];
interface Viewing { reference: string; file?: SessionFileResult; error?: { code: string; message: string }; loading?: boolean }

/** Keeps the PTY viewer mounted while a linked file is inspected. Layout, loading and error states live in the lazy viewer. */
export function LinkedTerminal({ attempt, readFile, workspace, agent, ...terminal }: TerminalViewProps & {
  attempt: number | null;
  readFile?: ReadSessionFile;
  /** The worktree or repository that linked paths are relative to. */
  workspace?: string;
  /** Display name of the agent whose terminal printed the path. */
  agent?: string;
}) {
  const [viewing, setViewing] = useState<Viewing | null>(null);
  const [View, setView] = useState<Viewer | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const requestSeq = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { requestSeq.current++; setViewing(null); }, [attempt, terminal.id]);
  const load = () => {
    if (View) return;
    setLoadFailed(false);
    void import("./FileViewer").then(module => { if (typeof module.FileViewer !== "function") throw Error(); setView(() => module.FileViewer); }).catch(() => setLoadFailed(true));
  };
  const close = () => {
    requestSeq.current++; setViewing(null);
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(".xterm-helper-textarea")?.focus());
  };
  const open = async (path: string, line?: number, column?: number) => {
    const reference = `${path}${line ? `:${line}${column ? `:${column}` : ""}` : ""}`;
    const request = ++requestSeq.current;
    load();
    if (!readFile || !attempt) { setViewing({ reference, error: { code: "not_allowed", message: "File preview is unavailable for this session." } }); return; }
    setViewing(previous => ({ reference, loading: true, ...(previous?.reference === reference && previous.file ? { file: previous.file } : {}) }));
    try {
      const file = await readFile({ id: terminal.id, attempt, reference });
      if (request === requestSeq.current) setViewing({ reference, file });
    } catch (reason) {
      const code = (reason as { code?: unknown } | null)?.code;
      if (request === requestSeq.current) setViewing({ reference, error: { code: typeof code === "string" ? code : "internal", message: reason instanceof Error ? reason.message : "File could not be opened." } });
    }
  };
  return <div className={`pc-linked-terminal${viewing ? " pc-linked-terminal--viewing" : ""}`} data-linked-terminal ref={root}>
    <div className="pc-linked-terminal__layout">
      <div className="pc-linked-terminal__term"><LazyTerminal {...terminal} onOpenFile={(path, line, column) => { void open(path, line, column); }}/></div>
      {viewing && <div className="pc-linked-terminal__viewer">
        {View ? <View key={viewing.reference} {...viewing} workspace={workspace} agent={agent && agent[0]!.toUpperCase() + agent.slice(1)} running={terminal.live ?? true} onClose={close} onRefresh={() => { void open(viewing.reference); }} onOpenFile={path => { void open(path); }}/>
          : loadFailed ? <div><p role="alert">Could not load the file viewer.</p><Button size="sm" onClick={load}>Try again</Button> <Button size="sm" variant="quiet" onClick={close}>Back to terminal</Button></div>
          : <p role="status">Opening file…</p>}
      </div>}
    </div>
  </div>;
}
