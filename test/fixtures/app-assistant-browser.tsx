import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import fixture from "./ui/snapshot.json";
import { Layout } from "../../app/src/shell/Layout";
import { TaskContext } from "../../app/src/screens/task-shared";
import { NavigationProvider } from "../../app/src/navigation";
import { initialState } from "../../app/src/data/store";
import { resolveRoute, type Route } from "../../app/src/router";
import { attachKeyRegistry } from "../../app/src/keys/registry";
import { keys } from "../../app/src/keys/instance";
import { Page, PageBody, Section } from "../../app/src/ds/Page";
import { Button } from "../../app/src/ds/Button";

// Browser fixture for the assistant sheet: the real Layout and lazy host, with a stub service and a stub per-turn stream.
const w = window as any;
w.settingsCalls = []; w.asked = [] as any[]; w.recorded = [] as any[]; w.assistantStatus = { available: !location.search.includes("unconfigured"), configured: !location.search.includes("unconfigured"), account: "localmodel", limits: {}, today: { turns: 0, input: 0, output: 0 } };
const card = { id: "card-1", op: "dispatch.retry", params: { id: "t-20261028-101010-ab12", expect_rev: 3 }, title: "Retry task", summary: "Retry “ota: stale plan” as a new attempt in the same worktree, on the executor pacer routes it to.", editable: [{ name: "feedback", label: "Feedback for the new attempt", value: "" }], why: "It failed on a removed worktree.", state: "pending" };
const turn = (text: string) => ({ id: "turn-1", conversationId: "conv-1", at: 1, question: text, answer: /retry/i.test(text) ? "I suggest a retry." : "Three tasks need you.\n- t-20261028-101010-ab12 failed", state: "done", error: null, account: "localmodel", usage: null, cards: /retry/i.test(text) ? [card] : [], citations: [{ label: "t-20261028-101010-ab12", href: "#/tasks/t-20261028-101010-ab12" }], scope: { kind: "dispatch", days: 7 } });
let last = "";
const api = { async call(op: string, params: any) {
  if (op === "assistant.settings.get") return { rev: 4 };
  if (op === "assistant.settings.set") { w.settingsCalls.push(params); w.assistantStatus = { ...w.assistantStatus, configured: true, available: true, account: params.account }; return {}; }
  if (op === "assistant.candidates") return { accounts: [{ account: "localmodel", models: [{ id: "qwen", name: "Qwen" }] }, { account: "cloud", models: [{ id: "cloud-model", name: "Cloud model" }] }] };
  if (op === "assistant.status") return w.assistantStatus;
  if (op === "assistant.conversations") return { conversations: [] };
  if (op === "assistant.ask") { last = params.text; w.asked.push(params); return { conversationId: "conv-1", turnId: "turn-1" }; }
  if (op === "assistant.turn") return turn(last);
  if (op === "assistant.card.record") { w.recorded.push(params); return {}; }
  if (op === "dispatch.retry") { w.recorded.push({ op, params }); return {}; }
  if (op === "account.list") return [{ name: "localmodel", label: "Local model", usage: "unmetered", connection: { base_url_host: "localhost:1234" } }, { name: "cloud", label: "Cloud", usage: "metered", connection: { base_url_host: "api.example.test" } }];
  return {};
}, hello: async () => ({}), snapshot: async () => ({}) };
// The stream replies after a short delay so the generating state can be observed.
const realFetch = window.fetch.bind(window);
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (!/\/v3\/assistant\/turns\/[^/]+\/stream$/.test(url)) return realFetch(input, init);
  const enc = new TextEncoder();
  const body = new ReadableStream({ start(c) {
    const send = (f: unknown) => c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
    send({ status: "Thinking…" });
    setTimeout(() => { send({ delta: "partial text that must not be announced" }); }, 300);
    setTimeout(() => { send({ done: { state: "done" } }); c.close(); }, 900);
  } });
  return Promise.resolve(new Response(body, { headers: { "content-type": "text/event-stream" } }));
}) as typeof fetch;
const state = { ...initialState(), connected: true, snapshot: fixture as any, features: { readModel: true, ops: new Set(["assistant.status"]) } };
function App() {
  const [hash, setHash] = useState(location.hash || "#/dispatch");
  useEffect(() => { const update = () => setHash(location.hash); addEventListener("hashchange", update); keys.setScope((resolveRoute(hash) as Route).name); return () => removeEventListener("hashchange", update); }, [hash]);
  const route = resolveRoute(hash) as Route;
  return <TaskContext.Provider value={{ api: api as any, state }}><NavigationProvider route={route}>
    <Layout route={route} state={state} title="Dispatch">
      <Page width="full"><PageBody><Section title="Work" description="Sample page."><Button>Sample action</Button></Section></PageBody></Page>
    </Layout>
  </NavigationProvider></TaskContext.Provider>;
}
w.pageEscapes = 0;
keys.register({ keys: "Escape", label: "Page Escape", scope: "global", run: () => { w.pageEscapes++; } });
attachKeyRegistry(keys, window);
render(<App />, document.getElementById("app")!);
