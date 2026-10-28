import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import type { TaskDetail } from "../../../../src/core/task-detail";
import { executorLabel } from "../../../../src/view-model/words";
import { Icon } from "../../ds/icons";
import type { Status } from "../../../../src/view-model/words";
import { Button } from "../../ds/Button";
import { PanelTabs } from "../../ds/PanelTabs";
import { DisclosurePanel } from "../../ds/Page";
import { EmptyState, LoadingState } from "../../ds/Patterns";
import { SectionHeading } from "../../ds/SectionHeading";
import { StatusDot } from "../../ds/StatusDot";
import { parseDiff } from "../../model/diff";
import { useFrame } from "../../shell/slots";

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

/** Right-panel tabs for a task's session. Only the selected tab's content is mounted. */
export function SessionPanel({ id, tab, onTab, changes, details, work }: {
  id: string; tab: SessionPanelTab; onTab: (tab: SessionPanelTab) => void; changes: ComponentChildren; details: ComponentChildren; work?: ComponentChildren;
}) {
  const base = `session-${id}-panel`;
  const tabs = [{ id: "changes", label: "Changes" }, { id: "details", label: "Details" }, ...(work ? [{ id: "work", label: "Work" }] : [])];
  const current = tab === "work" && !work ? "details" : tab;
  return <div className="pc-session-panel">
    <PanelTabs id={base} label="Session details" tabs={tabs} value={current} onChange={value => onTab(value as SessionPanelTab)} />
    <div role="tabpanel" id={`${base}-${current}-panel`} aria-labelledby={`${base}-${current}-tab`} tabIndex={0} className="pc-session-panel__body">
      {current === "changes" ? changes : current === "work" ? work : details}
    </div>
  </div>;
}

/** Workspace facts are exactly the optional values returned by task.get. */
export function SessionWorkspace({ task }: { task: TaskDetail }) {
  const fields = [["Repo", task.repo?.label], ["Branch", task.branch], ["Base", task.base], ["Worktree", task.worktree], ["Machine", task.machine]].filter(([, value]) => !!value);
  if (!fields.length) return null;
  return <section className="pc-session-workspace"><SectionHeading as="h3">Workspace</SectionHeading>
    <dl>{fields.map(([label, value]) => <><dt key={`${label}-label`}>{label}</dt><dd key={label}>{value}</dd></>)}</dl>
  </section>;
}

/** No capacity estimates or invented usage: only the routing explanation and reported tokens. */
export function SessionInsights({ task }: { task: TaskDetail }) {
  const tokens = task.tokens, reported = tokens && tokens.measuredAttempts + tokens.partialAttempts > 0;
  return <>
    {task.routing?.why && <section><SectionHeading as="h3">Why {executorLabel(task.routing.chosen)}</SectionHeading><p>{task.routing.why}</p></section>}
    {reported && <section><SectionHeading as="h3">Tokens</SectionHeading>
      <p className="mono">{tokens.lowerBound ? "≥ " : ""}{tokens.total.toLocaleString("en-US")}</p>
      {!tokens.lowerBound && <dl className="pc-session-token-counts">{([["Input", "input"], ["Cache read", "cacheRead"], ["Cache write", "cacheWrite"], ["Output", "output"]] as const).filter(([, field]) => tokens.reported?.[field]).map(([label, field]) => <><dt key={`${label}-label`}>{label}</dt><dd key={label}>{tokens.complete?.[field] === false ? "≥ " : ""}{tokens[field].toLocaleString("en-US")}{tokens.complete?.[field] === false && <div className="muted">Some attempts did not report this field.</div>}</dd></>)}</dl>}
      {tokens.lowerBound && <p className="muted">Partial usage; some attempt tokens are not reported.</p>}
    </section>}
  </>;
}
