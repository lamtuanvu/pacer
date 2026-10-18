import { useState } from "preact/hooks";
import type { ClientSnapshot } from "../../../src/view-model/snapshot";
import { withQuery, type RouteQuery } from "../router";

export function repoChoices(snapshot: ClientSnapshot, active: string | null) {
  const lastUse = new Map<string, number>();
  for (const task of snapshot.tasks) if (task.repo) lastUse.set(task.repo.key, Math.max(lastUse.get(task.repo.key) ?? 0, task.updatedAt));
  for (const item of snapshot.attention ?? []) if (item.repo) lastUse.set(item.repo.key, Math.max(lastUse.get(item.repo.key) ?? 0, item.raisedAt));
  const all = (snapshot.repos ?? []).map(repo => ({ ...repo,
    count: (snapshot.counts?.byRepo[repo.key]?.attention ?? 0) + (snapshot.counts?.byRepo[repo.key]?.running ?? 0),
    today: snapshot.today?.byRepo[repo.key] ?? 0,
    lastUse: lastUse.get(repo.key) ?? 0,
  })).sort((a, b) => b.count - a.count || b.lastUse - a.lastUse || a.label.localeCompare(b.label));
  const selected = all.find(repo => repo.key === active);
  const chips = all.filter(repo => repo.count > 0 || repo.today > 0).slice(0, 5);
  if (selected && !chips.includes(selected)) {
    if (chips.length === 5) chips.pop();
    chips.push(selected);
  }
  return { all, chips };
}

export function RepoList({ snapshot, active, search, onSelect }: { snapshot: ClientSnapshot; active: string | null; search: string; onSelect: (repo: string) => void }) {
  const matches = repoChoices(snapshot, active).all.filter(repo => `${repo.label} ${repo.key}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <div className="pc-repo-list" role="group" aria-label="All repositories">
    {matches.map(repo => <button type="button" key={repo.key} aria-pressed={repo.key === active} onClick={() => onSelect(repo.key)}>{repo.label} <span className="muted">{repo.count}</span></button>)}
    {!matches.length && <p className="muted">No matching repositories.</p>}
  </div>;
}

export function RepoFilter({ snapshot, query }: { snapshot: ClientSnapshot; query: RouteQuery }) {
  const [open, setOpen] = useState(false), [search, setSearch] = useState("");
  const { all, chips } = repoChoices(snapshot, query.repo);
  const go = (repo: string | null) => { location.hash = withQuery(location.hash.split("?")[0] || "#/", { ...query, repo }); setOpen(false); };
  const chip = (repo: string | null, label: string, n?: number) =>
    <button type="button" key={repo ?? "all"} className={`pc-chip${query.repo === repo ? " on" : ""}`} aria-pressed={query.repo === repo ? "true" : "false"} onClick={() => go(repo)}>{label}{n !== undefined && <> <span className="pc-chip__n">{n}</span></>}</button>;
  return <div className="pc-filter">
    <div className="pc-chips" role="group" aria-label="Repository filter" id="repo-filter">
      {chip(null, "All repos")}
      {chips.map(repo => chip(repo.key, repo.label, repo.count))}
      {all.length > chips.length && <div className="pc-repo-picker">
        <button type="button" className="pc-chip" aria-expanded={open} aria-controls="more-repos" onClick={() => setOpen(value => !value)}>More repos ▾</button>
        {open && <div className="pc-repo-popover" id="more-repos" onKeyDown={event => { if (event.key === "Escape") { setOpen(false); event.currentTarget.parentElement?.querySelector("button")?.focus(); } }}>
          <input id="repo-search" autoFocus type="search" aria-label="Search repositories" placeholder="Search repositories…" value={search} onInput={event => setSearch(event.currentTarget.value)} />
          <RepoList snapshot={snapshot} active={query.repo} search={search} onSelect={go} />
        </div>}
      </div>}
    </div>
    <p className="muted">Budgets are shared across repos; the filter only narrows work.</p>
  </div>;
}
