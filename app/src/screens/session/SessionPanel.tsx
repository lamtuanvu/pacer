import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { Status } from "../../../../src/view-model/words";
import { IconButton } from "../../ds/Button";
import { PanelTabs } from "../../ds/PanelTabs";
import { DisclosurePanel } from "../../ds/Page";
import { EmptyState, LoadingState } from "../../ds/Patterns";
import { SectionHeading } from "../../ds/SectionHeading";
import { StatusDot } from "../../ds/StatusDot";
import { parseDiff } from "../../model/diff";
import { RIGHT_PANEL_ID, useFrame } from "../../shell/slots";

export type SessionPanelTab = "changes" | "details" | "work";
export interface ChangedFile { path: string; added: number; removed: number; status?: "added" | "modified" | "deleted" | "renamed" }
export interface TaskDiff { patch: string; untracked: string[]; truncated: boolean; files?: ChangedFile[]; note?: string }

/** Title-bar facts and actions for a task's session: status, elapsed time, repository, the details toggle, then actions. */
export function SessionTitle({ status, live, facts, actions }: { status: Status; live: boolean; facts: string[]; actions?: ComponentChildren }) {
  const details = useFrame()?.details;
  const name = `${details?.open ? "Hide" : "Show"} session details`;
  // An action that can no longer work disappears (End session once ended); focus then stays in the group.
  const group = useRef<HTMLDivElement>(null), within = useRef(false);
  useEffect(() => {
    if (within.current && document.activeElement === document.body) group.current?.querySelector<HTMLElement>("button")?.focus();
  });
  return <>
    <span className="pc-session-title-facts"><StatusDot tone={status.tone} live={live} label={status.label} />
      {facts.filter(Boolean).map(fact => <span key={fact} title={fact}>{fact}</span>)}</span>
    <div ref={group} className="pc-session-title-actions" role="group" aria-label="Session actions" onFocusIn={() => { within.current = true; }}
      onFocusOut={event => { if (event.relatedTarget) within.current = group.current!.contains(event.relatedTarget as Node); }}>
      {details && <IconButton size="sm" variant="quiet" icon="panel-right" aria-label={name} title={`${name} (Ctrl+Shift+B)`} aria-keyshortcuts="Control+Shift+B"
        aria-expanded={details.open} aria-controls={details.open ? RIGHT_PANEL_ID : undefined} onClick={details.toggle} />}
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
