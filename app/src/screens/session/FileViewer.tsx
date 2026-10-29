import type { ComponentChildren, JSX } from "preact";
import type { SessionFileResult } from "../../../../src/session/files";
import { Button, IconButton } from "../../ds/Button";
import { TextInput } from "../../ds/Controls";
import { NarrowContext } from "../../ds/Density";
import { Kbd } from "../../ds/Kbd";
import { Tabs } from "../../ds/Patterns";
import { PanelTabs, type PanelTab } from "../../ds/PanelTabs";
import { Pill } from "../../ds/Pill";
import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { blockedResources, htmlPreviewDocument, type BlockedResource } from "./preview-html";

/** Mirrors MAX_FILE_BYTES in src/session/openat.ts (the service's read bound); a test keeps them equal. */
export const PREVIEW_LIMIT_BYTES = 512 * 1024;
/** Lines of a large file loaded at a time; search covers the lines loaded. */
export const PAGE_LINES = 2000;
/** A file over 5 MB or 50,000 lines is large: it loads PAGE_LINES at a time. */
export const LARGE_BYTES = 5 * 1024 * 1024;
export const LARGE_LINES = 50_000;

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
/** Lines loaded when a large file opens: the first page, or enough pages to include the requested line. */
export const initialLoaded = (line?: number) => (pageOfLine(line ?? 1) + 1) * PAGE_LINES;
const count = (value: number) => value.toLocaleString("en-US");
/** "UTF-8 · LF · 96 lines · 3.1 KB": the service only returns UTF-8 text. */
export function fileMeta(text: string, lineCount: number, size: number): string {
  return `UTF-8 · ${text.includes("\r\n") ? "CRLF" : "LF"} · ${lineCount === 1 ? "1 line" : `${count(lineCount)} lines`} · ${formatSize(size)}`;
}

export type ViewerLayout = "pane" | "replace" | "sheet";
/** Side-by-side from 1100 px of terminal container; a full sheet below 768 px. */
export function viewerLayout(width: number): ViewerLayout { return width >= 1100 ? "pane" : width < 768 ? "sheet" : "replace"; }

export interface FileError { code: string; message: string }
export type ErrorGlyph = "missing" | "outside" | "blocked" | "large" | "binary" | "changed";
export interface ErrorState { glyph: ErrorGlyph; title: string; body: string; copy: boolean; retry: boolean }
/** Maps service error codes (falling back to their messages) to the viewer's titled states. */
export function describeFileError(error: FileError, path: string, context: { reference?: string; workspace?: string } = {}): ErrorState {
  const message = error.message;
  const code = ["not_found", "not_allowed", "too_large", "invalid_input", "conflict"].includes(error.code) ? error.code
    : /no longer exists|not found/i.test(message) ? "not_found"
    : /outside the session workspace/i.test(message) ? "not_allowed"
    : /too large/i.test(message) ? "too_large"
    : /binary|utf-8/i.test(message) ? "invalid_input"
    : /attempt has changed/i.test(message) ? "conflict" : error.code;
  if (code === "not_found" && /workspace is unavailable/i.test(message)) return { glyph: "missing", title: "Workspace unavailable", body: "This session's workspace is no longer available; it may have been removed or cleaned up.", copy: true, retry: true };
  if (code === "not_found") return { glyph: "missing", title: "This file isn’t in the workspace", body: `The agent printed ${context.reference ?? path}, but there is no file at that path in ${context.workspace ?? "this workspace"}. It may have been moved, deleted, or not written yet.`, copy: true, retry: true };
  if (code === "not_allowed" && /outside the session workspace/i.test(message)) return { glyph: "outside", title: "Outside this workspace", body: "pacer only opens files inside the session workspace.", copy: true, retry: false };
  if (code === "too_large") return { glyph: "large", title: "Too large to preview", body: `pacer previews files up to ${PREVIEW_LIMIT_BYTES / 1024} KB.`, copy: true, retry: false };
  if (code === "invalid_input" && /binary|utf-8/i.test(message)) return { glyph: "binary", title: "pacer can’t show this file", body: `${path.split("/").at(-1) || path} is a binary file or isn’t UTF-8 text. The viewer shows text files only.`, copy: true, retry: false };
  if (code === "conflict") return { glyph: "changed", title: "This session changed", body: "The agent's attempt moved on. Refresh the session.", copy: false, retry: false };
  return { glyph: "blocked", title: "Can't open this file", body: message || "The file could not be opened.", copy: true, retry: false };
}

const paths: Record<string, string> = {
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4", copy: "M9 9h11v11H9zM5 15H4V4h11v1", refresh: "M20 11a8 8 0 1 0-2 6M20 4v7h-7",
  more: "M6.5 12a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM13.5 12a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM20.5 12a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z", up: "M6 15l6-6 6 6", down: "M6 9l6 6 6-6", close: "M6 6l12 12M18 6 6 18",
  missing: "M6 3h8l4 4v14H6zM10 12l4 4m0-4-4 4", outside: "M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4", blocked: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM6 6l12 12",
  shield: "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z", info: "M12 8h.01M11 12h1v5h1M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", terminal: "M4 5h16v14H4zM8 10l3 2-3 2", external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5", spinner: "M12 3a9 9 0 1 0 9 9", shieldcheck: "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6zM9 12l2 2 4-4",
  large: "M4 4h16v16H4zM9 15l6-6M10 9h5v5", binary: "M4 5h16v14H4zM8 10v4M12 10v4M16 10v4", changed: "M20 11a8 8 0 1 0-2 6M20 4v7h-7",
};
function Glyph({ name, small = false }: { name: keyof typeof paths; small?: boolean }) {
  return <svg className={`pc-file-viewer__icon${small ? " pc-file-viewer__icon--small" : ""}`} width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
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

function Banner({ tone, icon, title, label, children, actions }: { tone: "info" | "warn" | "neutral"; icon: keyof typeof paths; title: string; label?: string; children?: ComponentChildren; actions?: ComponentChildren }) {
  return <div className={`pc-file-viewer__banner pc-file-viewer__banner--${tone}`} role="note" aria-label={label ?? title}>
    <span className="pc-file-viewer__banner-icon" aria-hidden="true"><Glyph name={icon}/></span>
    <span className="pc-file-viewer__banner-body"><strong>{title}</strong>{children}{actions && <span className="pc-file-viewer__banner-actions">{actions}</span>}</span>
  </div>;
}

/** The sandboxed static preview with its blocked-resource banner. */
export function HtmlPreview({ file }: { file: SessionFileResult }) {
  const blocked = useMemo(() => blockedResources(file.text), [file.text]);
  const scripts = blocked.filter(item => item.kind === "script").length;
  const requests = blocked.filter(item => item.kind !== "script" && !item.local && !item.inline).length;
  return <>
    <Banner tone="info" icon="shield" title="Preview is isolated from pacer">
      <span>Scripts don’t run, inline styles aren’t applied and nothing loads from the network. {plural(scripts, "script")} and {plural(requests, "external request")} were blocked.</span>
      <BlockedList items={blocked}/>
    </Banner>
    <div className="pc-file-viewer__html">
      <p className="pc-file-viewer__caption pc-file-viewer__isolation"><Glyph name="shieldcheck" small/>Sandboxed frame · separate origin · no scripts · no network · no access to pacer</p>
      <iframe className="pc-file-viewer__preview" title={`Preview of ${file.path}`} sandbox="" tabIndex={-1} referrerPolicy="no-referrer" srcDoc={htmlPreviewDocument(file.text)}/>
    </div>
  </>;
}

/** The side-panel tab a viewed file occupies: its file name, after Details and Changes. */
export function fileTab(path: string): PanelTab { return { id: `file:${path}`, label: path.split("/").at(-1) || path, icon: "files" }; }
const clock = (date: Date) => date.toLocaleTimeString("en-GB", { hour12: false });

export function FileViewer({ file, reference, error, loading = false, workspace, running = false, agent, onClose, onRefresh, onOpenFile, onOpenInEditor, sidePanel = false }: {
  /** The session frame already owns desktop pane placement. */
  sidePanel?: boolean;
  file?: SessionFileResult;
  /** A read is in flight; a refreshed file stays visible until the new text arrives. */
  loading?: boolean;
  /** The terminal reference being read; shown while loading and on errors. */
  reference?: string;
  error?: FileError;
  /** The worktree the path is relative to, shown before the path. */
  workspace?: string;
  /** The terminal session is still running while the file is read. */
  running?: boolean;
  /** Display name of the agent whose terminal printed the path, shown in the footer. */
  agent?: string;
  onClose: () => void;
  onRefresh: () => void;
  onOpenFile?: (reference: string) => void;
  /** The host's hand-off to the user's own editor; the action is offered only where one exists. */
  onOpenInEditor?: (path: string, line?: number) => void;
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
  const [loaded, setLoaded] = useState(initialLoaded(line));
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
  const failedAt = useMemo(() => clock(new Date()), [error]);
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
    const update = () => setLayout(sidePanel && !narrow ? "pane" : viewerLayout(host.clientWidth));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, [sidePanel, narrow]);
  useLayoutEffect(() => { heading.current?.focus(); }, []);
  useLayoutEffect(() => {
    if (error) errorPanel.current?.focus();
    // Retry can remove the focused control; keep focus inside the viewer.
    else if (!document.activeElement || document.activeElement === document.body) heading.current?.focus();
  }, [error, file]);
  useEffect(() => {
    if (file || error) { setSkeleton(false); return; }
    const timer = setTimeout(() => setSkeleton(true), 150);
    return () => clearTimeout(timer);
  }, [file, error]);
  // Layout effects run before the next input event, so a reset never undoes a choice the user just made.
  // A refresh of the same location (only `modified` changes) keeps the chosen tab and loaded lines.
  const identity = file ? `${file.path}\n${file.line ?? ""}\n${file.column ?? ""}` : "";
  const shownIdentity = useRef(identity);
  useLayoutEffect(() => {
    if (shownIdentity.current === identity) return;
    shownIdentity.current = identity;
    setTab("source"); setLoaded(initialLoaded(file?.line)); setMarkdown(null); setCurrent(0);
  }, [identity]);
  useEffect(() => {
    if (file?.kind !== "markdown" || tab !== "preview") return;
    let active = true;
    void import("./preview").then(module => { if (active) setMarkdown(module.renderMarkdownPreview(file.text)); });
    return () => { active = false; };
  }, [file?.kind, file?.text, tab]);

  const lines = useMemo(() => splitLines(file?.text ?? ""), [file?.text]);
  const large = lines.length > LARGE_LINES || (file?.size ?? 0) > LARGE_BYTES;
  const shownCount = large ? Math.min(loaded, lines.length) : lines.length;
  const shown = useMemo(() => lines.slice(0, shownCount), [lines, shownCount]);
  // Search covers the lines loaded, and the large-file banner says so.
  const matches = useMemo(() => searchOpen ? findMatches(shown, query, matchCase) : [], [shown, query, matchCase, searchOpen]);
  useLayoutEffect(() => { setCurrent(0); }, [matches]);
  useLayoutEffect(() => {
    if (searchOpen) { searchInput.current?.focus(); searchInput.current?.select(); }
  }, [searchOpen]);
  const active = matches[Math.min(current, matches.length - 1)];
  const pageMatches = useMemo(() => {
    const byLine = new Map<number, number[]>();
    for (const match of matches) {
      const list = byLine.get(match.line) ?? [];
      list.push(match.start);
      byLine.set(match.line, list);
    }
    return byLine;
  }, [matches]);

  useEffect(() => {
    if (tab !== "source") return;
    const container = source.current;
    const anchor = container?.querySelector<HTMLElement>("[data-current-match]")?.closest<HTMLElement>(".pc-file-viewer__line") ?? selected.current;
    if (container && anchor) {
      // The linked line or current match sits in the upper third of the view.
      const top = anchor.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
      container.scrollTop = Math.max(0, top - container.clientHeight / 3);
    } else if (container) container.scrollTop = 0;
  }, [tab, active?.line, active?.start, file?.path, file?.line, layout]);

  const step = (delta: number) => {
    if (!matches.length) return;
    setCurrent((Math.min(current, matches.length - 1) + delta + matches.length) % matches.length);
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
  const openInEditor = onOpenInEditor && (() => { closeMenu(); onOpenInEditor(path, line); });
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
  const back = <Button size="sm" className="pc-file-viewer__back" aria-label="Back to terminal" aria-keyshortcuts="Escape" title="Back to terminal" onClick={onClose}>
    <Glyph name="terminal" small/>{sheet ? "Terminal" : "Back to terminal"}{!sheet && <span aria-hidden="true"><Kbd>Esc</Kbd></span>}</Button>;
  const search = file && <IconButton ref={searchButton} size="sm" variant="quiet" className="pc-file-viewer__ib" aria-label="Search" title="Search (⌘F)" aria-keyshortcuts="Meta+F Control+F" aria-expanded={searchOpen} onClick={() => searchOpen ? closeSearch() : openSearch()}><Glyph name="search"/></IconButton>;
  const copy = <IconButton size="sm" variant="quiet" className="pc-file-viewer__ib" aria-label="Copy path" title="Copy path" onClick={copyPath}><Glyph name="copy"/></IconButton>;
  const editor = openInEditor && <IconButton size="sm" variant="quiet" className="pc-file-viewer__ib" aria-label="Open in editor" title="Open in editor" onClick={openInEditor}><Glyph name="external"/></IconButton>;
  const failure = error && describeFileError(error, path, { reference, workspace });
  const caption = tab === "source" ? "Raw text with line numbers" : file?.kind === "markdown" ? "Rendered Markdown" : "Rendered in an isolated frame";

  const sourceView = file && <>
    {line && line > lines.length && <p className="pc-file-viewer__notice" role="status">Line {line} is beyond the end of this file ({plural(lines.length, "line")}).</p>}
    {large && <Banner tone="warn" icon="info" title={`Large file: showing the first ${count(shownCount)} lines`} label="Large file"
      actions={<>
        {shownCount < lines.length && <Button size="sm" onClick={() => setLoaded(shownCount + PAGE_LINES)}>Show next {count(Math.min(PAGE_LINES, lines.length - shownCount))} {lines.length - shownCount === 1 ? "line" : "lines"}</Button>}
        {openInEditor && <Button size="sm" variant="ghost" onClick={openInEditor}>Open in editor</Button>}
      </>}>
      <span role="status">{name} is {formatSize(file.size)} ({count(lines.length)} lines). Search covers the lines shown.</span>
    </Banner>}
    <div className="pc-file-viewer__source" role="region" aria-label="File source" tabIndex={0} ref={source}>
      <div className="pc-file-viewer__code">
        {shown.map((text, index) => {
          const number = index + 1;
          const targeted = number === file.line;
          return <div key={number} ref={targeted ? selected : undefined}
            className={`pc-file-viewer__line${targeted ? " pc-file-viewer__line--selected" : ""}`}
            aria-current={targeted ? "location" : undefined}>
            <span className="pc-file-viewer__number" aria-label={`Line ${number}`}>{number}</span>
            <span><Highlighted text={text} starts={pageMatches.get(number) ?? []} length={query.length} current={active?.line === number ? active.start : undefined} column={targeted ? file.column : undefined}/></span>
          </div>;
        })}
      </div>
    </div>
  </>;

  const preview = file?.kind === "html" ? <HtmlPreview file={file}/>
    : file?.kind === "markdown" ? <>
    <Banner tone="neutral" icon="info" title="Rendered safely"><span>Raw HTML is removed and remote images are not loaded. Links to files in this workspace open here.</span></Banner>
    <div className="pc-file-viewer__markdown pc-prose" role="region" tabIndex={0} aria-label={`Preview of ${file.path}`}
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
      {failure.copy && <Button size="sm" variant="ghost" onClick={copyPath}>Copy path</Button>}
      {openInEditor && failure.glyph === "binary" && <Button size="sm" onClick={openInEditor}>Open in editor</Button>}
    </div>}
    <span className="pc-file-viewer__caption">{failure.glyph === "binary" ? "Images, PDFs and other binaries open in your own apps" : `Checked ${failedAt} · paths outside the workspace are never opened`}</span>
  </div> : !file ? <div className="pc-file-viewer__loading">
    <p role="status" aria-live="polite" className="pc-file-viewer__caption pc-file-viewer__reading"><Glyph name="spinner" small/>Reading {path}…</p>
    {skeleton && <div className="pc-file-viewer__skeleton" aria-hidden="true">{Array.from({ length: 14 }, (_, index) => <span key={index} className="pc-file-viewer__skeleton-row"><span className="pc-file-viewer__skeleton-number"/><span/></span>)}</div>}
  </div> : canPreview ? <div id={`${id}-${tab}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}-tab`} className="pc-file-viewer__panel" tabIndex={tab === "preview" && file?.kind === "html" ? 0 : undefined}>
    {tab === "source" ? sourceView : preview}
  </div> : sourceView;

  const actions = <div className="pc-file-viewer__actions" ref={actionsRef}
    onFocusOut={event => { const next = event.relatedTarget as Node | null; if (menuOpen && next && !event.currentTarget.contains(next)) setMenuOpen(false); }}>
    {search}
    {sheet ? <>
      <IconButton ref={menuButton} size="sm" variant="quiet" className="pc-file-viewer__ib" aria-label="More file actions" aria-expanded={menuOpen} aria-controls={`${id}-more`} onClick={() => setMenuOpen(open => !open)}><Glyph name="more"/></IconButton>
      {menuOpen && <div id={`${id}-more`} className="pc-file-viewer__menu" role="group" aria-label="File actions">
        <Button size="sm" variant="quiet" onClick={copyPath}><Glyph name="copy"/>Copy path</Button>
        {openInEditor && <Button size="sm" variant="quiet" onClick={openInEditor}><Glyph name="external"/>Open in editor</Button>}
      </div>}
    </> : <>{copy}{editor}{back}</>}
  </div>;
  const footerRight = !file ? "Loading…" : `${file.line ? `Ln ${file.line} · ` : ""}Opened from ${agent ? `${agent} terminal` : "terminal"}`;
  const footerLeft = file ? <><span>{languageName(file.path)}</span><span>{fileMeta(file.text, lines.length, file.size)}</span></> : <span>{languageName(path)}</span>;
  const viewer = <section ref={root} className={`pc-file-viewer pc-file-viewer--${layout}`} data-layout={layout} aria-label={`File viewer: ${path}`} onKeyDown={onKeyDown}>
    {/* Standalone terminal previews own their strip; the session frame supplies its file tab. */}
    {!sidePanel && layout === "pane" && <div className="pc-file-viewer__tabs"><PanelTabs label="Side panel" tabs={[fileTab(path)]} value={fileTab(path).id} onChange={() => undefined}/></div>}
    <header className="pc-file-viewer__head">
      <div className="pc-file-viewer__row pc-file-viewer__row--primary">
        {sheet && back}
        <span className="pc-file-viewer__glyph" aria-hidden="true">{failure?.glyph === "binary" ? "BIN" : fileGlyph(path)}</span>
        <div className="pc-file-viewer__title" ref={heading} tabIndex={-1}>
          <strong title={path}>{name}</strong>
        </div>
        {!sheet && <Pill>Read-only</Pill>}
        {actions}
      </div>
      <div className="pc-file-viewer__row pc-file-viewer__row--meta">
        <code className="pc-file-viewer__path" title={workspace ? `${workspace} / ${path}` : path}>{workspace && <span className="pc-file-viewer__workspace">{workspace} / </span>}{path}</code>
        {sheet && <Pill>Read-only</Pill>}
        {line && <span className="pc-file-viewer__chip">Line {line}</span>}
        {running && <span className="pc-file-viewer__chip" title="The terminal session keeps running while you read"><span className="pc-file-viewer__dot" aria-hidden="true"/>Session running</span>}
        {file && loading && <span role="status" className="pc-file-viewer__caption">Reading {path}…</span>}
        {copyStatus && <span role="status" className="pc-file-viewer__caption">{copyStatus}</span>}
      </div>
      {file && canPreview && <div className="pc-file-viewer__row pc-file-viewer__row--tabs">
        <Tabs label="File view" id={id} value={tab} onChange={value => setTab(value as "source" | "preview")} options={[{ value: "source", label: "Source" }, { value: "preview", label: "Preview" }]}/>
        <span className="pc-file-viewer__caption">{caption}</span>
      </div>}
    </header>
    {searchOpen && file && <div className="pc-file-viewer__search" role="search" aria-label="Search file">
      <label className="pc-file-viewer__field"><Glyph name="search" small/>
        <TextInput ref={searchInput} aria-label="Search file" placeholder="Search file" value={query}
          onInput={event => setQuery(event.currentTarget.value)}
          onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); step(event.shiftKey ? -1 : 1); } }}/>
      </label>
      <span className="pc-file-viewer__count" role="status" aria-live="polite">{query ? matches.length ? `${Math.min(current, matches.length - 1) + 1} of ${matches.length}` : "No matches" : ""}</span>
      <IconButton size="sm" variant="quiet" className="pc-file-viewer__ib" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={!matches.length} onClick={() => step(-1)}><Glyph name="up"/></IconButton>
      <IconButton size="sm" variant="quiet" className="pc-file-viewer__ib" aria-label="Next match" title="Next match (Enter)" disabled={!matches.length} onClick={() => step(1)}><Glyph name="down"/></IconButton>
      <IconButton size="sm" variant="quiet" className="pc-file-viewer__ib pc-file-viewer__case" aria-label="Match case" title="Match case" aria-pressed={matchCase} onClick={() => setMatchCase(value => !value)}>Aa</IconButton>
      <IconButton size="sm" variant="quiet" className="pc-file-viewer__ib" aria-label="Close search" title="Close search (Escape)" onClick={closeSearch}><Glyph name="close"/></IconButton>
    </div>}
    <div className="pc-file-viewer__body" aria-busy={!file && !failure}>{body}</div>
    {!sheet && !failure && <footer className="pc-file-viewer__foot">{footerLeft}<span className="pc-file-viewer__spacer"/><span>{footerRight}</span></footer>}
  </section>;
  return <NarrowContext.Provider value={sheet || narrow}>{viewer}</NarrowContext.Provider>;
}
