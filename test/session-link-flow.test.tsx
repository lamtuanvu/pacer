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
  expect(renderToString(<Session data={data} onReadFile={async () => { throw Error("unused"); }} />)).toContain("data-linked-terminal");
  const task = { id: data.id, state: "running" } as TaskDetail;
  expect(renderToString(<SessionView task={task} session={data.session as SessionInfo} active footer={null}
    takeRequested={false} onTakeSent={() => {}} onFiles={() => {}} onReadFile={async () => { throw Error("unused"); }} />))
    .toContain("data-linked-terminal");
});
