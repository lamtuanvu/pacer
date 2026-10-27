import type { ComponentChildren, JSX } from "preact";
import type { SessionFileResult } from "../../../../src/session/files";
import { Button, IconButton } from "../../ds/Button";
import { TextInput } from "../../ds/Controls";
import { NarrowContext } from "../../ds/Density";
import { Kbd } from "../../ds/Kbd";
import { Tabs } from "../../ds/Patterns";
import { Pill } from "../../ds/Pill";
import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { blockedResources, htmlPreviewDocument, type BlockedResource } from "./preview-html";

/** Mirrors MAX_FILE_BYTES in src/session/openat.ts (the service's read bound); a test keeps them equal. */
export const PREVIEW_LIMIT_BYTES = 512 * 1024;
/** Lines rendered at once; search still covers the whole file. */
export const PAGE_LINES = 2000;

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

/** Splits a terminal reference such as `src/a.ts:4:2` into its path and location. */
export function parseReference(reference: string): { path: string; line?: number; column?: number } {
  const location = /:(\d+)(?::(\d+))?$/.exec(reference);
  if (!location) return { path: reference };
  return { path: reference.slice(0, location.index), line: Number(location[1]), ...(location[2] ? { column: Number(location[2]) } : {}) };
}

const extension = (path: string) => /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
const languages: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript", js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  md: "Markdown", markdown: "Markdown", html: "HTML", htm: "HTML", css: "CSS", json: "JSON", yml: "YAML", yaml: "YAML", toml: "TOML",
  py: "Python", rs: "Rust", go: "Go", sh: "Shell", zsh: "Shell", bash: "Shell", swift: "Swift", rb: "Ruby", java: "Java", kt: "Kotlin",
  c: "C", h: "C", cpp: "C++", hpp: "C++", sql: "SQL", xml: "XML", svg: "SVG", txt: "Plain text",
};
export function languageName(path: string): string { return languages[extension(path)] ?? "Plain text"; }
export function fileGlyph(path: string): string {
  const ext = extension(path);
  if (["ts", "tsx", "mts", "cts"].includes(ext)) return "TS";
  if (["js", "jsx", "mjs", "cjs"].includes(ext)) return "JS";
  if (["md", "markdown"].includes(ext)) return "MD";
  if (!ext || ext === "txt") return "TXT";
  if (!languages[ext]) return "FILE";
  return "</>";
}
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(0.1, bytes / 1024).toFixed(1)} KB`;
}
/** Text lines without the empty entry a trailing newline would add. */
export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

export interface SearchMatch { line: number; start: number }
/** Every occurrence across the whole file, in reading order. `line` is 1-based. */
export function findMatches(lines: readonly string[], query: string, matchCase: boolean): SearchMatch[] {
  if (!query) return [];
  const needle = matchCase ? query : query.toLocaleLowerCase();
  const matches: SearchMatch[] = [];
  lines.forEach((text, index) => {
    const lowered = matchCase ? text : text.toLocaleLowerCase();
    if (lowered.length === text.length) {
      for (let at = lowered.indexOf(needle); at >= 0; at = lowered.indexOf(needle, at + query.length)) matches.push({ line: index + 1, start: at });
      return;
    }
    // Lower-casing changed the length (for example "İ"), so compare slices of the original text to keep offsets exact.
    for (let at = 0; at + query.length <= text.length;) {
      if (text.slice(at, at + query.length).toLocaleLowerCase() === needle) { matches.push({ line: index + 1, start: at }); at += query.length; }
      else at++;
    }
  });
  return matches;
}
export const pageOfLine = (line: number) => Math.floor((Math.max(1, line) - 1) / PAGE_LINES);

export type ViewerLayout = "pane" | "replace" | "sheet";
/** Side-by-side from 1100 px of terminal container; a full sheet below 768 px. */
export function viewerLayout(width: number): ViewerLayout { return width >= 1100 ? "pane" : width < 768 ? "sheet" : "replace"; }

export interface FileError { code: string; message: string }
export type ErrorGlyph = "missing" | "outside" | "blocked" | "large" | "binary" | "changed";
export interface ErrorState { glyph: ErrorGlyph; title: string; body: string; copy: boolean; retry: boolean }
/** Maps service error codes (falling back to their messages) to the viewer's titled states. */
export function describeFileError(error: FileError, path: string): ErrorState {
  const message = error.message;
  const code = ["not_found", "not_allowed", "too_large", "invalid_input", "conflict"].includes(error.code) ? error.code
    : /no longer exists|not found/i.test(message) ? "not_found"
    : /outside the session workspace/i.test(message) ? "not_allowed"
    : /too large/i.test(message) ? "too_large"
    : /binary|utf-8/i.test(message) ? "invalid_input"
    : /attempt has changed/i.test(message) ? "conflict" : error.code;
  if (code === "not_found" && /workspace is unavailable/i.test(message)) return { glyph: "missing", title: "Workspace unavailable", body: "This session's workspace is no longer available; it may have been removed or cleaned up.", copy: true, retry: true };
  if (code === "not_found") return { glyph: "missing", title: "This file isn't in the workspace", body: `${path} may have been moved, deleted or not written yet.`, copy: true, retry: true };
  if (code === "not_allowed" && /outside the session workspace/i.test(message)) return { glyph: "outside", title: "Outside this workspace", body: "pacer only opens files inside the session workspace.", copy: true, retry: false };
  if (code === "too_large") return { glyph: "large", title: "Too large to preview", body: `pacer previews files up to ${PREVIEW_LIMIT_BYTES / 1024} KB.`, copy: true, retry: false };
  if (code === "invalid_input" && /binary|utf-8/i.test(message)) return { glyph: "binary", title: "pacer can't show this file", body: "It's a binary file or isn't UTF-8 text.", copy: true, retry: false };
  if (code === "conflict") return { glyph: "changed", title: "This session changed", body: "The agent's attempt moved on. Refresh the session.", copy: false, retry: false };
  return { glyph: "blocked", title: "Can't open this file", body: message || "The file could not be opened.", copy: true, retry: false };
}

const paths: Record<string, string> = {
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4", copy: "M9 9h11v11H9zM5 15H4V4h11v1", refresh: "M20 11a8 8 0 1 0-2 6M20 4v7h-7",
  more: "M6.5 12a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM13.5 12a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM20.5 12a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z", up: "M6 15l6-6 6 6", down: "M6 9l6 6 6-6", close: "M6 6l12 12M18 6 6 18",
  missing: "M6 3h8l4 4v14H6zM10 12l4 4m0-4-4 4", outside: "M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4", blocked: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM6 6l12 12",
  large: "M4 4h16v16H4zM9 15l6-6M10 9h5v5", binary: "M4 5h16v14H4zM8 10v4M12 10v4M16 10v4", changed: "M20 11a8 8 0 1 0-2 6M20 4v7h-7",
};
function Glyph({ name }: { name: keyof typeof paths }) {
  return <svg className="pc-file-viewer__icon" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

function Highlighted({ text, starts, length, current, column }: { text: string; starts: readonly number[]; length: number; current?: number; column?: number }) {
  if (!starts.length) {
    if (column && column <= text.length) return <>{text.slice(0, column - 1)}<mark className="pc-file-viewer__column" aria-label={`Column ${column}`}>{text[column - 1]}</mark>{text.slice(column)}</>;
    return <>{text || " "}</>;
  }
  const parts: ComponentChildren[] = [];
  let at = 0;
  for (const start of starts) {
    parts.push(text.slice(at, start));
    const isCurrent = start === current;
    parts.push(<mark key={start} className={`pc-file-viewer__match${isCurrent ? " pc-file-viewer__match--current" : ""}`} data-current-match={isCurrent ? "" : undefined}>{text.slice(start, start + length)}</mark>);
    at = start + length;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

function BlockedList({ items }: { items: readonly BlockedResource[] }) {
  if (!items.length) return null;
  return <ul className="pc-file-viewer__blocked" aria-label="Blocked resources">
    {items.map(item => <li key={`${item.kind}:${item.address}`}><span className="pc-file-viewer__blocked-kind">{item.kind}</span><code title={item.address}>{item.address}</code>{item.local && <span className="pc-file-viewer__blocked-note">local asset not loaded</span>}</li>)}
  </ul>;
}
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The sandboxed static preview with its blocked-resource banner. */
export function HtmlPreview({ file }: { file: SessionFileResult }) {
  const blocked = useMemo(() => blockedResources(file.text), [file.text]);
  const scripts = blocked.filter(item => item.kind === "script").length;
  const requests = blocked.filter(item => item.kind !== "script" && !item.local && !item.inline).length;
  return <>
    <div className="pc-file-viewer__banner pc-file-viewer__banner--info" role="note" aria-label="Preview is isolated from pacer">
      <strong>Preview is isolated from pacer</strong>
      <span>Scripts don't run, inline styles aren't applied and nothing loads from the network. {plural(scripts, "script")} and {plural(requests, "external request")} were blocked.</span>
      <BlockedList items={blocked}/>
    </div>
    <iframe className="pc-file-viewer__preview" title={`Preview of ${file.path}`} sandbox="" tabIndex={-1} referrerPolicy="no-referrer" srcDoc={htmlPreviewDocument(file.text)}/>
  </>;
}

export function FileViewer({ file, reference, error, loading = false, onClose, onRefresh, onOpenFile }: {
  file?: SessionFileResult;
  /** A read is in flight; a refreshed file stays visible until the new text arrives. */
  loading?: boolean;
  /** The terminal reference being read; shown while loading and on errors. */
  reference?: string;
  error?: FileError;
  onClose: () => void;
  onRefresh: () => void;
  onOpenFile?: (reference: string) => void;
}) {
  const target = parseReference(reference ?? file?.path ?? "");
  const path = file?.path ?? target.path;
  const line = file ? file.line : target.line;
  const name = path.split("/").at(-1) || path;
  const canPreview = file?.kind === "html" || file?.kind === "markdown";
  const id = useId();
  const narrow = useContext(NarrowContext);
  const [tab, setTab] = useState<"source" | "preview">("source");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [current, setCurrent] = useState(0);
  const [page, setPage] = useState(pageOfLine(line ?? 1));
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [skeleton, setSkeleton] = useState(false);
  const [layout, setLayout] = useState<ViewerLayout>("replace");
  const root = useRef<HTMLElement>(null);
  const heading = useRef<HTMLDivElement>(null);
  const selected = useRef<HTMLDivElement>(null);
  const source = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const errorPanel = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: PointerEvent) => { if (!actionsRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [menuOpen]);

  useLayoutEffect(() => {
    const host = root.current?.closest<HTMLElement>(".pc-linked-terminal") ?? root.current?.parentElement;
    if (!host || typeof ResizeObserver === "undefined") return;
    const update = () => setLayout(viewerLayout(host.clientWidth));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => { heading.current?.focus(); }, []);
  useLayoutEffect(() => {
    if (error) errorPanel.current?.focus();
    // Retry or Refresh can remove the focused control; keep focus inside the viewer.
    else if (!document.activeElement || document.activeElement === document.body) heading.current?.focus();
  }, [error, file]);
  useEffect(() => {
    if (file || error) { setSkeleton(false); return; }
    const timer = setTimeout(() => setSkeleton(true), 150);
    return () => clearTimeout(timer);
  }, [file, error]);
  // Layout effects run before the next input event, so a reset never undoes a choice the user just made.
  // A refresh of the same location (only `modified` changes) keeps the chosen tab and page.
  const identity = file ? `${file.path}\n${file.line ?? ""}\n${file.column ?? ""}` : "";
  const shownIdentity = useRef(identity);
  useLayoutEffect(() => {
    if (shownIdentity.current === identity) return;
    shownIdentity.current = identity;
    setTab("source"); setPage(pageOfLine(file?.line ?? 1)); setMarkdown(null); setCurrent(0);
  }, [identity]);
  useEffect(() => {
    if (file?.kind !== "markdown" || tab !== "preview") return;
    let active = true;
    void import("./preview").then(module => { if (active) setMarkdown(module.renderMarkdownPreview(file.text)); });
    return () => { active = false; };
  }, [file?.kind, file?.text, tab]);

  const lines = useMemo(() => splitLines(file?.text ?? ""), [file?.text]);
  const matches = useMemo(() => searchOpen ? findMatches(lines, query, matchCase) : [], [lines, query, matchCase, searchOpen]);
  useLayoutEffect(() => {
    setCurrent(0);
    if (matches[0]) setPage(pageOfLine(matches[0].line));
  }, [matches]);
  useLayoutEffect(() => {
    if (searchOpen) { searchInput.current?.focus(); searchInput.current?.select(); }
  }, [searchOpen]);
  const active = matches[Math.min(current, matches.length - 1)];
  const lastPage = pageOfLine(lines.length);
  const shownPage = Math.min(page, lastPage);
  const start = shownPage * PAGE_LINES;
  const shown = lines.slice(start, start + PAGE_LINES);
  const pageMatches = useMemo(() => {
    const byLine = new Map<number, number[]>();
    for (const match of matches) {
      if (match.line <= start || match.line > start + PAGE_LINES) continue;
      const list = byLine.get(match.line) ?? [];
      list.push(match.start);
      byLine.set(match.line, list);
    }
    return byLine;
  }, [matches, start]);

  useEffect(() => {
    if (tab !== "source") return;
    const match = source.current?.querySelector("[data-current-match]");
    if (match) match.scrollIntoView({ block: "center", inline: "nearest" });
    else if (selected.current) selected.current.scrollIntoView({ block: "center" });
    else if (source.current) source.current.scrollTop = 0;
  }, [tab, active?.line, active?.start, start, file?.path, layout]);

  const step = (delta: number) => {
    if (!matches.length) return;
    const next = (Math.min(current, matches.length - 1) + delta + matches.length) % matches.length;
    setCurrent(next);
    setPage(pageOfLine(matches[next]!.line));
  };
  const openSearch = () => {
    setTab("source"); setMenuOpen(false);
    if (searchOpen) { searchInput.current?.focus(); searchInput.current?.select(); }
    else setSearchOpen(true);
  };
  const closeSearch = () => {
    // Move focus before the bar unmounts so Escape keeps working inside the viewer.
    (searchButton.current ?? heading.current)?.focus();
    setSearchOpen(false);
  };
  const closeMenu = () => {
    if (!menuOpen) return;
    menuButton.current?.focus();
    setMenuOpen(false);
  };
  const copyPath = () => {
    closeMenu();
    setCopyStatus("");
    clearTimeout(copyTimer.current);
    void (async () => {
      try { await navigator.clipboard.writeText(path); setCopyStatus("Path copied"); }
      catch { setCopyStatus("Could not copy path"); }
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopyStatus(""), 3000);
    })();
  };
  const onKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation();
      if (menuOpen) { setMenuOpen(false); menuButton.current?.focus(); }
      else if (searchOpen) closeSearch();
      else onClose();
    } else if (file && (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "f") {
      event.preventDefault(); event.stopPropagation();
      openSearch();
    }
  };

  const sheet = layout === "sheet";
  const back = <Button size="sm" className="pc-file-viewer__back" aria-keyshortcuts="Escape" onClick={onClose}>Back to terminal{!sheet && <span aria-hidden="true"><Kbd>Esc</Kbd></span>}</Button>;
  const search = file && <IconButton ref={searchButton} size="sm" variant="quiet" aria-label="Search" title="Search (⌘F)" aria-keyshortcuts="Meta+F Control+F" aria-expanded={searchOpen} onClick={() => searchOpen ? closeSearch() : openSearch()}><Glyph name="search"/></IconButton>;
  const copy = <IconButton size="sm" variant="quiet" aria-label="Copy path" title="Copy path" onClick={copyPath}><Glyph name="copy"/></IconButton>;
  const refresh = file && <IconButton size="sm" variant="quiet" aria-label="Refresh" title="Refresh" aria-busy={loading} onClick={() => { closeMenu(); onRefresh(); }}><Glyph name="refresh"/></IconButton>;
  const failure = error && describeFileError(error, path);
  const caption = tab === "source" ? "Raw text with line numbers" : file?.kind === "markdown" ? "Rendered Markdown" : "Rendered in an isolated frame";

  const sourceView = file && <>
    {line && line > lines.length && <p className="pc-file-viewer__notice" role="status">Line {line} is beyond the end of this file ({plural(lines.length, "line")}).</p>}
    {lines.length > PAGE_LINES && <div className="pc-file-viewer__banner pc-file-viewer__banner--warn">
      <span role="status">Showing lines {start + 1}–{start + shown.length} of {lines.length}; search covers the whole file</span>
      <span className="pc-file-viewer__banner-actions">
        <Button size="sm" variant="quiet" disabled={shownPage === 0} onClick={() => setPage(shownPage - 1)}>Previous lines</Button>
        <Button size="sm" variant="quiet" disabled={shownPage >= lastPage} onClick={() => setPage(shownPage + 1)}>Next lines</Button>
      </span>
    </div>}
    <div className="pc-file-viewer__source" role="region" aria-label="File source" tabIndex={0} ref={source}>
      {shown.map((text, index) => {
        const number = start + index + 1;
        const targeted = number === file.line;
        return <div key={number} ref={targeted ? selected : undefined}
          className={`pc-file-viewer__line${targeted ? " pc-file-viewer__line--selected" : ""}`}
          aria-current={targeted ? "location" : undefined}>
          <span className="pc-file-viewer__number" aria-label={`Line ${number}`}>{number}</span>
          <span><Highlighted text={text} starts={pageMatches.get(number) ?? []} length={query.length} current={active?.line === number ? active.start : undefined} column={targeted ? file.column : undefined}/></span>
        </div>;
      })}
    </div>
  </>;

  const preview = file?.kind === "html" ? <HtmlPreview file={file}/>
    : file?.kind === "markdown" ? <>
    <p className="pc-file-viewer__caption">Raw HTML is removed and remote images are not loaded. Links to workspace files open here.</p>
    <div className="pc-file-viewer__markdown pc-prose" role="region" aria-label={`Preview of ${file.path}`}
      onClick={event => {
        const anchor = (event.target as HTMLElement).closest("a");
        if (!anchor) return;
        event.preventDefault();
        const href = anchor.getAttribute("href") ?? "";
        if (/^https?:\/\//i.test(href)) window.open(href, "_blank", "noopener,noreferrer");
        else {
          const resolved = resolvePreviewReference(file.path, href);
          if (resolved) onOpenFile?.(resolved);
        }
      }} dangerouslySetInnerHTML={{ __html: markdown ?? "Preparing preview…" }}/>
  </> : null;

  const body = failure ? <div className="pc-file-viewer__state" tabIndex={-1} ref={errorPanel} role="group" aria-labelledby={`${id}-state-title`} aria-describedby={`${id}-state-body`}>
    <span className={`pc-file-viewer__state-icon pc-file-viewer__state-icon--${failure.glyph === "changed" ? "info" : failure.glyph === "missing" ? "warn" : "bad"}`}><Glyph name={failure.glyph}/></span>
    <strong id={`${id}-state-title`} className="pc-file-viewer__state-title">{failure.title}</strong>
    <p id={`${id}-state-body`}>{failure.body}</p>
    {(failure.copy || failure.retry) && <div className="pc-file-viewer__state-actions">
      {failure.retry && <Button size="sm" onClick={onRefresh}>Retry</Button>}
      {failure.copy && <Button size="sm" variant="quiet" onClick={copyPath}>Copy path</Button>}
    </div>}
  </div> : !file ? <div className="pc-file-viewer__loading">
    <p role="status" aria-live="polite" className="pc-file-viewer__caption">Reading {path}…</p>
    {skeleton && <div className="pc-file-viewer__skeleton" aria-hidden="true">{Array.from({ length: 8 }, (_, index) => <span key={index}/>)}</div>}
  </div> : canPreview ? <>
    <Tabs label="File view" id={id} value={tab} onChange={value => setTab(value as "source" | "preview")} options={[{ value: "source", label: "Source" }, { value: "preview", label: "Preview" }]}/>
    <div id={`${id}-${tab}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}-tab`} className="pc-file-viewer__panel" tabIndex={tab === "preview" ? 0 : undefined}>
      <p className="pc-file-viewer__caption">{caption}</p>
      {tab === "source" ? sourceView : preview}
    </div>
  </> : sourceView;

  const actions = <div className="pc-file-viewer__actions" ref={actionsRef}
    onFocusOut={event => { const next = event.relatedTarget as Node | null; if (menuOpen && next && !event.currentTarget.contains(next)) setMenuOpen(false); }}>
    {search}
    {sheet ? <>
      <IconButton ref={menuButton} size="sm" variant="quiet" aria-label="More file actions" aria-expanded={menuOpen} aria-controls={`${id}-more`} onClick={() => setMenuOpen(open => !open)}><Glyph name="more"/></IconButton>
      {menuOpen && <div id={`${id}-more`} className="pc-file-viewer__menu" role="group" aria-label="File actions">
        <Button size="sm" variant="quiet" onClick={copyPath}><Glyph name="copy"/>Copy path</Button>
        {file && <Button size="sm" variant="quiet" aria-busy={loading} onClick={() => { closeMenu(); onRefresh(); }}><Glyph name="refresh"/>Refresh</Button>}
      </div>}
    </> : <>{copy}{refresh}{back}</>}
  </div>;
  const viewer = <section ref={root} className={`pc-file-viewer pc-file-viewer--${layout}`} data-layout={layout} aria-label={`File viewer: ${path}`} onKeyDown={onKeyDown}>
    <header className="pc-file-viewer__head">
      <div className="pc-file-viewer__row pc-file-viewer__row--primary">
        {sheet && back}
        {sheet && actions}
        <div className="pc-file-viewer__title" ref={heading} tabIndex={-1}>
          <span className="pc-file-viewer__glyph" aria-hidden="true">{failure?.glyph === "binary" ? "BIN" : fileGlyph(path)}</span>
          <strong title={path}>{name}</strong>
          <Pill>Read-only</Pill>
        </div>
        {!sheet && actions}
      </div>
      <div className="pc-file-viewer__row pc-file-viewer__row--meta">
        <code className="pc-file-viewer__path" title={path}>{path}</code>
        {line && <Pill tone="info">Line {line}</Pill>}
        {file && loading && <span role="status" className="pc-file-viewer__caption">Reading {path}…</span>}
        {copyStatus && <span role="status" className="pc-file-viewer__caption">{copyStatus}</span>}
      </div>
    </header>
    {searchOpen && file && <div className="pc-file-viewer__search" role="search" aria-label="Search file">
      <TextInput ref={searchInput} aria-label="Search file" placeholder="Search file" value={query}
        onInput={event => setQuery(event.currentTarget.value)}
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); step(event.shiftKey ? -1 : 1); } }}/>
      <span className="pc-file-viewer__count" role="status" aria-live="polite">{query ? matches.length ? `${Math.min(current, matches.length - 1) + 1} of ${matches.length}` : "No matches" : ""}</span>
      {query && <>
        <IconButton size="sm" variant="quiet" aria-label="Previous match" disabled={!matches.length} onClick={() => step(-1)}><Glyph name="up"/></IconButton>
        <IconButton size="sm" variant="quiet" aria-label="Next match" disabled={!matches.length} onClick={() => step(1)}><Glyph name="down"/></IconButton>
      </>}
      <Button size="sm" variant="quiet" aria-pressed={matchCase} onClick={() => setMatchCase(value => !value)}>Match case</Button>
      <IconButton size="sm" variant="quiet" aria-label="Close search" onClick={closeSearch}><Glyph name="close"/></IconButton>
    </div>}
    {body}
    {file && <footer className="pc-file-viewer__foot">
      <span>{languageName(file.path)}</span><span>{formatSize(file.size)}</span><span>{plural(lines.length, "line")}</span>{file.line && <span>Ln {file.line}</span>}
    </footer>}
  </section>;
  return <NarrowContext.Provider value={sheet || narrow}>{viewer}</NarrowContext.Provider>;
}
