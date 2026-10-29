import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { Session } from "../app/src/screens/session/Session";
import { SessionView } from "../app/src/screens/session/SessionView";
import type { SessionData } from "../app/src/screens/session/types";
import type { TaskDetail } from "../src/core/task-detail";
import type { SessionInfo } from "../src/session/service";
import fixture from "./fixtures/ui/session.json";

test("both built-in session routes share the linked terminal container", () => {
  const data = { ...(fixture as SessionData), session: { ...(fixture as SessionData).session!, attempt: 2 } };
  const task = { id: data.id, state: "running" } as TaskDetail;
  for (const html of [
    renderToString(<Session data={data} onReadFile={async () => { throw Error("unused"); }} />),
    renderToString(<SessionView task={task} session={data.session as SessionInfo} active footer={null}
      takeRequested={false} onTakeSent={() => {}} onFiles={() => {}} onReadFile={async () => { throw Error("unused"); }} />),
  ]) {
    expect(html).toContain("data-linked-terminal");
    // The terminal sits in the layout that can hold a side-by-side viewer; no viewer renders until a link opens.
    expect(html).toContain("pc-linked-terminal__term");
    expect(html).not.toContain("pc-linked-terminal--viewing");
    expect(html).not.toContain("pc-file-viewer");
  }
});
