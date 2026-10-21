import { FilterChip } from "../ds/Patterns";
import { CountBadge } from "../ds/CountBadge";
import { SearchPicker } from "../ds/SearchPicker";
import { useRef } from "preact/hooks";
import type { ClientSnapshot } from "../../../src/view-model/snapshot";
import { activeRepo, scopeRepo } from "../shell/narrow";
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

export function RepoFilter({ snapshot, query, narrow = false }: { snapshot: ClientSnapshot; query: RouteQuery; narrow?: boolean }) {
  const lastRepo = useRef(query.repo);
  if (query.repo) lastRepo.current = query.repo;
  const { all, chips } = repoChoices(snapshot, query.repo);
  const go = (repo: string | null) => { location.hash = withQuery(location.hash.split("?")[0] || "#/", { ...query, repo }); };
  if (narrow) {
    const here = scopeRepo(query) ?? (query.repo || lastRepo.current) ?? null;
    const selected = activeRepo(query);
    const label = snapshot.repos?.find(repo => repo.key === here)?.label ?? here;
    return <div className="pc-chips pc-scope-toggle" role="group" aria-label="Scope" id="repo-filter">
      <FilterChip disabled={!here} className={`pc-chip pc-btn--touch${selected ? " on" : ""}`} aria-pressed={!!selected} onClick={() => go(here)} aria-describedby={!here?"repo-scope-reason":undefined}>This repo{label ? ` · ${label}` : ""}</FilterChip>{!here&&<span id="repo-scope-reason" className="muted">Choose a repository to use this scope.</span>}
      <FilterChip className={`pc-chip pc-btn--touch${!selected ? " on" : ""}`} aria-pressed={!selected} onClick={() => go("")}>All repos</FilterChip>
    </div>;
  }
  const chip = (repo: string | null, label: string, n?: number) =>
    <FilterChip key={repo ?? "all"} title={label} className={`pc-chip${(query.repo || null) === repo ? " on" : ""}`} aria-pressed={(query.repo || null) === repo ? "true" : "false"} onClick={() => go(repo)}><span className="pc-chip__label">{label}</span>{n !== undefined && <CountBadge count={n} />}</FilterChip>;
  return <div className="pc-filter">
    <div className="pc-chips" role="group" aria-label="Repository filter" id="repo-filter">
      {chip(null, "All repos")}
      {chips.map(repo => chip(repo.key, repo.label, repo.count))}
      {all.length > 0 && <SearchPicker label="Find repo" searchLabel="Search repositories" placeholder="Search repositories…"
        emptyLabel="No matching repositories."
        value={query.repo || null} onChange={go} options={[
          { value: null, label: "All repos" },
          ...all.map(repo => {
            const slash = repo.label.indexOf("/");
            return { value: repo.key, label: slash < 0 ? repo.label : repo.label.slice(slash + 1),
              description: slash < 0 ? undefined : repo.label.slice(0, slash), count: repo.count,
              searchText: `${repo.label} ${repo.key}` };
          }),
        ]} />}
    </div>
    <p className="muted">Budgets are shared across repos; the filter only narrows work.</p>
  </div>;
}
