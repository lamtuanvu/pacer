import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { TaskDetail } from "../../../../src/core/task-detail";
import { executorLabel } from "../../../../src/view-model/words";
import { Icon } from "../../ds/icons";
import type { Status } from "../../../../src/view-model/words";
import { Button, IconButton } from "../../ds/Button";
import { tabStep } from "../../ds/Patterns";
import { DisclosurePanel } from "../../ds/Page";
import { EmptyState, LoadingState } from "../../ds/Patterns";
import { SectionHeading } from "../../ds/SectionHeading";
import { StatusDot } from "../../ds/StatusDot";
import { AgentMark } from "../../ds/AgentMark";
import { StatusPill } from "../../ds/StatusPill";
import { UsageMeter } from "../../ds/UsageMeter";
import { compactCount } from "../../../../src/view-model/task-tree";
import { paceStatus, taskStatus } from "../../../../src/view-model/words";
import { markAgent } from "../../../../src/view-model/agents";
import type { AccountSummary } from "../../../../src/api/read-model/types";
import type { SessionFileResult } from "../../../../src/session/files";
import { parseDiff } from "../../model/diff";
import { useFrame, useFrameHeading } from "../../shell/slots";
import { useNavigation } from "../../navigation";
import { hrefFor, routes } from "../../router";

export type SessionPanelTab = "changes" | "details" | "work";
export interface ChangedFile { path: string; added: number; removed: number; status?: "added" | "modified" | "deleted" | "renamed" }
export interface TaskDiff { patch: string; untracked: string[]; truncated: boolean; files?: ChangedFile[]; note?: string }

/** Title-bar facts and actions for a task's session: status, elapsed time, repository, the details toggle, then actions. */
export function SessionTitle({ status, live, facts, repo, branch, actions, next }: {
  status: Status; live: boolean; facts: string[]; repo?: string; branch?: string | null; actions?: ComponentChildren;
  /** The task's next step, which lives in the right panel. While that panel is closed it stays reachable here. */
  next?: { label: string; tab: SessionPanelTab; open: (tab: SessionPanelTab) => void };
}) {
  const details = useFrame()?.details;
  const caption = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const node = caption.current!;
    // Optional facts yield as whole items; only the branch may ellipsize.
    const fit = () => {
      const repo = node.querySelector<HTMLElement>(".pc-session-title-repo");
      const branch = node.querySelector<HTMLElement>(".pc-session-title-branch");
      const times = [...node.querySelectorAll<HTMLElement>(".pc-session-title-time")];
      const optional = [repo, branch, ...times].filter((item): item is HTMLElement => !!item);
      optional.forEach(item => { item.hidden = false; });
      const gap = parseFloat(getComputedStyle(node).columnGap);
      let remaining = node.clientWidth - node.firstElementChild!.getBoundingClientRect().width;
      if (repo) {
        const width = repo.scrollWidth + gap;
        repo.hidden = remaining < width;
        if (!repo.hidden) remaining -= width;
      }
      const branchMin = branch ? parseFloat(getComputedStyle(branch).minWidth) : 0;
      if (branch) branch.hidden = repo?.hidden === true || remaining < branchMin + gap;
      for (const time of times) {
        const width = time.scrollWidth + gap;
        time.hidden = repo?.hidden === true || remaining < width + (branch && !branch.hidden ? branchMin + gap : 0);
        if (!time.hidden) remaining -= width;
      }
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    return () => observer.disconnect();
  }, [repo, branch, status.label, facts.join("\n")]);
  // An action that can no longer work disappears (End session once ended); focus then stays in the group.
  const group = useRef<HTMLDivElement>(null), within = useRef(false);
  useEffect(() => {
    if (within.current && document.activeElement === document.body) (group.current?.querySelector<HTMLElement>("button") ?? document.querySelector<HTMLElement>('[aria-label="Toggle details panel"]'))?.focus();
  });
  return <>
    <span ref={caption} className="pc-session-title-facts"><StatusDot tone={status.tone} live={live} label={status.label} /><span className="pc-session-title-extras">
      {repo && <span className="pc-session-title-repo" title="Repository">{repo}</span>}
      {branch && <span className="pc-session-title-branch" title="Branch"><Icon name="branch" /><span>{branch}</span></span>}
      {facts.filter(Boolean).map(fact => <span className="pc-session-title-time" key={fact} title={fact}>{fact}</span>)}</span></span>
    <div ref={group} className="pc-session-title-actions" role="group" aria-label="Session actions" onFocusIn={() => { within.current = true; }}
      onFocusOut={event => { if (event.relatedTarget) within.current = group.current!.contains(event.relatedTarget as Node); }}>
      {next && details && !details.open && <Button size="sm" variant="primary" onClick={() => next.open(next.tab)}>{next.label}</Button>}
      {actions}
    </div>
  </>;
}

/** Every file the worktree changed, then the full patch behind a disclosure. */
export function WorktreeChanges({ diff, loading, error }: { diff?: TaskDiff | null; loading?: boolean; error?: string }) {
  if (error) return <p role="alert">{error}</p>;
  if (!diff) return loading ? <LoadingState label="Loading changes…" /> : <EmptyState title="No changes so far." />;
  const files: ChangedFile[] = [...(diff.files ?? parseDiff(diff.patch)), ...diff.untracked.map(path => ({ path, added: 0, removed: 0, status: "added" as const }))];
  const text = `${diff.patch}${diff.untracked.length ? `\nUntracked files:\n${diff.untracked.join("\n")}` : ""}${diff.truncated ? "\nDiff truncated." : ""}`;
  return <div className="pc-stack pc-stack--compact">
    {diff.note && <p className="muted">{diff.note}</p>}
    {files.length ? <>
      <SectionHeading as="h3">{files.length === 1 ? "1 file changed" : `${files.length} files changed`}</SectionHeading>
      <ul className="pc-changed-files" aria-label="Changed files">{files.map(file => <li key={file.path} className="pc-changed-files__row">
        <span className="pc-changed-files__path" title={file.path}>{file.path}</span>
        {file.status === "added" ? <span className="pc-changed-files__stat">new</span>
          : file.status === "deleted" ? <span className="pc-changed-files__stat pc-changed-files__stat--removed">deleted</span>
          : <span className="pc-changed-files__stat"><span className="pc-changed-files__stat--added">+{file.added}</span> <span className="pc-changed-files__stat--removed">−{file.removed}</span></span>}
      </li>)}</ul>
      {diff.patch && <DisclosurePanel summary="Full diff"><pre className="mono pc-code-scroll" tabIndex={0} aria-label="Full diff">{text}</pre></DisclosurePanel>}
    </> : !diff.note && <EmptyState title="No changes so far." />}
  </div>;
}

/** The frame owns the h1; the session header retains its content and actions. */
export function SessionHeader({ task, onEnd, busy }: { task: TaskDetail; onEnd?: () => void; busy?: boolean }) {
  const {current} = useNavigation();
  const title = task.title?.trim() || task.fullTitle?.trim() || task.goal;
  useFrameHeading({ title, agent: markAgent(task.executor ?? "unknown") });
  const header = useRef<HTMLElement>(null), couldEnd = useRef(!!onEnd);
  useEffect(() => {
    const ended = couldEnd.current && !onEnd;
    couldEnd.current = !!onEnd;
    if (!ended) return;
    const frame = requestAnimationFrame(() => {
      if (document.activeElement === document.body) header.current?.querySelector<HTMLAnchorElement>("a")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [!!onEnd]);
  return <header ref={header} className="pc-session-bar"><AgentMark agent={markAgent(task.executor ?? "unknown")} size={20}/>
    <h2 title={title}>{title}</h2><span className="pc-session-bar__caption" title={`${task.repo.label} · ${task.branch ?? ""}`}>{task.repo.label}{task.branch && ` · ${task.branch}`}</span>
    <StatusPill status={taskStatus(task)}/><span className="pc-session-bar__spacer"/>
    <a className="pc-text-action" href={hrefFor(routes.trace(task.id,current.query))}>Dispatch trace</a>
    {onEnd && <Button size="bar" className="pc-session-end" busy={busy} onClick={onEnd} title="End session (asks to confirm)">End session</Button>}
  </header>;
}

/** Side-panel tabs preserve file views independently of Details and Changes. */
export function SessionPanel({ id, tab, onTab, changes, details, work, count = 0, readFile }: {
  id: string; tab: SessionPanelTab; onTab: (tab: SessionPanelTab) => void; changes: ComponentChildren; details: ComponentChildren; work?: ComponentChildren;
  count?: number; readFile?: (reference: string) => Promise<SessionFileResult>;
}) {
  const [opened, setOpened] = useState<string[]>([]), [selected, setSelected] = useState<string>();
  const [Viewer, setViewer] = useState<typeof import("./FileViewer")["FileViewer"]>();
  const [file, setFile] = useState<SessionFileResult>(), [error, setError] = useState<{code:string;message:string}>(), [loading, setLoading] = useState(false);
  const request = useRef(0);
  const open = async (reference: string) => {
    const revision = ++request.current;
    setSelected(reference); setOpened(paths => paths.includes(reference) ? paths : [...paths, reference]); setFile(undefined); setError(undefined); setLoading(true);
    try {
      const module = await import("./FileViewer");
      if (revision === request.current) setViewer(() => module.FileViewer);
      const result = await readFile!(reference);
      if (revision === request.current) setFile(result);
    } catch (e) { if (revision === request.current) setError({code:"read_failed",message:e instanceof Error ? e.message : "Could not read file."}); }
    finally { if (revision === request.current) setLoading(false); }
  };
  const close = (path: string) => {
    setOpened(paths => paths.filter(item => item !== path));
    if (selected === path) {
      request.current++; setSelected(undefined);
      requestAnimationFrame(() => document.getElementById(`session-${id}-panel-${tab === "work" && !work ? "details" : tab}-tab`)?.focus());
    }
  };
  const base = `session-${id}-panel`, current = selected ?? (tab === "work" && !work ? "details" : tab);
  const tabs = [{ id: "details", label: "Details" }, { id: "changes", label: `Changes ${count}` }, ...(work ? [{ id: "work", label: "Work" }] : []), ...opened.map(path => ({id:path,label:path.split("/").pop()!}))];
  return <div className={`pc-session-panel pc-session-panel--board${selected ? " pc-session-panel--file" : ""}`} onClick={event => {
    const path = (event.target as HTMLElement).closest<HTMLElement>("[data-session-file]")?.dataset.sessionFile;
    if (path && readFile) void open(path);
  }}>
    <div className="pc-panel-tabs"><div role="tablist" aria-label="Session details" className="pc-tabs pc-session-tabs">
      {tabs.map((item, index) => <span className="pc-session-tab" key={item.id}><Button size="sm" role="tab" id={`${base}-${item.id}-tab`} aria-controls={`${base}-${item.id}-panel`} aria-selected={current === item.id} tabIndex={current === item.id ? 0 : -1}
        onClick={() => { if (opened.includes(item.id)) void open(item.id); else { request.current++; setSelected(undefined); onTab(item.id as SessionPanelTab); } }}
        onKeyDown={event => { const next = tabStep(event.key,index,tabs.length); if (next === undefined) return; event.preventDefault(); document.getElementById(`${base}-${tabs[next]!.id}-tab`)?.click(); document.getElementById(`${base}-${tabs[next]!.id}-tab`)?.focus(); }}>{item.label}</Button>
        {opened.includes(item.id) && <IconButton size="sm" variant="quiet" aria-label={`Close ${item.id}`} onClick={() => { close(item.id); requestAnimationFrame(() => document.getElementById(`${base}-details-tab`)?.focus()); }}>×</IconButton>}
      </span>)}
    </div></div>
    <div role="tabpanel" id={`${base}-${current}-panel`} aria-labelledby={`${base}-${current}-tab`} tabIndex={0} className="pc-session-panel__body">
      {selected ? <>{Viewer ? <Viewer sidePanel file={file} reference={selected} loading={loading} error={error} onClose={() => close(selected)} onRefresh={() => void open(selected)} onOpenFile={path => void open(path)}/> : <p role={error ? "alert" : "status"}>{error?.message ?? "Loading file…"}</p>}</> : current === "changes" ? changes : current === "work" ? work : details}
    </div>
  </div>;
}

export function SessionFiles({ id, diff, onOpen }: { id: string; diff?: TaskDiff | null; onOpen?: boolean }) {
  const files: ChangedFile[] = diff ? [...(diff.files ?? parseDiff(diff.patch)), ...diff.untracked.map(path => ({path,added:0,removed:0,status:"added" as const}))] : [];
  return <section><div className="pc-session-files__heading"><SectionHeading as="h3">Changes · {files.length} files</SectionHeading>{files.length > 0 && <a className="pc-text-action" href={`#/tasks/${encodeURIComponent(id)}/review`}>Open diff</a>}</div>
    <ul className="pc-changed-files">{files.map(file => <li className="pc-changed-files__row" key={file.path}>
      {onOpen && file.status !== "deleted" ? <Button variant="quiet" size="sm" className="pc-session-file-link" data-session-file={file.path} title={file.path}>{file.path}</Button> : <span className="pc-changed-files__path" title={file.path}>{file.path}</span>}
      <span className="pc-changed-files__stat--added">{file.status === "added" ? "new" : `+${file.added}`}</span>{file.removed > 0 && <span className="pc-changed-files__stat--removed">−{file.removed}</span>}
    </li>)}</ul>{!files.length && <p className="muted">No changes so far.</p>}
  </section>;
}

/** Workspace facts are exactly the optional values returned by task.get. */
export function SessionWorkspace({ task }: { task: TaskDetail }) {
  const fields = [["Repo", task.repo?.label], ["Branch", task.branch], ["Base", task.base], ["Worktree", task.worktree], ["Machine", task.machine]].filter(([, value]) => !!value);
  if (!fields.length) return null;
  return <section className="pc-session-workspace"><SectionHeading as="h3">Workspace</SectionHeading>
    <dl>{fields.map(([label, value]) => <><dt key={`${label}-label`}>{label}</dt><dd key={label}>{value}</dd></>)}</dl>
  </section>;
}

/** Reported tokens and weekly usage retain their independent sources. */
export function SessionInsights({ task, executor }: { task: TaskDetail; executor?: AccountSummary }) {
  const tokens = task.tokens, reported = tokens && tokens.measuredAttempts + tokens.partialAttempts > 0;
  const agent = executorLabel(task.routing?.chosen ?? task.executor);
  const pace = paceStatus(executor?.verdict ?? "unknown");
  return <>
    {task.routing?.why && <section><SectionHeading as="h3">Why {agent}</SectionHeading><p>{task.routing.policy && task.routing.policy.executors.indexOf(task.routing.chosen) >= 0 && `Ladder step ${task.routing.policy.executors.indexOf(task.routing.chosen) + 1} · `}{task.routing.why}</p><a className="pc-text-action" href={`#/tasks/${encodeURIComponent(task.id)}/trace`}>Dispatch trace</a></section>}
    <section><SectionHeading as="h3">Tokens, live</SectionHeading>
      <span className="pc-session-token-value">{reported ? `${tokens.lowerBound ? "≥ " : ""}${compactCount(tokens.total)}` : "—"}</span>
      <p className="muted">{reported ? "This session" : "No token usage reported yet"}{tokens?.lowerBound ? " · partial usage" : ""}</p>
      <UsageMeter used={executor?.usedPct ?? null} pace={executor?.pacePct ?? null} tone={pace.tone} size="slim" label={`${agent} weekly usage`} text="none"/>
      <p className="muted">{agent} {executor?.usedPct == null ? "weekly usage unknown" : `${executor.usedPct}% of week`} · {pace.label.toLowerCase()}</p>
    </section>
  </>;
}
