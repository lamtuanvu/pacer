// test/messaging-participants.test.ts
import { expect, test } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import { createTask, updateTask } from "../src/tasks/store";
import { registerWork, issueWorkGrant } from "../src/dispatch/work";
import { callerParticipant, isTop, parentOf, relation, rootOf } from "../src/messaging/participants";

const input = (repo: string) => ({ brief: { goal: "g", repo }, kind: "feature", requestedExecutor: null, timeoutS: 600 });

function tree() {
  const ctx = fakeCtx(), repo = tmpDir();
  const top = createTask(ctx, input(repo)); updateTask(ctx, top.id, t => { t.origin = "external:claude-code"; t.state = "running"; });
  registerWork(ctx, top.id, { allowDelegation: true });
  const a = createTask(ctx, input(repo)); registerWork(ctx, a.id, {}, top.id);
  const b = createTask(ctx, input(repo)); registerWork(ctx, b.id, {}, top.id);
  const user = createTask(ctx, input(repo)); updateTask(ctx, user.id, t => { t.origin = "human"; });
  return { ctx, top, a, b, user };
}

test("parent, root and top follow work nodes, then origin", () => {
  const { ctx, top, a, user } = tree();
  expect(parentOf(ctx, `task:${a.id}`)).toBe(`task:${top.id}`);
  expect(parentOf(ctx, `task:${top.id}`)).toBe("external:claude-code");
  expect(rootOf(ctx, `task:${a.id}`)).toBe(`task:${top.id}`);
  expect(isTop(ctx, "external:claude-code")).toBe(true);
  expect(isTop(ctx, `task:${user.id}`)).toBe(true);
  expect(isTop(ctx, `task:${top.id}`)).toBe(false);
});

test("relations", () => {
  const { ctx, top, a, b, user } = tree();
  expect(relation(ctx, `task:${a.id}`, `task:${top.id}`)).toBe("parent");
  expect(relation(ctx, `task:${top.id}`, `task:${a.id}`)).toBe("child");
  expect(relation(ctx, `task:${a.id}`, `task:${b.id}`)).toBe("sibling");
  expect(relation(ctx, "external:claude-code", `task:${a.id}`)).toBe("descendant");
  expect(relation(ctx, `task:${a.id}`, "external:claude-code")).toBe("ancestor");
  expect(relation(ctx, "external:claude-code", `task:${user.id}`)).toBe("top_peer");
  expect(relation(ctx, `task:${a.id}`, `task:${user.id}`)).toBe("none");
});

test("caller identity comes from grant, role env, app auth, planner env, else human", () => {
  const { ctx, top } = tree();
  const token = issueWorkGrant(ctx, top.id, 1);
  expect(callerParticipant({ ...ctx, env: { PACER_WORK_GRANT: token, PACER_ROLE: "executor" } }).id).toBe(`task:${top.id}`);
  expect(callerParticipant({ ...ctx, env: { PACER_ROLE: "executor", PACER_TASK_ID: top.id } })).toEqual({ id: `task:${top.id}`, grant: null });
  expect(callerParticipant({ ...ctx, env: { CLAUDECODE: "1" } }, { appAuthenticated: true }).id).toBe("human");
  expect(callerParticipant({ ...ctx, env: { PACER_PLANNER_SESSION: "abc-1" } }).id).toBe("external:abc-1");
  expect(callerParticipant({ ...ctx, env: { CLAUDECODE: "1" } }).id).toBe("external:claude-code");
  expect(callerParticipant({ ...ctx, env: {} }).id).toBe("human");
});
