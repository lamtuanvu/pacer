import { PluginContext, usePluginCatalog } from "./plugins/catalog";
import { discoveryNoticeHiddenOn, updateNoticeHiddenOn } from "./settings-pages";
import { startPolling } from "./data/poll";
import { startClientControl } from "./data/control";
import { canLeaveScreen } from "./data/navigation-guard";
import { NotificationProvider } from "./data/notification-context";
import { SetupContext } from "./screens/setup/context";
import { render } from "preact";
import { useLayoutEffect, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { createApi } from "./data/api";
import type { SetupChecklist } from "../../src/setup/checklist";
import { TaskContext } from "./screens/task-shared";
import { createStore } from "./data/store";
import { inheritQuery, resolveRoute, setupCompleteFrom, titleFor, type Route } from "./router";
import { attachKeyRegistry, newTaskShortcut } from "./keys/registry";
import { openNewTask } from "./screens/new-task/entry";
import { commands, keys } from "./keys/instance";
import { ActionContext } from "./data/action-context";
import { createActionRunner, storeWaiter } from "./data/actions";
import { useNarrow } from "./shell/narrow";
import { Layout } from "./shell/Layout";
import { CommandHelp } from "./shell/CommandHelp";
import { Screen } from "./screens/Screen";
import { followSavedTheme } from "./theme";
import { NavigationProvider } from "./navigation";
import { readNativeTitlebarSupport, readRoundedWindowSupport } from "./data/desktop";
import { resetDesktopPageScroll } from "./shell/page-scroll";
import { NoticeStack } from "./ds/NoticeCard";
void readRoundedWindowSupport().then(supported => {
  if (supported) document.documentElement.dataset.pacerDesktop = "";
});
void readNativeTitlebarSupport().then(supported => {
  if (supported) document.documentElement.dataset.pacerNativeTitlebar = "";
});
followSavedTheme();
const store = createStore();
const SETTINGS = new Set(["settings", "hosts", "add-executor"]);
function App() {
  const [state, setState] = useState(store.getState);
  const [sessionEnded, setSessionEnded] = useState(false);
  const api = useMemo(() => createApi(() => setSessionEnded(true)), []);
  const plugins = usePluginCatalog(api, state.connected, (state.invalidations.plugin ?? 0) + (state.invalidations.plugins ?? 0));
  const actions = useMemo(() => createActionRunner({ call: api.call, waitFor: storeWaiter(store), refetch: () => store.refresh(), reviewAccepted: id => store.acceptReview(id), navigate: hash => { location.hash = inheritQuery(hash, location.hash); } }), [api]);
  const [hash, setHash] = useState(location.hash);
  useLayoutEffect(() => { resetDesktopPageScroll(); }, [hash]);
  const [help, setHelp] = useState(false);
  const [UpdateNotice, setUpdateNotice] = useState<typeof import("./shell/UpdateNotice").UpdateNotice>();
  const [DiscoveryNotice, setDiscoveryNotice] = useState<typeof import("./shell/DiscoveryNotice").DiscoveryNotice>();
  const lastWork = useRef("#/");
  useEffect(() => {
    const unsubscribe = store.subscribe(() => setState(store.getState()));
    const stop = store.start();
    let accepted = location.hash, navigating = false;
    const navigate = async () => {
      const target = location.hash;
      if (target === accepted) return;
      history.replaceState(null, '', accepted);
      if (navigating) return;
      navigating = true;
      try { if (await canLeaveScreen()) { accepted=target; history.replaceState(null,'',target); setHash(target); } }
      finally { navigating=false; }
    };
    const stopControl = startClientControl(api, 'main', async route => {
      if (!await canLeaveScreen()) return false;
      accepted = `#${route}`;
      history.replaceState(null, '', accepted);
      setHash(accepted);
      return true;
    });
    window.addEventListener("hashchange", navigate);
    return () => { stopControl(); unsubscribe(); stop(); window.removeEventListener("hashchange", navigate); };
  }, []);
  useEffect(() => { void import("./shell/UpdateNotice").then(module => setUpdateNotice(() => module.UpdateNotice)); }, []);
  useEffect(() => { void import("./shell/DiscoveryNotice").then(module => setDiscoveryNotice(() => module.DiscoveryNotice)); }, []);
  const [setupRevision, reloadSetup] = useState(0);
  const [runningSetup, setRunningSetup] = useState<{ id: string; executor: string }>();
  const [checklist, setChecklist] = useState<SetupChecklist | "error">();
  useEffect(() => {
    let active = true;
    const refresh = () => api.call<SetupChecklist>("setup.check", {}).then(result => { if (active) setChecklist(result); }, () => { if (active) setChecklist(c => c ?? "error"); });
    const stop = startPolling(refresh, 30_000);
    return () => { active = false; stop(); };
  }, [api, state.invalidations.setup, state.connected, setupRevision]);
  // Unknown until the first setup check answers, so screens wait instead of flashing Setup.
  const setupComplete = state.features.ops.size ? setupCompleteFrom(checklist) : null;
  const resolved = resolveRoute(hash, setupComplete, state.features.ops.has("session.create"));
  useEffect(() => { if ("redirect" in resolved) location.replace(resolved.redirect); }, [hash, "redirect" in resolved]);
  const route: Route = "redirect" in resolved ? { name: "loading", query: { repo: null, scope: null } } : resolved;
  const pendingRoute = resolveRoute(hash, true);
  const narrow = useNarrow(route.query);
  if (!SETTINGS.has(route.name) && route.name !== "loading" && route.name !== "setup") lastWork.current = hash || "#/";
  useEffect(() => {
    keys.setScope(route.name);
    const go = (to: string) => () => { location.hash = inheritQuery(to, location.hash); };
    const offs = [
      commands.register({ id: "go.dispatch", title: "Go to Dispatch", group: "Go to", icon: "command-nav", keys: "g o", run: go("#/") }),
      commands.register({ id: "go.needs-you", title: "Go to Needs you", group: "Go to", icon: "command-nav", keys: "g r", run: go("#/needs-you") }),
      commands.register({ id: "go.tasks", title: "Go to Tasks", group: "Go to", icon: "command-nav", keys: "g t", run: go("#/tasks") }),
      commands.register({ id: "go.terminal", title: "Go to Terminal", group: "Go to", icon: "command-terminal", keys: "g e", run: go("#/terminal") }),
      commands.register({ id: "go.settings", title: "Open Settings", group: "Go to", icon: "settings", keys: ",", run: go("#/settings") }),
      commands.register({ id: "help.shortcuts", title: "Show keyboard shortcuts", group: "Help", icon: "notes", opensDialog: true, keys: "?", run: () => setHelp(true) }),
      commands.register({ id: "task.new", title: "New task", sub: "Describe it and pacer routes it", group: "Suggested", icon: "plus", keywords: "delegate start", opensDialog: true, keys: "Mod-n", shortcutLabel: "New task", run: () => openNewTask() }),
      keys.register(newTaskShortcut(() => openNewTask())),
      // Screens with a "New task" button ask the shell to open the New task composer.
      (() => { const open = () => openNewTask(); window.addEventListener("pacer:delegate", open); return () => window.removeEventListener("pacer:delegate", open); })(),
      // Escape closes the settings panel only on settings screens; elsewhere it stays with the page.
      ...[...SETTINGS].map(scope => keys.register({ keys: "Escape", label: "Close the settings panel", scope, run: () => { location.hash = lastWork.current; } })),
    ];
    const detach = attachKeyRegistry(keys, window);
    return () => { offs.forEach(off => off()); detach(); };
  }, []);
  useEffect(() => { keys.setScope(route.name); }, [route.name]);
  useEffect(() => {
    const follow = (event: MouseEvent) => {
      const link = (event.target as Element)?.closest<HTMLAnchorElement>("a[href^='#/']");
      if (link) link.href = inheritQuery(link.getAttribute("href")!, location.hash);
    };
    document.addEventListener("click", follow, true);
    return () => document.removeEventListener("click", follow, true);
  }, []);
  return <TaskContext.Provider value={{ state, api }}><ActionContext.Provider value={actions}>
    <SetupContext.Provider value={{
      checklist: checklist === "error" ? undefined : checklist,
      refresh: () => reloadSetup(v => v + 1), running: runningSetup,
      setRunning: (id, executor) => setRunningSetup({ id, executor }),
    }}>
      <PluginContext.Provider value={plugins}><NavigationProvider route={route} pluginTitle={route.name === "plugin" ? plugins.surfaces.find(s => s.plugin === route.plugin && s.id === route.id && s.surface === "activity")?.title : undefined}><Layout route={route} loadingRoute={"redirect" in pendingRoute ? route : pendingRoute} state={{ ...state, sessionEnded: state.sessionEnded || sessionEnded }} title={route.name === "plugin" ? plugins.surfaces.find(s => s.plugin === route.plugin && s.id === route.id && s.surface === "activity")?.title ?? "Plugin view" : titleFor(route)} onDelegate={() => openNewTask()}><Screen route={route} /></Layout></NavigationProvider></PluginContext.Provider>
    </SetupContext.Provider>
    {/* One shared bottom-right stack. Discovery prompts come and go and change height as they cycle, so they sit on top;
        the update notice stays in the corner and its Restart and Later never move. */}
    <NoticeStack narrow={narrow}>
      {DiscoveryNotice && <DiscoveryNotice hidden={help || sessionEnded || discoveryNoticeHiddenOn(route)} />}
      {UpdateNotice && <UpdateNotice hidden={help || sessionEnded || updateNoticeHiddenOn(route)} />}
    </NoticeStack>
    {help && <CommandHelp registry={keys} close={() => setHelp(false)} />}
  </ActionContext.Provider></TaskContext.Provider>;
}
render(<NotificationProvider><App /></NotificationProvider>, document.getElementById("app")!);
