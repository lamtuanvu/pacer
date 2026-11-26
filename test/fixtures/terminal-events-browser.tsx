import { render } from "preact";
import { useState } from "preact/hooks";
import { initialState, reduceStore } from "../../app/src/data/store";
import { TaskContext } from "../../app/src/screens/task-shared";
import { TerminalScreen } from "../../app/src/screens/terminal/Terminal";
import { emptySnapshot } from "../../src/link/envelope";

/** Renders the real Terminal screen against a fake API so tests can count terminal.list calls. */
const announced = new URLSearchParams(location.search).get("announced") === "1";
const calls: string[] = [];
(window as any).terminalCalls = calls;
let state = {
  ...initialState(),
  connected: true,
  needsSnapshot: false,
  snapshot: { ...emptySnapshot(), seq: 1, repos: [] },
  features: { readModel: false, terminalEvents: announced, ops: new Set(["terminal.create", "terminal.list"]) },
} as any;
let seq = 1;
const api = {
  call: async (op: string): Promise<unknown> => {
    calls.push(op);
    return op === "terminal.list" ? [] : {};
  },
};

function App() {
  const [, setRevision] = useState(0);
  const apply = (next: any) => { state = next; setRevision(revision => revision + 1); };
  (window as any).terminalEmit = (type: string) => apply(reduceStore(state, {
    type: "event",
    event: type === "terminal"
      ? { seq: ++seq, at: 2, type, data: { id: "shell-1", value: { id: "shell-1", title: "zsh" } } }
      : { seq: ++seq, at: 2, type: "config" as any, data: { area: "other", at: 2 } },
  }));
  (window as any).terminalReconnect = () => apply(reduceStore(reduceStore(state, { type: "disconnected" }), { type: "reconnected" }));
  return <TaskContext.Provider value={{ state, api } as any}><TerminalScreen query={{ repo: null, scope: null } as any} /></TaskContext.Provider>;
}

render(<App />, document.getElementById("app")!);
