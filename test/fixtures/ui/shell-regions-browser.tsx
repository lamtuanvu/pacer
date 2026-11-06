import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { TaskContext } from "../../../app/src/screens/task-shared";
import { NavigationProvider } from "../../../app/src/navigation";
import { initialState } from "../../../app/src/data/store";
import { Layout } from "../../../app/src/shell/Layout";
import { Sessions } from "../../../app/src/screens/session/controller";
import { NewTask } from "../../../app/src/screens/new-task/NewTask";
import { resolveRoute, type Route } from "../../../app/src/router";
import fixture from "./snapshot.json";

// A dedicated fixture (not shared with other browser tests) for exercising the real Tasks board and New task
// screen against the real Layout/AppFrame, with hash navigation between them, so the header and right-panel
// FrameSlots actually portal (their refs only fire once Preact mounts for real).
const state = { ...initialState(), connected: true, features: { readModel: true, ops: new Set<string>() }, snapshot: fixture } as any;
// task.get backs the Tasks Inspector's "Selected task" aside; other ops are unused by this fixture.
const api = { call: async (op: string) => op === "task.get" ? { startedAt: 1000, endedAt: 1720, timeline: [] } : {} };

function App() {
  const [hash, setHash] = useState(location.hash || "#/tasks");
  useEffect(() => {
    const update = () => setHash(location.hash);
    addEventListener("hashchange", update);
    return () => removeEventListener("hashchange", update);
  }, []);
  const route = resolveRoute(hash) as Route;
  return (
    <TaskContext.Provider value={{ state, api: api as any }}>
      <NavigationProvider route={route}>
        <Layout route={route} state={state} title="Tasks">
          {route.name === "new-task" ? <NewTask query={route.query} /> : <Sessions query={route.query} />}
        </Layout>
      </NavigationProvider>
    </TaskContext.Provider>
  );
}
render(<App />, document.getElementById("app")!);
