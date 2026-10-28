import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { SessionPanel, SessionTitle, WorktreeChanges } from "../app/src/screens/session/SessionPanel";
import { SidePanel } from "../app/src/ds/SidePanel";
import { PanelTabs } from "../app/src/ds/PanelTabs";
import { FrameContext } from "../app/src/shell/slots";
import { panelCommands } from "../app/src/shell/panels";
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
