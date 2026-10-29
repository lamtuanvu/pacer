import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { SessionPanel, SessionTitle, SessionWorkspace, SessionInsights, WorktreeChanges } from "../app/src/screens/session/SessionPanel";
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

test("review navigation stays offered in the title bar while Details is open", () => {
  const status = taskStatus({ state: "done" } as never), next = { label: "Review result", tab: "details" as const, open: noop };
  const render = (open: boolean) => renderToString(<FrameContext.Provider value={frame(open)}><SessionTitle status={status} live={false} facts={[]} next={next} /></FrameContext.Provider>);
  expect(render(false)).toMatch(/pc-btn--primary[^>]*>Review result</);
  expect(render(true)).toContain("Review result");
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

test("routing and tokens sections exist only with reported data", () => {
  expect(renderToString(<SessionInsights task={{} as never} />)).toBe("");
  const html = renderToString(<SessionInsights task={{ routing: { chosen: "codex", why: "Spare capacity" }, tokens: { total: 1234, input: 1000, output: 234, cacheRead: 0, cacheWrite: 0, measuredAttempts: 1, partialAttempts: 0, unknownAttempts: 0, lowerBound: false } } as never} />);
  expect(html).toContain("Why Codex"); expect(html).toContain("Spare capacity");
  expect(html).toContain("Tokens"); expect(html).toContain("1,234");
  expect(renderToString(<SessionInsights task={{ tokens: { measuredAttempts: 0, partialAttempts: 0, unknownAttempts: 1 } } as never} />)).toBe("");
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

for (const [name, extra, labels] of [
  ["measured without cache", { reported: { input: true, output: true, cacheRead: false, cacheWrite: false } }, ["Input", "Output"]],
  ["all fields", { reported: { input: true, output: true, cacheRead: true, cacheWrite: true } }, ["Input", "Output", "Cache read", "Cache write"]],
  ["partial", { lowerBound: true, partialAttempts: 1, reported: { input: true, output: true, cacheRead: true, cacheWrite: true } }, []],
] as const) test(`insights report only known splits: ${name}`, () => {
  const tokens = { total: 1234, input: 1000, output: 234, cacheRead: 0, cacheWrite: 0, measuredAttempts: 1, partialAttempts: 0, lowerBound: false, ...extra };
  const html = renderToString(<SessionInsights task={{ tokens } as never} />);
  expect(html).toContain("1,234");
  for (const label of ["Input", "Output", "Cache read", "Cache write"]) {
    expect(html.includes(`<dt>${label}</dt>`)).toBe((labels as readonly string[]).includes(label));
  }
  expect(html.includes("Partial usage")).toBe(tokens.lowerBound);
});

for (const mode of ["mixed", "partial", "all-present", "not-reported"] as const) test(`insights field completeness: ${mode}`, () => {
  const tokens = { total: 1234, input: 1000, output: 234, cacheRead: 100, cacheWrite: 0,
    measuredAttempts: 2, partialAttempts: 0, lowerBound: mode === "partial",
    reported: { input: true, output: true, cacheRead: mode !== "not-reported", cacheWrite: mode !== "not-reported" },
    complete: { input: true, output: true, cacheRead: mode === "all-present", cacheWrite: mode === "all-present" } };
  const html = renderToString(<SessionInsights task={{ tokens } as never} />);
  expect(html).toContain(`<p class="mono">${mode === "partial" ? "≥ " : ""}1,234</p>`);
  if (mode === "partial") {
    expect(html).not.toContain("<dt>");
    expect(html).toContain("Partial usage; some attempt tokens are not reported.");
  } else {
    expect(html).toContain("<dt>Input</dt><dd>1,000</dd>");
    expect(html).toContain("<dt>Output</dt><dd>234</dd>");
    if (mode === "not-reported") expect(html).not.toContain("<dt>Cache");
    else {
      expect(html).toContain(`<dt>Cache read</dt><dd>${mode === "mixed" ? "≥ " : ""}100`);
      expect(html).toContain(`<dt>Cache write</dt><dd>${mode === "mixed" ? "≥ " : ""}0`);
    }
  }
  expect(html.includes("Some attempts did not report this field.")).toBe(mode === "mixed");
});
