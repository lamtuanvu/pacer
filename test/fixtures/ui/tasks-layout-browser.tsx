import { render } from "preact";
import { TaskContext } from "../../../app/src/screens/task-shared";
import { initialState } from "../../../app/src/data/store";
import { Layout } from "../../../app/src/shell/Layout";
import { Sessions } from "../../../app/src/screens/session/controller";
import { NavigationProvider } from "../../../app/src/navigation";
import { resolveRoute, type Route } from "../../../app/src/router";
import fixture from "./snapshot.json";

// A real mounted Tasks board, so the header/right FrameSlots actually portal (unlike renderToString, where the
// refs that back them never fire). Used by app-tasks-layout.test.tsx to measure the board against a live frame.
const state = { ...initialState(), connected: true, features: { readModel: true, ops: new Set<string>() }, snapshot: fixture } as any;
const route = resolveRoute("#/tasks") as Route;
// task.get backs the Inspector's "Selected task" aside (TaskAside); other ops are unused by this fixture.
const api = { call: async (op: string) => op === "task.get" ? { startedAt: 1000, endedAt: 1720, timeline: [] } : {} };
render(
  <TaskContext.Provider value={{ state, api: api as any }}>
    <NavigationProvider route={route}>
      <Layout route={route} state={state} title="Tasks">
        <Sessions query={route.query} />
      </Layout>
    </NavigationProvider>
  </TaskContext.Provider>,
  document.getElementById("app")!,
);
