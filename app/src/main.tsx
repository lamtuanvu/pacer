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
import { inheritQuery, resolveRouteBeforeRender, setupCompleteFrom, titleFor } from "./router";
import { attachKeyRegistry, isApplePlatform } from "./keys/registry";
import { openNewTask } from "./screens/new-task/entry";
import { commands, keys } from "./keys/instance";
import { registerShellCommands } from "./shell/shell-commands";
import { attachContextMenuPolicy } from "./shell/context-menu";
import { ActionContext } from "./data/action-context";
import { createActionRunner, storeWaiter } from "./data/actions";
import { useNarrow } from "./shell/narrow";
import { Layout } from "./shell/Layout";
import { CommandHelp } from "./shell/CommandHelp";
import { Screen, routeWorkspaceKey } from "./screens/Screen";
import { followSavedTheme } from "./theme";
import { NavigationProvider } from "./navigation";
import { isDesktop, readNativeTitlebarSupport, readRoundedWindowSupport } from "./data/desktop";
import { WorkspaceIdentity, WorkspaceScope } from "./workspace/state";
import { resolveWorkspaceIdentity } from "./workspace/identity";
import { reconcileIdentity, workspaceManager } from "./workspace/manager";
import { NoticeStack } from "./ds/NoticeCard";
void readRoundedWindowSupport().then(supported => {
  if (supported) document.documentElement.dataset.pacerDesktop = "";
});
void readNativeTitlebarSupport().then(supported => {
  if (supported) document.documentElement.dataset.pacerNativeTitlebar = "";
});
followSavedTheme();
const SETTINGS = new Set(["settings", "hosts", "add-executor"]);
function App() {
  const [sessionEnded, setSessionEnded] = useState(false);
  const api = useMemo(() => createApi(() => setSessionEnded(true)), []);
  const store = useMemo(() => createStore(api), [api]);
  const [state, setState] = useState(store.getState);
  const plugins = usePluginCatalog(api, state.connected, (state.invalidations.plugin ?? 0) + (state.invalidations.plugins ?? 0));
  const actions = useMemo(() => createActionRunner({ connected: () => store.getState().connected && !store.getState().sessionEnded, call: api.call, waitFor: storeWaiter(store), refetch: () => store.refresh(), reviewAccepted: id => store.acceptReview(id), navigate: hash => { location.hash = inheritQuery(hash, location.hash); } }), [api]);
  const [hash, setHash] = useState(location.hash);
  const [serviceIdentity, setServiceIdentity] = useState<{identity: string; resolved: boolean}>({identity: location.origin, resolved: false});
  const identity = serviceIdentity.identity;
  useEffect(() => {
    if (!state.connected || state.sessionEnded || sessionEnded) return;
    let current = true;
    void resolveWorkspaceIdentity(location.origin, state.features.ops, api.call).then(identity => { if (current) setServiceIdentity({identity, resolved: true}); });
    return () => { current = false; };
  }, [api, state.connected, state.connectionRevision, state.features.ops, state.sessionEnded, sessionEnded]);
  const previousIdentity = useRef(identity);
  useLayoutEffect(() => { if (serviceIdentity.resolved) workspaceManager.selectIdentity(location.origin, identity); reconcileIdentity(workspaceManager, previousIdentity.current, identity, state.sessionEnded || sessionEnded); previousIdentity.current = identity; }, [identity, serviceIdentity.resolved, state.sessionEnded, sessionEnded]);
  useEffect(() => { const timer = setInterval(() => { const snapshot=store.getState().snapshot; if(snapshot)workspaceManager.prune(identity,new Set(snapshot.tasks.map(task=>task.id))); },3600000); return()=>clearInterval(timer); }, [store,identity]);
  useEffect(() => { if (state.snapshot) workspaceManager.prune(identity, new Set(state.snapshot.tasks.map(task => task.id))); }, [identity, state.snapshot]);
  useEffect(() => { const flush = () => workspaceManager.flush(); window.addEventListener("pagehide", flush); return () => window.removeEventListener("pagehide", flush); }, []);
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
  const resolved = resolveRouteBeforeRender(hash, setupComplete, state.features.ops.has("session.create"));
  useEffect(() => { if (resolved.hash !== hash) location.replace(resolved.hash); }, [hash, resolved.hash]);
  const route = resolved.route;
  const pendingRoute = resolveRouteBeforeRender(hash, true).route;
  const narrow = useNarrow(route.query);
  if (!SETTINGS.has(route.name) && route.name !== "loading" && route.name !== "setup") lastWork.current = hash || "#/";
  useEffect(() => {
    keys.setScope(route.name);
    const go = (to: string) => { location.hash = inheritQuery(to, location.hash); };
    const offs = [
      registerShellCommands(commands, keys, { go, back: () => history.back(), forward: () => history.forward(), openNewTask, showHelp: () => setHelp(true), apple: isApplePlatform(), desktop: isDesktop() }),
      // Screens with a "New task" button ask the shell to open the New task composer.
      (() => { const open = () => openNewTask(); window.addEventListener("pacer:delegate", open); return () => window.removeEventListener("pacer:delegate", open); })(),
      // Escape closes the settings panel only on settings screens; elsewhere it stays with the page.
      ...[...SETTINGS].map(scope => keys.register({ keys: "Escape", label: "Close the settings panel", scope, run: () => { location.hash = lastWork.current; } })),
    ];
    const detach = attachKeyRegistry(keys, window);
    const detachContextMenu = attachContextMenuPolicy(window);
    return () => { offs.forEach(off => off()); detach(); detachContextMenu(); };
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
  return <WorkspaceIdentity.Provider value={identity}><TaskContext.Provider value={{ state, api }}><ActionContext.Provider value={actions}>
    <SetupContext.Provider value={{
      checklist: checklist === "error" ? undefined : checklist,
      refresh: () => reloadSetup(v => v + 1), running: runningSetup,
      setRunning: (id, executor) => setRunningSetup({ id, executor }),
    }}>
      <PluginContext.Provider value={plugins}><NavigationProvider route={route} pluginTitle={route.name === "plugin" ? plugins.surfaces.find(s => s.plugin === route.plugin && s.id === route.id && s.surface === "activity")?.title : undefined}><WorkspaceScope.Provider value={routeWorkspaceKey(identity, route)}><Layout route={route} loadingRoute={pendingRoute} state={{ ...state, sessionEnded: state.sessionEnded || sessionEnded }} title={route.name === "plugin" ? plugins.surfaces.find(s => s.plugin === route.plugin && s.id === route.id && s.surface === "activity")?.title ?? "Plugin view" : titleFor(route)} onDelegate={() => openNewTask()}><Screen route={route} /></Layout></WorkspaceScope.Provider></NavigationProvider></PluginContext.Provider>
    </SetupContext.Provider>
    {/* One shared bottom-right stack. Discovery prompts come and go and change height as they cycle, so they sit on top;
        the update notice stays in the corner and its Restart and Later never move. */}
    <NoticeStack narrow={narrow}>
      {DiscoveryNotice && <DiscoveryNotice hidden={help || sessionEnded || discoveryNoticeHiddenOn(route)} />}
      {UpdateNotice && <UpdateNotice hidden={help || sessionEnded || updateNoticeHiddenOn(route)} />}
    </NoticeStack>
    {help && <CommandHelp registry={keys} close={() => setHelp(false)} />}
  </ActionContext.Provider></TaskContext.Provider></WorkspaceIdentity.Provider>;
}
render(<NotificationProvider><App /></NotificationProvider>, document.getElementById("app")!);
