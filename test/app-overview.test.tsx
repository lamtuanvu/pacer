import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import fixture from "./fixtures/ui/snapshot.json";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import type { ActivityEntry } from "../src/api/read-model/types";
import { createActionRunner } from "../app/src/data/actions";
import { OverviewView } from "../app/src/screens/Overview";
import { RepoFilter, repoChoices } from "../app/src/screens/RepoFilter";

const snap = fixture as unknown as ClientSnapshot;
const runner = createActionRunner({ call: async <T,>() => ({} as T), waitFor: async () => true, refetch: () => {}, navigate: () => {} });
const activity: ActivityEntry[] = [{ id: "a1", at: snap.at - 600, kind: "mode", level: "info", text: "Mode Normal → Relaxed · planner behind pace" }];
const view = (repo: string | null = null, s: ClientSnapshot = snap) =>
  renderToString(<OverviewView snapshot={s} query={{ repo, scope: null }} now={snap.at} runner={runner} activity={activity} ops={new Set(["attention.dismiss", "task.stop"])} quickDelegate={<p>quick delegate form</p>} />);
const order = (html: string, words: string[]) => words.map(w => html.indexOf(w));

test("the canvas layout keeps work and capacity in independent columns", () => {
  const html = view();
  const main = html.indexOf("pc-overview__main"), side = html.indexOf("pc-overview__side");
  expect(html.indexOf("pc-planner-strip")).toBeLessThan(main);
  const at = order(html, [">Needs you<", ">Running<", ">Done today<"]);
  expect(at.every(i => i > main && i < side)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
  const right = order(html, [">Capacity<", ">Quick delegate<", ">Activity<"]);
  expect(right.every(i => i > side)).toBe(true);
  expect([...right].sort((a, b) => a - b)).toEqual(right);
});

test("the planner strip gives the advice, usage and the day's numbers", () => {
  const html = view();
  expect(html).toContain("Planner · Claude");
  expect(html).toContain("14 pts under pace — spend it.");
  expect(html).toContain("63% used · pace 77%");
  expect(html).toMatch(/>4<\/div><div[^>]*>need you</);
  expect(html).toMatch(/>2<\/div><div[^>]*>running</);
  expect(html).toMatch(/>7<\/div><div[^>]*>done today</);
});

test("needs you links to the review queue", () => {
  const html = view();
  expect(html).toContain('href="#/needs-you"');
  expect(html).toContain("All attention");
  expect(html).not.toContain("pc-keys-footer");
});

test("capacity with no usage reading says so with a glyph and the reason", () => {
  const html = view();
  const at = html.indexOf(">Cursor<", html.indexOf('aria-labelledby="capacity"'));
  const row = html.slice(at, at + 700);
  expect(row).toContain("?");
  expect(row).toContain("Usage unknown · no limit reported");
});

test("repo chips show counts, pressed state and the shared-budget note", () => {
  const html = view("github.com/acme/api");
  expect(html).toContain("All repos");
  expect(html).toMatch(/aria-pressed="true"[^>]*><span[^>]*>acme\/api<\/span><span[^>]*aria-label="3 work items"[^>]*>3</);
  expect(html).toMatch(/aria-pressed="false"[^>]*><span[^>]*>All repos/);
  expect(html).toContain("Budgets are shared across repos; the filter only narrows work.");
});

test("a repo scope filters Needs you and Running but never Capacity", () => {
  const html = view("github.com/acme/api");
  expect(html).toContain("Retry budget refresh on 429");
  expect(html).not.toContain("Add dark mode to the web header");
  expect(html).toContain("Add SSH keepalive to remote runs");
  expect(html).not.toContain("Split the settings page into sections");
  expect(html).toContain("LM Studio is not running");
  expect(html).toContain("+1 in other repos");
  expect(html).toContain('href="#/overview?repo="');
});

test("a failed card has the bad tint, the glyph, the service's words and exactly its actions", () => {
  const html = view();
  // The card is the span between its own opening tag and the next card's.
  const cards = [...html.matchAll(/class="[^"]*pc-attn(?: [^"]*)?"/g)].map(m => m.index!);
  const title = html.indexOf("Retry budget refresh on 429"), start = cards.filter(i => i < title).at(-1)!;
  const card = html.slice(start, cards.find(i => i > title) ?? html.length);
  expect(card).toContain("pc-list-row--bad");
  expect(card).toContain("✕");
  expect(card).toContain("Failed twice on Antigravity · test timed out after 120 s");
  expect(card).toContain(">Retry on Codex<");
  expect(card).toContain(">See error<");
  expect(html.match(/>Retry on [A-Z]/g)?.length).toBe(1);
});

test("running rows show phase words, idle warning and queue reason", () => {
  const html = view();
  expect(html).toContain(">Editing<");
  expect(html).toMatch(/pc-warn-text[^>]*>idle 6m</);
  expect(html).toContain("6 files · 2 commits");
  expect(html).toContain("Waiting: this executor is running 1 of 1");
  expect(html).toContain('href="#/sessions/t-0420"');
  expect(html).toContain(">Stop<");
});

test("capacity dims a down executor and gives its reason; header counts ready executors", () => {
  const html = view();
  expect(html).toContain("2/4 executors ready");
  expect(html).toMatch(/pc-cap--off[\s\S]*LM Studio is not running/);
  expect(html).toContain('href="#/settings/executors"');
  expect(html).toContain("Behind pace");
});

test("done today and activity use absolute times and the service's sentences", () => {
  const html = view();
  expect(html).toContain("7 · 6 accepted");
  expect(html).toContain('aria-label="Done today pages"');
  expect(html).toContain("1–3 of 5");
  expect(html).toContain(">Completed<");
  expect(html).toContain("Mode Normal → Relaxed · planner behind pace");
});

test("empty states say what to do next", () => {
  const empty = { ...snap, attention: [], executors: [], counts: { ...snap.counts!, attention: 0 } };
  const html = view(null, empty);
  expect(html).toContain("Nothing needs your attention");
  expect(html).toContain("No executors yet.");
  expect(html).toContain('href="#/settings/add-executor"');
});

// Thirty registrations include stale worktrees, recent completions and more active
// repositories than fit in the compact filter.
function thirtyRepos(): ClientSnapshot {
  const repos = Array.from({ length: 30 }, (_, i) => ({ key: `repo-${i}`, label: `Repo ${i}`, path: `/tmp/repos/${i}` }));
  return { ...snap, repos, attention: [], tasks: repos.map((repo, i) => ({ ...snap.tasks[0]!, id: `task-${i}`, repo, updatedAt: snap.at - i })),
    counts: { ...snap.counts!, byRepo: Object.fromEntries(repos.map((repo, i) => [repo.key, { attention: i < 7 ? (i === 0 ? 4 : 1) : 0, running: i === 1 ? 2 : 0, review: 0 }])) },
    today: { ...snap.today!, byRepo: { 'repo-8': 1 } },
  };
}

test("30 repos render All repos and at most five repo chips, ordered by work count then last use", () => {
  const snapshot = thirtyRepos();
  const html = renderToString(<RepoFilter snapshot={snapshot} query={{ repo: null, scope: null }} />);
  expect(repoChoices(snapshot, null).chips.map(repo => repo.key)).toEqual(['repo-0', 'repo-1', 'repo-2', 'repo-3', 'repo-4']);
  expect(html.match(/aria-pressed=/g)?.length).toBe(6);
  expect(html).toContain('All repos');
  expect(html).toContain('Find repo');
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain('Repo 29');
  expect(html).not.toContain('All repositories');
});

test("an idle active filter stays visible within the five repo limit", () => {
  const snapshot = thirtyRepos();
  const html = renderToString(<RepoFilter snapshot={snapshot} query={{ repo: 'repo-29', scope: null }} />);
  expect(html.match(/aria-pressed=/g)?.length).toBe(6);
  expect(html).toMatch(/aria-pressed="true"[^>]*><span[^>]*>Repo 29/);
  expect(html).not.toContain('>Repo 4 ');
  expect(repoChoices(snapshot, 'repo-29').chips.map(repo => repo.key)).toEqual(['repo-0', 'repo-1', 'repo-2', 'repo-3', 'repo-29']);
});

test("today's repos can fill spare chips, while zero-work repos are only in the searchable list", () => {
  const original = thirtyRepos();
  const snapshot = { ...original, counts: { ...original.counts!, byRepo: {} } };
  expect(repoChoices(snapshot, null).chips.map(repo => repo.key)).toEqual(['repo-8']);
  expect(repoChoices(snapshot, null).all).toHaveLength(30);
  expect(repoChoices(snapshot, null).all.find(repo => repo.key === 'repo-29')?.count).toBe(0);
});

test("attention uses service title, inline repo, reason and time with secondary actions in a shared row", () => {
  const item = { ...snap.attention![1]!, title: "Short service title", detail: "Failed twice on Antigravity · test timed out after 120 s" };
  const html = view(null, { ...snap, attention: [{ ...item, actions: item.actions.map(a => ({ ...a, style: "primary" as const })) }] });
  const card = html.slice(html.indexOf('data-attention-id='), html.indexOf('aria-labelledby="running"'));
  expect(card).toMatch(/Short service title<\/span><code(?=[^>]*class="pc-repo-chip")(?=[^>]*title="acme\/api")[^>]*>acme\/api<\/code>/);
  expect(card).toContain(`${item.detail} · `);
  expect(card).toContain("pc-list-row__actions");
  expect(card).not.toContain("pc-list-row--outlined");
  expect(card).not.toContain("pc-btn--primary");
  expect(card).not.toContain('>Dismiss<');
  expect(card).toContain(`>${item.actions[0]!.label}<`);
  expect(card).toContain(`>${item.actions[1]!.label}<`);
});

test("legacy attention goals reuse the task's service short title", () => {
  const task = snap.tasks.find(t => t.id === snap.attention![1]!.taskId)!;
  const html = view(null, { ...snap, tasks: snap.tasks.map(t => t.id === task.id ? { ...t, title: 'Service short title' } : t), attention: [{ ...snap.attention![1]!, title: task.goal }] });
  expect(html).toMatch(/Service short title<\/span><code[^>]*class="pc-repo-chip"/);
});

test("wide repo filter uses repo Done today totals and counts accepted rows only", () => {
  const html = view('github.com/lamtuanvu/pacer');
  const section = html.slice(html.indexOf('aria-labelledby="done-today"'), html.indexOf('pc-overview__side'));
  expect(section).toContain('2 · 1 accepted');
  expect(section).not.toContain('7 · 6 accepted');
  const empty = view('unknown');
  expect(empty.slice(empty.indexOf('aria-labelledby="done-today"'))).toContain('0 · 0 accepted');
});

test("repo Done today falls back to its filtered rows when no repo total is supplied", () => {
  const html = view('github.com/acme/api', { ...snap, today: { ...snap.today!, byRepo: {} } });
  expect(html.slice(html.indexOf('aria-labelledby="done-today"'))).toContain('2 · 0 accepted');
});

test("overview bounds a long attention queue and exposes its page range", () => {
  const item = snap.attention![0]!;
  const snapshot = { ...snap, attention: Array.from({ length: 13 }, (_, i) => ({ ...item, id: `page-${i}`, title: `Attention ${i}`, taskId: undefined })) };
  const html = view(null, snapshot);
  expect(html.match(/data-attention-id=/g)).toHaveLength(5);
  expect(html).toContain('aria-label="Needs you pages"');
  expect(html).toContain('1–5 of 13');
  expect(html).toContain('Next');
  expect(html).not.toContain('Attention 12');
});
