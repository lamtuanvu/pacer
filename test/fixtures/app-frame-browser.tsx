import { Sessions } from "../../app/src/screens/session/controller";
import { resetDesktopPageScroll } from "../../app/src/shell/page-scroll";
import { render } from "preact";
import { useLayoutEffect, useEffect, useState } from "preact/hooks";
import fixture from "./ui/snapshot.json";
import { Layout } from "../../app/src/shell/Layout";
import { TaskContext } from "../../app/src/screens/task-shared";
import { NavigationProvider } from "../../app/src/navigation";
import { initialState } from "../../app/src/data/store";
import { resolveRoute, type Route } from "../../app/src/router";
import { attachKeyRegistry } from "../../app/src/keys/registry";
import { commands, keys } from "../../app/src/keys/instance";
import { Field, TextInput } from "../../app/src/ds/Controls";
import { Page, PageBody, Section } from "../../app/src/ds/Page";
import { Button } from "../../app/src/ds/Button";
import { NotificationProvider } from "../../app/src/data/notification-context";

// Browser fixture for the window frame: the real Layout around a settings-like page, with a stub service.
const terminals: any[] = [];
// The test origin is plain http, where randomUUID is unavailable.
if (!crypto.randomUUID) Object.defineProperty(crypto, "randomUUID", { value: () => `11111111-1111-4111-8111-${String(Date.now()).slice(-12).padStart(12, "0")}` });
const api = { async call(op: string, params?: unknown) {
  if (op === "task.list" || op === "dispatch.list") return { tasks: [], next: null };
  if (op === "task.get") return {};
  if (op === "terminal.list") return [...terminals];
  if (op === "terminal.create") { const id = `00000000-0000-4000-8000-${String(terminals.length + 1).padStart(12, "0")}`; terminals.push({ id, kind: "shell", title: "Shell", cwd: "/workspace", createdAt: 1, rev: 1, live: true, exit: null, cols: 80, rows: 24, attach: { ws: `/v3/terminals/${id}/session` } }); return terminals.at(-1); }
  if (op === "account.list") return [];
  if (op === "files.search") { ((window as any).fileCalls ??= []).push(params); if ((window as any).failFiles) throw new Error("no"); return { query: (params as any).query, results: [], truncated: false, repos: [], ...(window as any).filesAnswer }; }
  if (op === "delegation.pause") { ((window as any).dispatchCalls ??= []).push(["pause", params]); if ((window as any).failPause) throw new Error("service said no"); return {}; }
  return {};
}, hello: async () => ({}), snapshot: async () => ({}) };
const state = { ...initialState(), connected: true, snapshot: fixture as any, features: { readModel: true, ops: new Set(["terminal.create", "delegation.pause", "files.search"]) } };
if (new URLSearchParams(location.search).has("task-list")) {
  state.snapshot = { ...fixture, tasks: Array.from({ length: 20 }, (_, index) => ({ ...fixture.tasks[0], id: `scroll-task-${index}`, goal: `Scroll restoration task ${index}` })) } as any;
}
function App() {
  const [connected, setConnected] = useState(true);
  useEffect(() => { const update = (event: Event) => setConnected((event as CustomEvent<boolean>).detail); window.addEventListener("fixture-connection", update); return () => window.removeEventListener("fixture-connection", update); }, []);
  const current = { ...state, connected };
  const [hash, setHash] = useState(location.hash || "#/settings");
  useEffect(() => { const update = () => setHash(location.hash); addEventListener("hashchange", update); keys.setScope((resolveRoute(hash) as Route).name); return () => removeEventListener("hashchange", update); }, [hash]);
  useLayoutEffect(() => { resetDesktopPageScroll(); }, [hash]);
  const resolved = resolveRoute(hash);
  useEffect(() => { if ("redirect" in resolved) location.replace(resolved.redirect); }, [hash]);
  const route = ("redirect" in resolved ? resolveRoute(resolved.redirect) : resolved) as Route;
  const taskList = new URLSearchParams(location.search).has("task-list");
  return <TaskContext.Provider value={{ api: api as any, state: current }}><NavigationProvider route={route}>
    <Layout route={route} state={current} title="Settings">
      {taskList && route.name === "sessions" && !route.id ? <Sessions query={route.query} /> : <Page width="full"><PageBody><Section title="General" description="Settings that apply to every task.">
        <Field label="Planner"><TextInput value="A long planner value that should never push the page sideways at any width" /></Field>
        <Button>Save settings</Button>
      </Section></PageBody></Page>}
    </Layout>
  </NavigationProvider></TaskContext.Provider>;
}
// The commands main.tsx registers for the real app, so the command menu has something to run.
commands.register({ id: "go.tasks", title: "Go to Tasks", group: "Go to", icon: "tasks", keys: "g t", run: () => { location.hash = "#/tasks"; } });
commands.register({ id: "help.shortcuts", title: "Show keyboard shortcuts", group: "Help", icon: "notes", opensDialog: true, run: () => { (window as any).helped = ((window as any).helped ?? 0) + 1; } });
commands.register({ id: "view.count", title: "Count one", group: "View", icon: "plus", run: () => { (window as any).counted = ((window as any).counted ?? 0) + 1; } });
commands.register({ id: "task.new", title: "New task", sub: "Describe it and pacer routes it", group: "Suggested", icon: "plus", keywords: "delegate start", opensDialog: true, keys: "d", shortcutLabel: "Delegate a task", run: () => { (window as any).newTask = ((window as any).newTask ?? 0) + 1; } });
attachKeyRegistry(keys, window);
render(<NotificationProvider><App /></NotificationProvider>, document.getElementById("app")!);
