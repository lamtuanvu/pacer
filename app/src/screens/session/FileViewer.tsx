import type { SessionFileResult } from "../../../../src/session/files";
import { Button } from "../../ds/Button";
import { TextInput } from "../../ds/Controls";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { htmlPreviewDocument } from "./preview-html";

export function resolvePreviewReference(currentPath: string, href: string): string | null {
  if (!href || href.startsWith("#") || href.startsWith("/")) return null;
  const path = href.split(/[?#]/, 1)[0];
  if (!path) return null;
  const location = /:(\d+)(?::\d+)?$/.exec(path);
  const name = location ? path.slice(0, location.index) : path;
  if (/^[a-z][\w+.-]*:/i.test(name) || (location && !/[/.]/.test(name))) return null;
  try {
    return `${currentPath.split("/").slice(0, -1).join("/")}/${decodeURIComponent(path)}`.replace(/^\//, "");
  } catch { return null; }
}

export function FileViewer({ file, onClose, onRefresh, onOpenFile }: {
  file: SessionFileResult;
  onClose: () => void;
  onRefresh: () => void;
  onOpenFile?: (reference: string) => void;
}) {
  const canPreview = file.kind === "html" || file.kind === "markdown";
  const [tab, setTab] = useState<"source" | "preview">(canPreview ? "preview" : "source");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(Math.floor(((file.line ?? 1) - 1) / 2000));
  const [markdown, setMarkdown] = useState<string | null>(null);
  const selected = useRef<HTMLDivElement>(null);
  const source = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => { setTab(canPreview ? "preview" : "source"); setSearch(""); setPage(Math.floor(((file.line ?? 1) - 1) / 2000)); setMarkdown(null); }, [file.path, file.modified, file.line, file.column]);
  useEffect(() => {
    if (file.kind !== "markdown" || tab !== "preview") return;
    let active = true;
    void import("./preview").then(module => { if (active) setMarkdown(module.renderMarkdownPreview(file.text)); });
    return () => { active = false; };
  }, [file.kind, file.text, tab]);
  const lines = useMemo(() => file.text.split("\n"), [file.text]);
  const matching = search ? lines.findIndex(line => line.toLocaleLowerCase().includes(search.toLocaleLowerCase())) + 1 : 0;
  const highlighted = matching || file.line;
  const limit = 2000;
  const currentPage = Math.min(page, Math.floor((lines.length - 1) / limit));
  const start = (matching ? Math.floor((matching - 1) / limit) : currentPage) * limit;
  const shown = lines.slice(start, start + limit);
  useEffect(() => { if (tab !== "source") return; if (selected.current) selected.current.scrollIntoView({ block: "center" }); else if (source.current) source.current.scrollTop = 0; }, [tab, highlighted, start, file.path]);
  return <section className="pc-file-viewer" aria-label={`File viewer: ${file.path}`}>
    <header className="pc-file-viewer__head" ref={heading} tabIndex={-1}>
      <Button size="sm" variant="quiet" onClick={onClose}>Back to terminal</Button>
      <div className="pc-file-viewer__identity"><strong title={file.path}>{file.path.split("/").at(-1)}</strong><span title={file.path}>{file.path}</span></div>
      <Button size="sm" variant="quiet" onClick={onRefresh}>Refresh</Button>
    </header>
    {canPreview && <div className="pc-file-viewer__tabs" role="group" aria-label="File view">
      <Button size="sm" variant="quiet" aria-pressed={tab === "source"} onClick={() => setTab("source")}>Source</Button>
      <Button size="sm" variant="quiet" aria-pressed={tab === "preview"} onClick={() => setTab("preview")}>Preview</Button>
    </div>}
    {tab === "source" ? <>
      <div className="pc-file-viewer__search"><TextInput aria-label="Search file" placeholder="Search file" value={search} onInput={event => setSearch(event.currentTarget.value)}/>
        {search && <span role="status">{matching ? `First match on line ${matching}` : "No matches"}</span>}</div>
      {file.line && file.line > lines.length && <p className="pc-file-viewer__paging" role="status">Line {file.line} is beyond the end of this file ({lines.length} lines).</p>}
      {lines.length > limit && <div className="pc-file-viewer__paging"><Button size="sm" variant="quiet" disabled={start === 0} onClick={() => { setSearch(""); setPage(Math.max(0, Math.floor(start / limit) - 1)); }}>Previous lines</Button><span role="status">Showing lines {start + 1}–{start + shown.length} of {lines.length}</span><Button size="sm" variant="quiet" disabled={start + shown.length >= lines.length} onClick={() => { setSearch(""); setPage(Math.floor(start / limit) + 1); }}>Next lines</Button></div>}
      <div className="pc-file-viewer__source" role="region" aria-label="File source" tabIndex={0} ref={source}>
        {shown.map((line, index) => {
          const number = start + index + 1;
          const column = number === file.line && number === highlighted ? file.column : undefined;
          return <div key={number} ref={number === highlighted ? selected : undefined}
          className={`pc-file-viewer__line${number === highlighted ? " pc-file-viewer__line--selected" : ""}`}
          aria-current={number === highlighted ? "location" : undefined}>
          <span className="pc-file-viewer__number" aria-label={`Line ${number}`}>{number}</span><span>{column && column <= line.length ? <>{line.slice(0, column - 1)}<mark className="pc-file-viewer__column" aria-label={`Column ${column}`}>{line[column - 1]}</mark>{line.slice(column)}</> : line || " "}</span>
        </div>;
        })}
      </div>
    </> : file.kind === "html" ? <>
      <p className="pc-session-muted">HTML preview blocks scripts, forms, external resources and local assets.</p>
      <iframe className="pc-file-viewer__preview" title={`Preview of ${file.path}`} sandbox="" referrerPolicy="no-referrer" srcDoc={htmlPreviewDocument(file.text)}/>
    </> : <div className="pc-file-viewer__markdown pc-prose" role="region" aria-label={`Preview of ${file.path}`}
      onClick={event => {
        const anchor = (event.target as HTMLElement).closest("a");
        if (!anchor) return;
        event.preventDefault();
        const href = anchor.getAttribute("href") ?? "";
        if (/^https?:\/\//i.test(href)) window.open(href, "_blank", "noopener,noreferrer");
        else {
          const reference = resolvePreviewReference(file.path, href);
          if (reference) onOpenFile?.(reference);
        }
      }} dangerouslySetInnerHTML={{ __html: markdown ?? "Preparing preview…" }}/>}
  </section>;
}
