import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ActionContext } from "../../../app/src/data/action-context";
import { createActionRunner } from "../../../app/src/data/actions";
import { initialState } from "../../../app/src/data/store";
import { TaskContext } from "../../../app/src/screens/task-shared";
import { DispatchHome } from "../../../app/src/screens/dispatch/Dispatch";
import { Insights } from "../../../app/src/screens/insights/Insights";
import { Sessions } from "../../../app/src/screens/session/controller";
import { Rail } from "../../../app/src/shell/Rail";
import { TopBar } from "../../../app/src/shell/TopBar";
import { StatusBar } from "../../../app/src/shell/StatusBar";
import { CommandTrigger } from "../../../app/src/shell/CommandTrigger";
import { PluginContext } from "../../../app/src/plugins/catalog";
import { NavigationProvider } from "../../../app/src/navigation";
import { resolveRoute, type Route } from "../../../app/src/router";
import { keys } from "../../../app/src/keys/instance";
import fixture from "./snapshot.json";
import taskDetail from "./task-get.json";
import type { ClientSnapshot } from "../../../src/view-model/snapshot";
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

const pending: { op: string; before?: unknown; resolve(value: unknown): void; reject(error: Error): void; value: unknown }[] = [];
const controls = { hold: false, holdOlder: false, fail: false,
  get pending() { return pending.map(({op,before})=>({op,before})); },
  release() { for (const item of pending.splice(0)) this.fail ? item.reject(new Error("Read failed")) : item.resolve(item.value); }
};
Object.assign(window, { refreshFixture: controls });
let count = 42;
const api = { async call(op: string, params: Record<string, unknown> = {}) {
  if (op === "task.get") return {...taskDetail,id:params.id};
  const root = {id:"history-root",parentId:null,rootId:"history-root",depth:0,title:"Historical root",state:"done",executor:"codex",rev:1};
  const historyTask = {...fixture.tasks[0], id:root.id, goal:root.title, title:root.title, state:"done",repo:{...fixture.repos[0],key:params.repo ?? fixture.repos[0]!.key}};
  const work = params.before ? [{...root,id:"history-child",parentId:root.id,depth:1,title:"Historical child"}] : [root];
  const value = op === "insights.summary" ? {...summary, from: params.from, to: params.to, rootTasksHandled: count++} : op === "task.list" ? {tasks:[historyTask],next:null} : op === "dispatch.list" ? {tasks:work,next:params.before ? null : "older"} : op === "account.list" ? [] : {};
  if ((controls.hold || (controls.holdOlder && params.before)) && ["insights.summary", "task.list", "dispatch.list"].includes(op)) return new Promise((resolve, reject) => pending.push({op,before:params.before,resolve,reject,value}));
  return value;
} };
const snapshot = fixture as unknown as ClientSnapshot;
const state = {...initialState(), connected:true, snapshot, features:{readModel:true,ops:new Set(["insights.summary","task.list","dispatch.list"])}};
const actions = createActionRunner({call:api.call as never,waitFor:async()=>true,refetch:()=>{},navigate:()=>{}});
const catalog = {surfaces:[{plugin:"release",id:"checklist",surface:"activity",visible:true,title:"Release checklist",icon:"check-square"}],revision:0,reload:()=>{}};
function Preview() {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => { const update = () => setHash(location.hash); addEventListener("hashchange",update); return () => removeEventListener("hashchange",update); },[]);
  const route = resolveRoute(hash) as Route;
  const query = route.query;
  return <TaskContext.Provider value={{state,api:api as never}}><ActionContext.Provider value={actions}><PluginContext.Provider value={catalog as never}><NavigationProvider route={route}>
    <TopBar title="Dispatch" planner={null} mode="normal" connected lastUpdate={null} onDelegate={()=>{}} search={<CommandTrigger onOpen={()=>{}}/>}/>
    <div className="pc-shell"><Rail route={route} counts={snapshot.counts ?? null}/><main className="pc-main">
      {route.name === "insights" ? <Insights query={query}/> : route.name === "sessions" ? <Sessions query={query}/> : <DispatchHome query={query}/>}
    </main></div><StatusBar snapshot={snapshot} registry={keys} terminal={{open:false,toggle:()=>{}}}/>
  </NavigationProvider></PluginContext.Provider></ActionContext.Provider></TaskContext.Provider>;
}
render(<Preview/>,document.getElementById("root")!);
