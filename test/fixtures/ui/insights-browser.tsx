import { render } from "preact";
import { ActionContext } from "../../../app/src/data/action-context";
import { initialState } from "../../../app/src/data/store";
import { TaskContext } from "../../../app/src/screens/task-shared";
import { Insights } from "../../../app/src/screens/insights/Insights";

const agents = ["codex", "claude-code", "agy", "cursor", "opencode", "local"];
const sums = (total: number) => ({ total, input: total, output: 0, cacheRead: 0, cacheWrite: 0, measuredAttempts: 3, partialAttempts: 1, unknownAttempts: 1 });
const day = 86400, today = Math.floor(Date.now() / 1000 / day) * day;
const summary = {
  from: today - 6 * day, to: today + day, bucket: "day", rootTasksHandled: 42, subtasks: 67, attempts: 120, retryAttempts: 9, acceptedFirstTry: 31, reviewedRoots: 40, acceptedFirstTryRate: 0.775,
  tokens: { ...sums(18_400_000), attempts: 120, lowerBound: true },
  spread: agents.map((agent, i) => ({ agent, rootTasks: 20 - i, tasks: 25 - i, subtasks: 5, attempts: 30 - i, ...sums(4_000_000 - i * 500_000), share: 0.3 - i * 0.04, tokensPerTask: 160_000, acceptanceRate: 0.8 - i * 0.05 })),
  daily: Array.from({ length: 14 }, (_, i) => ({ at: today - (13 - i) * day, byAgent: Object.fromEntries(agents.map((a, j) => [a, (i + 1) * 100_000 + j * 50_000])) })),
  kindByAgent: ["feature", "tests", "debug", "docs", "review", "a-very-long-task-kind-name"].map((kind, i) => ({ kind, byAgent: Object.fromEntries(agents.map((a, j) => [a, (i * 3 + j * 2) % 14])) })),
  ladder: [{ step: "1", name: "Capable model with spare capacity", count: 70 }, { step: "2", name: "Usable fallback", count: 24 }],
  rules: [], retryTokens: { attempts: 9, total: 1_100_000, unknownAttempts: 0 },
  skipReasons: [{ agent: "codex", reason: "Codex was more than 10 points ahead of pace and a very long reason that must wrap", count: 11 }],
  planner: { coverage: "unknown" }, decision: { coverage: "unknown" }, ranOutsidePlanner: null,
  previous: { rootTasksHandled: 34, subtasks: 50, retryAttempts: 8, acceptedFirstTryRate: 0.7, tokens: { ...sums(16_000_000), attempts: 100, lowerBound: true } },
};
const api = { call: async (op: string) => op === "insights.summary" ? summary : op === "account.list" ? [] : null } as never;
const actions = { run: async () => ({ status: "done" }), result: () => null } as never;
render(<ActionContext.Provider value={actions}><TaskContext.Provider value={{ state: { ...initialState(), connected: true }, api }}><Insights query={{ repo: null, scope: null }} /></TaskContext.Provider></ActionContext.Provider>, document.getElementById("root")!);
