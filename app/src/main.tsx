import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { createStore } from "./store";
import { resolveRoute, type Route } from "./router";
import { Shell } from "./shell/Shell";
import { Home } from "./screens/Home";
import { Tasks } from "./screens/Tasks";
import { TaskDetail } from "./screens/TaskDetail";
import { Executors } from "./screens/Executors";
import { AddExecutor } from "./screens/AddExecutor";
import { Accounts } from "./screens/Accounts";
import { Strategy } from "./screens/Strategy";
import { Hosts } from "./screens/Hosts";
import { Settings } from "./screens/Settings";
import { Setup } from "./screens/Setup";
const store = createStore();
function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case "home": return <Home />;
    case "setup": return <Setup />;
    case "tasks": return <Tasks />;
    case "task": return <TaskDetail />;
    case "executors": return <Executors />;
    case "add-executor": return <AddExecutor />;
    case "accounts": return <Accounts />;
    case "strategy": return <Strategy />;
    case "hosts": return <Hosts />;
    case "settings": return <Settings />;
    default: return <section><h1>Page not found</h1><a href="#/">Go to Home</a></section>;
  }
}
function App() {
  const [state, setState] = useState(store.getState);
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const unsubscribe = store.subscribe(() => setState(store.getState()));
    const stop = store.start();
    const navigate = () => setHash(location.hash);
    window.addEventListener("hashchange", navigate);
    return () => { unsubscribe(); stop(); window.removeEventListener("hashchange", navigate); };
  }, []);
  // Task 4 adds the complete setup checklist. Only known required failures gate this scaffold.
  const setupComplete = state.snapshot?.serviceInstalled !== false && !!state.snapshot?.budget?.planner;
  const route = resolveRoute(hash, setupComplete);
  return <Shell state={state} route={route}><Screen route={route} /></Shell>;
}
render(<App />, document.getElementById("app")!);
