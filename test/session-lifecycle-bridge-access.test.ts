import { expect, test } from "bun:test";
import { clientIdentity } from "../src/api/client-identity";
import { sessionLifecycleBridge } from "../src/api/session-lifecycle-bridge";
import { issueWorkGrant, registerWork } from "../src/dispatch/work";
import { createTask, updateTask } from "../src/tasks/store";
import { fakeCtx, tmpDir } from "./helpers";

test("the bridge runs only the session lifecycle operations Rust admits", async () => {
  const ctx = fakeCtx();
  for (const request of [null, [], "x", {}, { op: 1 }, { op: "task.get", params: {} }, { op: "config.set", params: {} }, { op: "session.context", params: {} }])
    await expect(sessionLifecycleBridge(ctx, request)).rejects.toMatchObject({ code: "invalid_input" });
  await expect(sessionLifecycleBridge(ctx, { op: "session.agent.list", params: {} })).resolves.toEqual([]);
});

test("a draft Rust could not write falls back to Core", async () => {
  const draft = await sessionLifecycleBridge(fakeCtx(), { op: "session.draft.create", params: {} }) as { id: string };
  expect(draft.id).toMatch(/^[0-9a-f-]{36}$/);
});

test("the bridge applies Core's schema and work-grant authorization again", async () => {
  const ctx = fakeCtx();
  await expect(sessionLifecycleBridge(ctx, { op: "session.agent.list", params: { x: 1 } })).rejects.toMatchObject({ code: "invalid_input" });
  const root = createTask(ctx, { brief: { goal: "root", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  registerWork(ctx, root.id, { allowDelegation: true });
  updateTask(ctx, root.id, t => { t.state = "running"; });
  const granted = { ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", PACER_WORK_GRANT: issueWorkGrant(ctx, root.id, 1) } };
  await expect(sessionLifecycleBridge(granted, { op: "session.agent.list", params: {} })).rejects.toMatchObject({ code: "not_allowed", message: "Operation is not allowed by this work grant" });
  const enforced = { ...ctx, env: { ...ctx.env, PACER_ENFORCEMENT_TOKEN: "pet_x" } };
  await expect(sessionLifecycleBridge(enforced, { op: "session.agent.list", params: {} })).rejects.toMatchObject({ code: "not_allowed" });
});

test("client headers are validated as the public HTTP route validates them", () => {
  expect(clientIdentity("pacer-app/1.2.3", "window-1")).toEqual({ client: "pacer-app/1.2.3", clientInstance: { label: "pacer-app/1.2.3", id: "window-1" } });
  expect(clientIdentity("app", "w")).toEqual({ client: undefined, clientInstance: { label: "app", id: "w" } });
  expect(clientIdentity("BAD LABEL", "w")).toEqual({ client: undefined, clientInstance: { label: "http", id: "w" } });
  expect(clientIdentity("", "bad id!")).toEqual({ client: undefined, clientInstance: undefined });
});
