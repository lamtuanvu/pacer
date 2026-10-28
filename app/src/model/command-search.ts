import type { ClientSnapshot } from "../../../src/view-model/snapshot";
import { agentInfo } from "../../../src/view-model/agents";
import { ago, elapsed } from "../../../src/view-model/time";
import { displayTitle } from "../../../src/view-model/titles";
import { executorLabel, executorRowStatus, taskStatus, type Tone } from "../../../src/view-model/words";
import type { Command } from "../keys/commands";
import type { IconName } from "../ds/icons";
import { routes, type RouteTarget } from "../router";

/** `?` asks the assistant. Hidden until the assistant exists (Slice 10), so typing it searches for a question mark. */
export const ASK_ENABLED = false;

/** Machines belong to Agents: both are the things that run work. Files wait for snapshot data that names files (UI-13). */
export type MenuScope = "all" | "tasks" | "agents" | "commands";
export const SCOPES: { id: MenuScope; label: string }[] = [{ id: "all", label: "All" }, { id: "tasks", label: "Tasks" }, { id: "agents", label: "Agents" }, { id: "commands", label: "Commands" }];

export type MenuMode = "recent" | "search" | "commands" | "ask";
export interface ParsedQuery { mode: MenuMode; text: string }
/** A leading `>` switches to commands and a leading `?` to ask. The prefix is not part of the search text. */
export function parseQuery(raw: string, askEnabled = ASK_ENABLED): ParsedQuery {
  if (raw.startsWith(">")) return { mode: "commands", text: raw.slice(1).trim() };
  if (askEnabled && raw.startsWith("?")) return { mode: "ask", text: raw.slice(1).trim() };
  const text = raw.trim();
  return { mode: text ? "search" : "recent", text };
}

export interface MenuItem {
  id: string; scope: Exclude<MenuScope, "all">; title: string; sub?: string; icon: IconName;
  /** Shows this agent's mark instead of the icon. */
  agent?: string;
  pill?: { label: string; tone: Tone };
  /** Group heading when it differs from the scope's own, such as Machines or Suggested. */
  group?: string;
  /** Extra words matched but not shown. */
  hidden?: string;
  target?: RouteTarget; command?: Command;
  /** The title with matched text marked, as [start, end) offsets. */
  ranges?: [number, number][];
}
export interface MenuGroup { title: string; items: MenuItem[] }

const HOST_STATE: Record<string, { label: string; tone: Tone }> = {
  ready: { label: "Online", tone: "good" }, down: { label: "Offline", tone: "bad" }, paused: { label: "Paused", tone: "neutral" },
  checking: { label: "Checking", tone: "info" }, needs_setup: { label: "Needs setup", tone: "warn" }, unknown: { label: "Not checked", tone: "neutral" },
};

/** Tasks, agents and machines from the snapshot the app already holds (UI-13: no new service calls). */
export function snapshotItems(snapshot: ClientSnapshot | null, now: number): MenuItem[] {
  if (!snapshot) return [];
  const items: MenuItem[] = [];
  for (const task of snapshot.tasks) {
    if (task.archived) continue;
    const status = taskStatus(task);
    const executor = task.executor ? executorLabel(task.executor, snapshot.accounts) : null;
    items.push({
      id: `task:${task.id}`, scope: "tasks", title: displayTitle(task), icon: "tasks", pill: { label: status.label, tone: status.tone },
      sub: [task.repo?.label, executor, ago(task.updatedAt, now)].filter(Boolean).join(" · "), hidden: `${task.goal} ${task.id}`,
      target: routes.task(task.id),
    });
  }
  for (const row of snapshot.executors ?? []) {
    const status = executorRowStatus(row);
    items.push({
      id: `agent:${row.id}`, scope: "agents", group: "Agents", title: executorLabel(row.id, snapshot.accounts), icon: "executors", agent: row.agent,
      pill: { label: status.label, tone: status.tone }, sub: row.sub, hidden: `${agentInfo(row.agent).name} ${row.account} ${row.model ?? ""} agent executor`,
      target: routes.settings("executors"),
    });
  }
  for (const host of snapshot.hosts ?? []) {
    const state = HOST_STATE[host.state] ?? HOST_STATE.unknown!;
    items.push({
      id: `machine:${host.alias}`, scope: "agents", group: "Machines", title: host.alias, icon: "hosts", pill: state,
      sub: host.state === "ready" ? `${Math.max(0, host.maxTasks - host.running)} of ${host.maxTasks} slots free` : host.ssh,
      hidden: `${host.ssh} host machine`, target: routes.host(host.alias),
    });
  }
  return items;
}

export function commandItems(commands: Command[]): MenuItem[] {
  return commands.filter(command => !command.hidden).map(command => ({ id: `command:${command.id}`, scope: "commands", title: command.title, sub: command.sub, icon: command.icon ?? "dispatch", hidden: `${command.group} ${command.keywords ?? ""}`, command }));
}

/** The oldest question or review waiting on the user, offered as a suggestion on the recent screen. */
function waitingSuggestion(snapshot: ClientSnapshot | null, now: number): MenuItem | null {
  const item = [...(snapshot?.attention ?? [])].filter(entry => entry.kind === "question" || entry.kind === "review").sort((a, b) => a.raisedAt - b.raisedAt)[0];
  if (!item || !snapshot) return null;
  const row = snapshot.executors?.find(executor => executor.id === item.executor);
  const who = row ? agentInfo(row.agent).name : "the agent";
  return {
    id: `attention:${item.id}`, scope: "tasks", group: "Suggested", title: `${item.kind === "question" ? "Answer" : "Review"} ${who} on “${item.title}”`, icon: "tasks", agent: row?.agent,
    sub: `It has been waiting ${elapsed(now - item.since)}`, target: item.taskId ? routes.task(item.taskId) : routes.needsYou(),
  };
}

/** Every word of the query must appear in the title, subtitle or hidden words. Returns title highlights and a rank (lower is better). */
export function matchItem(item: MenuItem, text: string): { rank: number; ranges: [number, number][] } | null {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { rank: 0, ranges: [] };
  const title = item.title.toLowerCase(), rest = `${item.sub ?? ""} ${item.hidden ?? ""}`.toLowerCase();
  const ranges: [number, number][] = [];
  let rank = 0;
  for (const word of words) {
    const at = title.indexOf(word);
    if (at >= 0) {
      ranges.push([at, at + word.length]);
      rank += at === 0 ? 0 : /\W/.test(title[at - 1]!) ? 1 : 2;
    } else if (rest.includes(word)) rank += 4;
    else return null;
  }
  return { rank, ranges: mergeRanges(ranges) };
}
function mergeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]), merged: [number, number][] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]); else merged.push([...range]);
  }
  return merged;
}
const rankAndMark = (items: MenuItem[], text: string): MenuItem[] => items
  .flatMap((item, order) => { const hit = matchItem(item, text); return hit ? [{ item: { ...item, ranges: hit.ranges }, rank: hit.rank, order }] : []; })
  .sort((a, b) => a.rank - b.rank || a.order - b.order).map(entry => entry.item);

const GROUP_TITLES: Record<Exclude<MenuScope, "all">, string> = { tasks: "Tasks", agents: "Agents", commands: "Do something" };
const SEARCH_GROUP_ORDER = ["Tasks", "Agents", "Machines", "Do something"];
const PER_GROUP = 8;
/** Command groups in the order the board shows them; unknown groups follow. */
const COMMAND_GROUPS = ["Dispatcher", "Go to", "Suggested", "View", "Help"];
/** The recent screen shows only these; the rest are reachable with `>`. */
const RECENT_COMMAND_GROUPS = ["Go to", "Suggested"];
const orderOf = (list: string[]) => (a: MenuGroup, b: MenuGroup) => (list.indexOf(a.title) + 1 || 99) - (list.indexOf(b.title) + 1 || 99);
const groupBy = (items: MenuItem[], title: (item: MenuItem) => string, limit = PER_GROUP): MenuGroup[] => {
  const groups = new Map<string, MenuItem[]>();
  for (const item of items) groups.set(title(item), [...(groups.get(title(item)) ?? []), item]);
  return [...groups].map(([name, list]) => ({ title: name, items: list.slice(0, limit) }));
};

export interface MenuResult {
  mode: MenuMode; groups: MenuGroup[]; counts: Record<MenuScope, number>; empty: boolean;
  /** The scope actually shown: the chosen one, or All when the chosen one has no matches. */
  scope: MenuScope;
  /** Footer wording for Enter. */
  enterHint: string;
  /** Footer wording for ⌘↵, present only where it does something. */
  modEnterHint?: string;
}
export interface MenuInput { query: string; scope: MenuScope; snapshot: ClientSnapshot | null; commands: Command[]; recent: string[]; now: number }

export function buildMenu({ query, scope, snapshot, commands, recent, now }: MenuInput): MenuResult {
  const { mode, text } = parseQuery(query);
  const everything = [...snapshotItems(snapshot, now), ...commandItems(commands)];
  const zero = { all: 0, tasks: 0, agents: 0, commands: 0 };
  if (mode === "ask") return { mode, groups: [], counts: zero, empty: false, scope: "all", enterHint: "ask" };
  if (mode === "commands") {
    const matched = rankAndMark(commandItems(commands), text);
    const groups = groupBy(matched, item => item.command!.group, matched.length).sort(orderOf(COMMAND_GROUPS));
    return { mode, groups, counts: { ...zero, all: matched.length, commands: matched.length }, empty: !matched.length, scope: "all", enterHint: "run", modEnterHint: "run and keep open" };
  }
  if (mode === "recent") {
    const byId = new Map(everything.map(item => [item.id, item]));
    const picked = recent.flatMap(id => byId.get(id) ?? []).slice(0, 5);
    const latest = picked.length ? [] : (snapshot?.tasks ?? []).filter(task => !task.archived).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3).flatMap(task => byId.get(`task:${task.id}`) ?? []);
    const recentItems = picked.length ? picked : latest, listed = new Set(recentItems.map(item => item.id));
    const suggestion = waitingSuggestion(snapshot, now);
    const offered = [...commandItems(commands).filter(item => !listed.has(item.id)), ...(suggestion && !listed.has(suggestion.id) ? [suggestion] : [])]
      .filter(item => RECENT_COMMAND_GROUPS.includes(item.group ?? item.command!.group));
    const groups: MenuGroup[] = [...(recentItems.length ? [{ title: "Recent", items: recentItems }] : []), ...groupBy(offered, item => item.group ?? item.command!.group).sort(orderOf(RECENT_COMMAND_GROUPS))];
    return { mode, groups, counts: zero, empty: false, scope: "all", enterHint: "open" };
  }
  const matched = rankAndMark(everything, text);
  const counts = { ...zero, all: matched.length };
  for (const item of matched) counts[item.scope]++;
  // A scope with nothing in it falls back to All, so the tab never hides matches that exist elsewhere.
  const only = scope !== "all" && counts[scope] > 0 ? scope : "all";
  const shown = only === "all" ? matched : matched.filter(item => item.scope === only);
  // Each group is capped while browsing All; a single scope lists everything it matched.
  const groups = groupBy(shown, item => item.group ?? GROUP_TITLES[item.scope], only === "all" ? PER_GROUP : shown.length).sort(orderOf(SEARCH_GROUP_ORDER));
  if (shown.length) return { mode, groups, counts, empty: false, scope: only, enterHint: "open" };
  const start = commands.find(command => command.id === "task.new");
  const instead: MenuItem[] = [
    ...(start ? [{ ...commandItems([start])[0]!, title: "New task", sub: `Describe “${text}” and pacer routes it` }] : []),
    { id: "action:tasks", scope: "tasks" as const, title: "Browse all tasks", icon: "tasks" as const, target: routes.tasks() },
  ];
  return { mode, groups: [{ title: "Instead", items: instead }], counts, empty: true, scope: "all", enterHint: "open" };
}
