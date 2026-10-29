import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { SessionPanel, SessionHeader, SessionFiles, SessionTitle, SessionWorkspace, SessionInsights, WorktreeChanges } from "../app/src/screens/session/SessionPanel";
import { SidePanel } from "../app/src/ds/SidePanel";
import { PanelTabs } from "../app/src/ds/PanelTabs";
import { FrameContext } from "../app/src/shell/slots";
import { panelCommands } from "../app/src/shell/panels";
import { Brief } from "../app/src/screens/session/Session";
import { sessionDetail } from "../app/src/screens/session/controller";
import taskDetail from "./fixtures/ui/task-get.json";
import { taskStatus } from "../src/view-model/words";

const noop = () => {};
const frame = (open: boolean) => ({ title: null, left: null, right: null, inline: false, heading: noop, details: { open, toggle: noop } });

test("changes_tab_lists_worktree_files (markup)", () => {
  const diff = { patch: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\n", untracked: ["new.png"], truncated: false };
  const html = renderToString(<WorktreeChanges diff={diff} />);
  expect(html).toContain("2 files changed");
  expect(html).toContain('aria-label="Changed files"');
  expect(html).toContain('title="a.ts"');
  expect(html).toContain(">new<");
  expect(html).toContain('aria-label="Full diff"');
  expect(renderToString(<WorktreeChanges diff={{ patch: "", untracked: [], truncated: false }} />)).toContain("No changes so far.");
  expect(renderToString(<WorktreeChanges error="Could not load" />)).toContain('role="alert"');
});

test("no_actions_on_ended_session (markup)", () => {
  const ended = renderToString(<FrameContext.Provider value={frame(true)}><SessionTitle status={taskStatus({ state: "done" } as never)} live={false} facts={["ended 5m ago"]} /></FrameContext.Provider>);
  expect(ended).not.toContain("<button");
  const live = renderToString(<FrameContext.Provider value={frame(false)}><SessionTitle status={taskStatus({ state: "running" } as never)} live facts={[]}
    actions={<button aria-label="End session">x</button>} /></FrameContext.Provider>);
  expect(live).toContain("End session");
});

test("session panel tabs point at their tabpanel and Work appears only when provided", () => {
  const html = renderToString(<SessionPanel id="t-1" tab="changes" onTab={noop} changes={<p>c</p>} details={<p>d</p>} />);
  expect(html).toContain('id="session-t-1-panel-changes-tab"');
  expect(html).toContain('aria-controls="session-t-1-panel-changes-panel"');
  expect(html).toContain('role="tabpanel" id="session-t-1-panel-changes-panel" aria-labelledby="session-t-1-panel-changes-tab"');
  expect(html).not.toContain(">Work<");
  expect(renderToString(<SessionPanel id="t-1" tab="work" onTab={noop} changes={<p>c</p>} details={<p>d</p>} work={<p>w</p>} />)).toContain("<p>w</p>");
  expect(renderToString(<SessionPanel id="t-1" tab="work" onTab={noop} changes={<p>c</p>} details={<p>d</p>} />)).toContain("<p>d</p>");
});

test("side panel without its own bar renders nothing when closed and no toggle when open", () => {
  expect(renderToString(<SidePanel side="right" label="Details" open={false} onToggle={noop} bar={false}>x</SidePanel>)).toBe("");
  const open = renderToString(<SidePanel side="right" label="Details" open onToggle={noop} bar={false}>x</SidePanel>);
  expect(open).not.toContain("<button");
  expect(open).toContain('id="pc-side-panel-right"');
  expect(renderToString(<PanelTabs label="L" tabs={[{ id: "a", label: "A" }]} value="a" onChange={noop} />)).not.toContain("aria-controls");
});

test("details panel shortcut is registered only where a right panel exists", () => {
  expect(panelCommands(noop, noop, noop).map(s => s.keys)).toEqual(["Mod-b", "Ctrl-B", "Ctrl-`"]);
  expect(panelCommands(noop, noop).map(s => s.keys)).not.toContain("Ctrl-B");
});

test("next step is offered in the title bar only while the details panel is closed", () => {
  const status = taskStatus({ state: "done" } as never), next = { label: "Review result", tab: "details" as const, open: noop };
  const render = (open: boolean) => renderToString(<FrameContext.Provider value={frame(open)}><SessionTitle status={status} live={false} facts={[]} next={next} /></FrameContext.Provider>);
  expect(render(false)).toMatch(/pc-btn--primary[^>]*>Review result</);
  expect(render(true)).not.toContain("Review result");
  // Narrow layouts have no panel to reopen, so no button.
  expect(renderToString(<FrameContext.Provider value={{ ...frame(false), details: undefined }}><SessionTitle status={status} live={false} facts={[]} next={next} /></FrameContext.Provider>)).not.toContain("Review result");
});

// Workspace reads only the public task.get fields; missing facts have no placeholder rows.
test("workspace shows available task detail fields only", () => {
  const task = { repo: { label: "acme/api" }, branch: "feature/session", base: "main", worktree: "/tmp/worktree", machine: "devbox" };
  const html = renderToString(<SessionWorkspace task={task as never} />);
  expect(html).toContain("Workspace</h3>");
  expect(html).toContain("<dl");
  for (const [label, value] of [["Repo", "acme/api"], ["Branch", "feature/session"], ["Base", "main"], ["Worktree", "/tmp/worktree"], ["Machine", "devbox"]]) {
    expect(html).toContain(`<dt>${label}</dt><dd>${value}</dd>`);
  }
  const sparse = renderToString(<SessionWorkspace task={{ repo: { label: "acme/api" } } as never} />);
  for (const label of ["Branch", "Base", "Worktree", "Machine"]) expect(sparse).not.toContain(`<dt>${label}</dt>`);
});

test("live token section distinguishes unreported and partial usage", () => {
  expect(renderToString(<SessionInsights task={{} as never}/>)).toContain("No token usage reported yet");
  const task = {id:"t-1", executor:"codex", routing:{chosen:"codex",why:"Spare capacity",policy:{executors:["codex"]}}, tokens:{total:1234, measuredAttempts:1, partialAttempts:0,lowerBound:true}};
  const html = renderToString(<SessionInsights task={task as never}/>);
  expect(html).toContain("Why Codex"); expect(html).toContain("Ladder step 1 · Spare capacity");
  expect(html).toContain("Tokens, live"); expect(html).toContain("≥ 1.2k"); expect(html).toContain("partial usage");
  expect(html).not.toContain("<dl"); expect(html).toContain("#/tasks/t-1/trace");
});

test("session header retains title, caption and working end action", () => {
  const task = {...taskDetail,id:"t-1",title:"Session title",branch:"topic"} as never;
  const html = renderToString(<SessionHeader task={task} onEnd={noop}/>);
  expect(html).toContain('<h2 title="Session title">Session title</h2>');
  expect(html).toContain("acme/api · topic"); expect(html).toContain("#/tasks/t-1/trace");
  expect(html).toContain("End session (asks to confirm)");
  expect(renderToString(<SessionHeader task={task}/>)).not.toContain("End session");
});

test("side-panel files link to review and expose file actions only with a reader", () => {
  const props = {id:"t-1",diff:{patch:"",untracked:["new.ts"],truncated:false}};
  const html = renderToString(<SessionFiles {...props} onOpen/>);
  expect(html).toContain("Changes · 1 files"); expect(html).toContain("#/tasks/t-1/review");
  expect(html).toContain('data-session-file="new.ts"');
  expect(renderToString(<SessionFiles {...props}/>)).not.toContain("<button");
});

test("caption orders repository and branch before time and omits absent facts", () => {
  const html = renderToString(<SessionTitle status={taskStatus({ state: "running" } as never)} live facts={["12m"]} repo="acme/api" branch="feature/session" />);
  expect(html).toMatch(/title="Repository"[^>]*>acme\/api/);
  expect(html).toContain('title="Branch"');
  expect(html.indexOf("acme/api")).toBeLessThan(html.indexOf("feature/session"));
  expect(html.indexOf("feature/session")).toBeLessThan(html.indexOf("12m"));
  expect(renderToString(<SessionTitle status={taskStatus({ state: "done" } as never)} live={false} facts={[]} />)).not.toContain('title="Repository"');
});

test("details group keeps workspace first and the brief uses a wrapping label and acceptance code", () => {
  const task = taskDetail as never;
  const html = renderToString(<div className="pc-session-details"><SessionWorkspace task={task} /><SessionInsights task={task} /><Brief data={sessionDetail(task)} /></div>);
  expect(html.indexOf("Workspace</h3>")).toBeLessThan(html.indexOf("Why Codex"));
  expect(html).toContain('class="pc-session-repository">acme/api</code>');
  expect(html).toContain('class="pc-session-command"><code>bun test</code>');
  expect(html).not.toContain('class="pc-code-scroll" tabindex="0">/tmp/fixture/api</code>');
});

test("empty or removed changes do not offer an unusable diff or deleted-file preview", () => {
  expect(renderToString(<SessionFiles id="t-1"/>)).not.toContain("Open diff");
  const diff={patch:"",untracked:[],truncated:false,files:[{path:"deleted.ts",added:0,removed:3,status:"deleted" as const}]};
  expect(renderToString(<SessionFiles id="t-1" diff={diff} onOpen/>)).not.toContain("data-session-file");
});
