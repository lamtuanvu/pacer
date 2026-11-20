import { render } from "preact";
import { AssistantSettingsSection } from "../../app/src/screens/settings/AssistantSettings";
import { TaskContext } from "../../app/src/screens/task-shared";
import { initialState } from "../../app/src/data/store";
import { DensityContext } from "../../app/src/ds/Density";

// Browser fixture for Settings › Assistant: stubbed candidates with a pacer and an unchecked executor row.
const w = window as any;
w.settingsCalls = [] as unknown[];
w.selftestCalls = [] as unknown[];
// `?already-executor` starts with the executor backend saved so Save must not re-prompt.
const alreadyExecutor = location.search.includes("already-executor");
w.assistantSettings = alreadyExecutor
  ? { rev: 2, account: "oc", backend: "executor", runner: null, limits: { turnsPerDay: 50 }, retention: { days: 30 } }
  : { rev: 2, account: null, backend: "pacer", runner: null, limits: { turnsPerDay: 50 }, retention: { days: 30 } };
w.candidates = {
  accounts: [
    { account: "localmodel", backend: "pacer", available: true, models: [{ id: "qwen", name: "Qwen" }], runners: [{ id: "opencode#localmodel", model: "qwen" }], isPlanner: false },
    {
      account: "oc", backend: "executor",
      available: alreadyExecutor,
      ...(alreadyExecutor ? {} : { reason: "oc has not passed the ask-mode check yet." }),
      models: [{ id: "glm", name: "GLM" }], runners: [{ id: "opencode#oc", model: "glm" }], isPlanner: false,
    },
  ],
  reads: [
    "Counts, attention items, the pacing mode and whether delegation is paused.",
    "Titles, states, executors and times of tasks, with their decisions, attempts and review state.",
  ],
};
w.assistantToday = { available: false, today: { turns: 0, input: 0, output: 0 } };

const api = {
  async call(op: string, params: unknown) {
    if (op === "assistant.settings.get") return w.assistantSettings;
    if (op === "assistant.settings.set") {
      w.settingsCalls.push(params);
      const next = params as { account: string | null; backend: string; runner: string | null; expect_rev: number; limits?: { turnsPerDay: number }; retention?: { days: number } };
      w.assistantSettings = {
        ...w.assistantSettings,
        rev: w.assistantSettings.rev + 1,
        account: next.account,
        backend: next.backend,
        runner: next.runner,
        ...(next.limits ? { limits: next.limits } : {}),
        ...(next.retention ? { retention: next.retention } : {}),
      };
      return w.assistantSettings;
    }
    if (op === "assistant.candidates") return w.candidates;
    if (op === "assistant.status") return w.assistantToday;
    if (op === "assistant.selftest") {
      w.selftestCalls.push(params);
      const account = (params as { account: string }).account;
      w.candidates = {
        ...w.candidates,
        accounts: w.candidates.accounts.map((row: { account: string; backend: string }) =>
          row.account === account && row.backend === "executor" ? { ...row, available: true, reason: undefined } : row),
      };
      return { passed: true };
    }
    if (op === "assistant.delete") return {};
    return {};
  },
  hello: async () => ({}),
  snapshot: async () => ({}),
};

render(
  <DensityContext.Provider value="compact">
    <TaskContext.Provider value={{ api: api as any, state: { ...initialState(), connected: true } }}>
      <div className="u3-settings" id="settings-root"><AssistantSettingsSection /></div>
    </TaskContext.Provider>
  </DensityContext.Provider>,
  document.getElementById("app")!,
);
