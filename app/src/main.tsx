import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { createApi } from "./data/api";
import type { SetupChecklist } from "../../src/setup/checklist";
import { TaskContext } from "./screens/task-shared";
import { createStore } from "./data/store";
import { resolveRoute, type Route } from "./router";
import { attachKeyRegistry, createKeyRegistry } from "./keys/registry";
import { Layout } from "./shell/Layout";
import { CommandHelp } from "./shell/CommandHelp";
import { Home } from "./screens/Home";
import { Tasks } from "./screens/Tasks";
import { TaskDetail } from "./screens/TaskDetail";
import { AddExecutor } from "./screens/AddExecutor";
import { Hosts } from "./screens/Hosts";
import { SettingsGeneral } from "./screens/SettingsGeneral";
import { Setup } from "./screens/Setup";
const store = createStore();
export const keys = createKeyRegistry({ controlActive: () => false });
const TITLES: Record<Route["name"], string> = { overview: "Overview", review: "Review", sessions: "Sessions", settings: "Settings", hosts: "Remote hosts", "add-executor": "Add executor", setup: "Setup", loading: "pacer", "not-found": "Page not found" };
function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case "overview": return <Home />;
    case "review": return <section><p className="muted">Review is being rebuilt.</p></section>;
    case "sessions": return route.id ? <TaskDetail id={route.id} /> : <Tasks />;
    case "settings": return <SettingsGeneral section={route.section} />;
    case "hosts": return <Hosts />;
    case "add-executor": return <AddExecutor />;
    case "setup": return <Setup />;
    case "loading": return null;
    default: return <section><h1>Page not found</h1><a href="#/">Go to Overview</a></section>;
  }
}
const SETTINGS = new Set(["settings", "hosts", "add-executor"]);
function App() {
  const [state, setState] = useState(store.getState);
  const [sessionEnded, setSessionEnded] = useState(false);
  const api = useMemo(() => createApi(() => setSessionEnded(true)), []);
  const [hash, setHash] = useState(location.hash);
  const [help, setHelp] = useState(false);
  const lastWork = useRef("#/");
  useEffect(() => {
    const unsubscribe = store.subscribe(() => setState(store.getState()));
    const stop = store.start();
    const navigate = () => setHash(location.hash);
    window.addEventListener("hashchange", navigate);
    return () => { unsubscribe(); stop(); window.removeEventListener("hashchange", navigate); };
  }, []);
  const [checklist, setChecklist] = useState<SetupChecklist | "error">();
  useEffect(() => {
    let active = true;
    const refresh = () => { void api.call<SetupChecklist>("setup.check", {}).then(result => { if (active) setChecklist(result); }, () => { if (active) setChecklist(c => c ?? "error"); }); };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [api, state.invalidations.setup, state.connected]);
  // Unknown until the first setup check answers, so screens wait instead of flashing Setup.
  const setupComplete = checklist === undefined ? null : checklist !== "error" && checklist.complete;
  const resolved = resolveRoute(hash, setupComplete, id => state.snapshot?.tasks.find(t => t.id === id)?.state);
  useEffect(() => { if ("redirect" in resolved) location.replace(resolved.redirect); }, [hash, "redirect" in resolved]);
  const route: Route = "redirect" in resolved ? { name: "loading", query: { repo: null, scope: null } } : resolved;
  if (!SETTINGS.has(route.name) && route.name !== "loading") lastWork.current = hash || "#/";
  useEffect(() => {
    keys.setScope(route.name);
    const go = (to: string) => () => { location.hash = to; };
    const offs = [
      keys.register({ keys: "g o", label: "Go to Overview", scope: "global", run: go("#/") }),
      keys.register({ keys: "g r", label: "Go to Review", scope: "global", run: go("#/review") }),
      keys.register({ keys: "g s", label: "Go to Sessions", scope: "global", run: go("#/sessions") }),
      keys.register({ keys: ",", label: "Open Settings", scope: "global", run: go("#/settings") }),
      keys.register({ keys: "?", label: "Show keyboard shortcuts", scope: "global", run: () => setHelp(true) }),
      keys.register({ keys: "Escape", label: "Close the settings panel", scope: "global", run: () => { if (SETTINGS.has(keys.scope() ?? "")) location.hash = lastWork.current; } }),
    ];
    const detach = attachKeyRegistry(keys, window);
    return () => { offs.forEach(off => off()); detach(); };
  }, []);
  useEffect(() => { keys.setScope(route.name); }, [route.name]);
  return <TaskContext.Provider value={{ state, api }}>
    <Layout route={route} state={{ ...state, sessionEnded: state.sessionEnded || sessionEnded }} title={TITLES[route.name]}><Screen route={route} /></Layout>
    {help && <CommandHelp registry={keys} close={() => setHelp(false)} />}
  </TaskContext.Provider>;
}
render(<App />, document.getElementById("app")!);
