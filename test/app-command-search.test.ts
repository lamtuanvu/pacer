import { expect, test } from "bun:test";
import fixture from "./fixtures/ui/snapshot.json";
import { buildMenu, matchItem, parseQuery, snapshotItems, type MenuItem } from "../app/src/model/command-search";
import type { Command } from "../app/src/keys/commands";

const snapshot = fixture as any;
const NOW = 1800000000;
const command = (id: string, title: string, group = "Go to", extra: Partial<Command> = {}): Command => ({ id, title, group, run: () => {}, ...extra });
const commands = [command("go.tasks", "Go to Tasks", "Go to", { keys: "g s" }), command("view.panel.left", "Toggle side panel", "View", { keywords: "sidebar" }), command("task.new", "New task", "Suggested")];
const menu = (query: string, scope: any = "all", recent: string[] = []) => buildMenu({ query, scope, snapshot, commands, recent, now: NOW });
const titles = (result: ReturnType<typeof menu>) => result.groups.flatMap(group => group.items.map(item => item.title));

test("a leading > or ? picks the mode, and ? only asks once the assistant exists", () => {
  expect(parseQuery("")).toEqual({ mode: "recent", text: "" });
  expect(parseQuery("  keep ")).toEqual({ mode: "search", text: "keep" });
  expect(parseQuery(">  panel")).toEqual({ mode: "commands", text: "panel" });
  expect(parseQuery("?why", true)).toEqual({ mode: "ask", text: "why" });
  expect(parseQuery("?why")).toEqual({ mode: "search", text: "?why" });
  expect(menu("?why").mode).toBe("search");
});

test("matching needs every word, prefers title starts and reports title highlights", () => {
  const item: MenuItem = { id: "x", scope: "tasks", title: "Add SSH keepalive", sub: "acme/api", hidden: "t-0420", icon: "tasks" };
  expect(matchItem(item, "ssh keep")?.ranges).toEqual([[4, 7], [8, 12]]);
  expect(matchItem(item, "add")?.rank).toBe(0);
  expect(matchItem(item, "keepalive")!.rank).toBeGreaterThan(0);
  expect(matchItem(item, "acme")?.ranges).toEqual([]);
  expect(matchItem(item, "ssh nope")).toBeNull();
  expect(matchItem(item, "SSH")?.ranges).toEqual([[4, 7]]);
});

test("search covers tasks, machines, repos and commands from the snapshot only", () => {
  const items = snapshotItems(snapshot, NOW);
  expect(items.filter(item => item.scope === "tasks").length).toBe(snapshot.tasks.length);
  const machines = menu("box", "machines");
  expect(titles(machines)).toEqual(["devbox", "buildbox"]);
  expect(machines.groups[0]!.items[0]).toMatchObject({ pill: { label: "Online", tone: "good" }, sub: "2 of 3 slots free" });
  expect(machines.groups[0]!.items[1]).toMatchObject({ pill: { label: "Offline", tone: "bad" } });
  expect(menu("buildbox").groups.map(group => group.title)).toEqual(["Machines"]);
  expect(titles(menu("keepalive"))).toEqual(["Add SSH keepalive to remote runs"]);
  expect(titles(menu("acme/web", "repos"))).toEqual(["acme/web"]);
  expect(titles(menu("sidebar"))).toEqual(["Toggle side panel"]);
});

test("scope tabs filter results and counts stay for every scope", () => {
  const all = menu("a");
  const tasksOnly = menu("a", "tasks");
  expect(all.counts.all).toBe(all.counts.tasks + all.counts.machines + all.counts.repos + all.counts.commands);
  expect(tasksOnly.groups.map(group => group.title)).toEqual(["Tasks"]);
  expect(tasksOnly.counts).toEqual(all.counts);
});

test("> lists only commands, grouped, and ignores tasks", () => {
  const result = menu(">new");
  expect(result.mode).toBe("commands");
  expect(titles(result)).toEqual(["New task"]);
  const everything = menu(">");
  expect(everything.groups.map(group => group.title)).toEqual(["Go to", "View", "Suggested"]);
  expect(everything.enterHint).toBe("run");
});

test("recent shows picked items that still exist, else the latest tasks, then ordered command groups", () => {
  const fresh = menu("");
  expect(fresh.mode).toBe("recent");
  expect(fresh.groups.map(group => group.title)).toEqual(["Recent", "Go to", "Suggested", "View"]);
  expect(fresh.groups[0]!.items.length).toBe(3);
  const picked = menu("", "all", ["machine:devbox", "task:gone", "task:t-0420"]);
  expect(picked.groups[0]!.items.map(item => item.id)).toEqual(["machine:devbox", "task:t-0420"]);
});

test("no results offers New task and a way to browse, and says so", () => {
  const result = menu("xyzzy plugin");
  expect(result.empty).toBe(true);
  expect(result.groups.map(group => group.title)).toEqual(["Instead"]);
  expect(result.groups[0]!.items.map(item => item.title)).toEqual(["New task", "Browse all tasks"]);
  expect(result.groups[0]!.items[0]!.sub).toContain("xyzzy plugin");
  // Without a New task command there is nothing to offer for it.
  const bare = buildMenu({ query: "xyzzy", scope: "all", snapshot, commands: [], recent: [], now: NOW });
  expect(bare.groups[0]!.items.map(item => item.title)).toEqual(["Browse all tasks"]);
});

test("no snapshot yet still lists commands", () => {
  const result = buildMenu({ query: "tasks", scope: "all", snapshot: null, commands, recent: [], now: NOW });
  expect(titles(result)).toEqual(["Go to Tasks"]);
});

test("a single scope lists every match while All caps each group", () => {
  const many = { ...snapshot, tasks: Array.from({ length: 20 }, (_, i) => ({ ...snapshot.tasks[0], id: `t-${i}`, goal: `Fix thing ${i}`, title: `Fix thing ${i}` })) };
  const run = (scope: any) => buildMenu({ query: "fix", scope, snapshot: many, commands, recent: [], now: NOW });
  expect(run("all").groups[0]!.items.length).toBe(8);
  expect(run("all").counts.tasks).toBe(20);
  expect(run("tasks").groups[0]!.items.length).toBe(20);
});

test("a scope without matches falls back to All", () => {
  const result = menu("keepalive", "machines");
  expect(titles(result)).toEqual(["Add SSH keepalive to remote runs"]);
  expect(result.empty).toBe(false);
});

test("recent does not list a picked command a second time", () => {
  const result = menu("", "all", ["command:task.new"]);
  const all = titles(result);
  expect(all.filter(title => title === "New task").length).toBe(1);
  expect(result.groups.map(group => group.title)).not.toContain("Suggested");
});
