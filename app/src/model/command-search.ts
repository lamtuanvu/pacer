import type { ClientSnapshot } from "../../../src/view-model/snapshot";
import { ago } from "../../../src/view-model/time";
import { displayTitle } from "../../../src/view-model/titles";
import { executorLabel, taskStatus, type Tone } from "../../../src/view-model/words";
import type { Command } from "../keys/commands";
import type { IconName } from "../ds/icons";
import { routes, type RouteTarget } from "../router";

/** `?` asks the assistant. Hidden until the assistant exists (Slice 10), so typing it searches for a question mark. */
export const ASK_ENABLED = false;

export type MenuScope = "all" | "tasks" | "machines" | "repos" | "commands";
export const SCOPES: { id: MenuScope; label: string }[] = [{ id: "all", label: "All" }, { id: "tasks", label: "Tasks" }, { id: "machines", label: "Machines" }, { id: "repos", label: "Repos" }, { id: "commands", label: "Commands" }];

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
  pill?: { label: string; tone: Tone };
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

/** Tasks, machines and repositories from the snapshot the app already holds (UI-13: no new service calls). */
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
  for (const host of snapshot.hosts ?? []) {
    const state = HOST_STATE[host.state] ?? HOST_STATE.unknown!;
    items.push({
      id: `machine:${host.alias}`, scope: "machines", title: host.alias, icon: "hosts", pill: state,
      sub: host.state === "ready" ? `${Math.max(0, host.maxTasks - host.running)} of ${host.maxTasks} slots free` : host.ssh,
      hidden: `${host.ssh} host machine`, target: routes.host(host.alias),
    });
  }
  for (const repo of snapshot.repos ?? []) {
    items.push({ id: `repo:${repo.key}`, scope: "repos", title: repo.label, icon: "files", sub: "Show its work on Overview", hidden: repo.path, target: routes.overview({ repo: repo.key }) });
  }
  return items;
}

export function commandItems(commands: Command[]): MenuItem[] {
  return commands.filter(command => !command.hidden).map(command => ({ id: `command:${command.id}`, scope: "commands", title: command.title, sub: command.sub, icon: command.icon ?? "dispatch", hidden: `${command.group} ${command.keywords ?? ""}`, command }));
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

const GROUP_TITLES: Record<Exclude<MenuScope, "all">, string> = { tasks: "Tasks", machines: "Machines", repos: "Repos", commands: "Do something" };
const PER_GROUP = 8;
/** Command groups in the order a first-time reader expects; unknown groups follow. */
const COMMAND_GROUPS = ["Go to", "Suggested", "View", "Help"];
const byCommandGroup = (a: MenuGroup, b: MenuGroup) => (COMMAND_GROUPS.indexOf(a.title) + 1 || 99) - (COMMAND_GROUPS.indexOf(b.title) + 1 || 99);
const groupBy = (items: MenuItem[], title: (item: MenuItem) => string, limit = PER_GROUP): MenuGroup[] => {
  const groups = new Map<string, MenuItem[]>();
  for (const item of items) groups.set(title(item), [...(groups.get(title(item)) ?? []), item]);
  return [...groups].map(([name, list]) => ({ title: name, items: list.slice(0, limit) }));
};

export interface MenuResult {
  mode: MenuMode; groups: MenuGroup[]; counts: Record<MenuScope, number>; empty: boolean;
  /** Footer wording for Enter. */
  enterHint: string;
}
export interface MenuInput { query: string; scope: MenuScope; snapshot: ClientSnapshot | null; commands: Command[]; recent: string[]; now: number }

export function buildMenu({ query, scope, snapshot, commands, recent, now }: MenuInput): MenuResult {
  const { mode, text } = parseQuery(query);
  const everything = [...snapshotItems(snapshot, now), ...commandItems(commands)];
  const zero = { all: 0, tasks: 0, machines: 0, repos: 0, commands: 0 };
  if (mode === "ask") return { mode, groups: [], counts: zero, empty: false, enterHint: "ask" };
  if (mode === "commands") {
    const matched = rankAndMark(commandItems(commands), text);
    const groups = groupBy(matched, item => item.command!.group, matched.length);
    return { mode, groups, counts: { ...zero, all: matched.length, commands: matched.length }, empty: !matched.length, enterHint: "run" };
  }
  if (mode === "recent") {
    const byId = new Map(everything.map(item => [item.id, item]));
    const picked = recent.flatMap(id => byId.get(id) ?? []).slice(0, 5);
    const latest = picked.length ? [] : (snapshot?.tasks ?? []).filter(task => !task.archived).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3).flatMap(task => byId.get(`task:${task.id}`) ?? []);
    const groups: MenuGroup[] = [...((picked.length ? picked : latest).length ? [{ title: "Recent", items: picked.length ? picked : latest }] : []), ...groupBy(commandItems(commands), item => item.command!.group).sort(byCommandGroup)];
    return { mode, groups, counts: zero, empty: false, enterHint: "open" };
  }
  const matched = rankAndMark(everything, text);
  const counts = { ...zero, all: matched.length };
  for (const item of matched) counts[item.scope]++;
  const shown = scope === "all" ? matched : matched.filter(item => item.scope === scope);
  const groups = groupBy(shown, item => GROUP_TITLES[item.scope]);
  const order = Object.values(GROUP_TITLES);
  groups.sort((a, b) => order.indexOf(a.title) - order.indexOf(b.title));
  if (shown.length) return { mode, groups, counts, empty: false, enterHint: "open" };
  const start = commands.find(command => command.id === "task.new");
  const instead: MenuItem[] = [
    ...(start ? [{ ...commandItems([start])[0]!, title: "New task", sub: `Describe “${text}” and pacer routes it` }] : []),
    { id: "action:tasks", scope: "tasks" as const, title: "Browse all tasks", icon: "tasks" as const, target: routes.tasks() },
  ];
  return { mode, groups: [{ title: "Instead", items: instead }], counts, empty: true, enterHint: "open" };
}
