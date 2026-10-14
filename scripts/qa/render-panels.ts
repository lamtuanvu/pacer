import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { renderPanel } from "../../orca-plugin/src/panel";
import { renderBootstrapPanel } from "../../orca-plugin/src/panel/bootstrap";
import { emptySnapshot, type LinkSnapshot } from "../../src/link/envelope";
import { setupChecklist } from "../../src/setup/checklist";

// Frozen time keeps tasks, ages, and console liveness reproducible.
const nowS = 1_800_000_000;
const incomplete = setupChecklist({version:null,planner:null,service:{installed:false,running:false},link:false,live:false,agents:[{id:"codex",name:"Codex",installed:false}]},nowS);
const complete = setupChecklist({version:"0.1.22",planner:"claude-code",service:{installed:true,running:true},link:true,live:true,agents:[{id:"codex",name:"Codex",installed:true}]},nowS);
const liveConsole = {handle:"term_qa",paneKey:null,pid:1,startedAt:nowS-60,heartbeatAt:nowS,version:"0.1.22"};
const operations:LinkSnapshot = {...emptySnapshot(),at:nowS,budget:{generatedAt:nowS,strategy:"default",planner:"claude-code",mode:"normal",providers:[
 {id:"claude-code",verdict:"ON_PACE",usedPct:30,pacePct:28,resetsAt:nowS+86400,window:null,stale:false},
 {id:"codex",verdict:"OK",usedPct:12,pacePct:25,resetsAt:nowS+86400,window:null,stale:false},
],ranked:[{id:"codex",verdict:"OK"}]},strategies:[{name:"default",description:"Sidebar QA",summary:"Protect the planner and use available executors",active:true}]};
const tasks:LinkSnapshot = {...operations,console:liveConsole,tasks:[
 {id:"qa_running",state:"running",goal:"Check sidebar layout with a running task and a long detail that wraps",executor:"codex",backend:"orca",worktree:null,updatedAt:nowS-30,runnerAlive:true,terminalPresent:true},
 {id:"qa_failed",state:"failed",goal:"Fix the panel layout after the acceptance command failed",executor:"claude-code",backend:"orca",worktree:null,updatedAt:nowS-60,terminalPresent:true},
]};
const view = {nowS,reachable:true,transport:"http" as const};
const fixtures:Record<string,string> = {
 "marketplace":renderBootstrapPanel(),
 "setup-without-console":renderPanel({...emptySnapshot(),at:nowS},{...view,reachable:false,setup:incomplete}),
 "setup-with-console":renderPanel({...emptySnapshot(),at:nowS,console:liveConsole},{...view,setup:incomplete}),
 "operations-without-console":renderPanel(operations,{...view,setup:complete}),
 "operations-with-tasks":renderPanel(tasks,{...view,setup:complete}),
 "operations-update":renderPanel({...operations,console:liveConsole},{...view,setup:complete,updates:{cli:"0.1.22",plugin:"0.1.22",latest:"0.1.23",available:true}}),
};
const themes = {
 light:"--background:#ffffff;--foreground:#18181b;--muted:#f4f4f5;--muted-foreground:#71717a;--border:#e4e4e7;--card:#ffffff;--radius:10px;--primary:#18181b",
 dark:"--background:#18181b;--foreground:#fafafa;--muted:#27272a;--muted-foreground:#a1a1aa;--border:#3f3f46;--card:#202023;--radius:10px;--primary:#fafafa",
};
// Host-only actions are inert, but the real client still populates providers,
// task text, and the view buttons. No Orca session or network is required.
const output = resolve(process.argv[2] ?? ".work/fixtures/panels");
await mkdir(output,{recursive:true});
for (const [name,html] of Object.entries(fixtures)) for (const [theme,vars] of Object.entries(themes)) {
 const themed=html.replace('</head>',`<style>:root{color-scheme:${theme};${vars}}body{width:340px;max-width:340px;min-height:100vh}</style></head>`);
 const file=join(output,`${name}-${theme}.html`);
 await Bun.write(file,themed);
 console.log(file);
}
