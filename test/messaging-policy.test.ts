// test/messaging-policy.test.ts
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { fakeCtx, tmpDir } from "./helpers";
import { createTask, updateTask } from "../src/tasks/store";
import { registerWork } from "../src/dispatch/work";
import { checkSend, effectivePolicy } from "../src/messaging/policy";
import { CoreError } from "../src/core/errors";

function setup(yaml = "") {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), `planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n${yaml}`);
  const repo = tmpDir();
  const mk = () => createTask(ctx, { brief: { goal: "g", repo }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  const top = mk(); updateTask(ctx, top.id, t => { t.origin = "external:claude-code"; t.state = "running"; }); registerWork(ctx, top.id, { allowDelegation: true });
  const a = mk(); registerWork(ctx, a.id, {}, top.id);
  const b = mk(); registerWork(ctx, b.id, {}, top.id);
  const user = mk(); updateTask(ctx, user.id, t => { t.origin = "human"; });
  return { ctx, top: `task:${top.id}`, a: `task:${a.id}`, b: `task:${b.id}`, user: `task:${user.id}`, topId: top.id };
}
const send = (from: string, to: string, hasGrant = false) => ({ from, to, kind: "message" as const, bytes: 10, hasGrant });
const reason = (f: () => unknown) => { try { f(); return "allowed"; } catch (e) { return (e as CoreError).data?.reason; } };

test("default guardrail", () => {
  const { ctx, top, a, b, user } = setup();
  expect(reason(() => checkSend(ctx, send("external:claude-code", top)))).toBe("allowed");      // top -> child
  expect(reason(() => checkSend(ctx, send(a, top)))).toBe("allowed");                          // child -> parent
  expect(reason(() => checkSend(ctx, send(a, b)))).toBe("msg_forbidden");                      // sibling without grant
  expect(reason(() => checkSend(ctx, send(a, b, true)))).toBe("allowed");                      // sibling with grant
  expect(reason(() => checkSend(ctx, send("external:claude-code", user)))).toBe("allowed");    // top peer
  expect(reason(() => checkSend(ctx, send(a, user)))).toBe("msg_forbidden");                   // unrelated
  expect(reason(() => checkSend(ctx, send(a, "human")))).toBe("allowed");
  expect(reason(() => checkSend(ctx, send("human", a)))).toBe("allowed");
  expect(reason(() => checkSend(ctx, { ...send("human", a), bytes: 70000 }))).toBe("msg_too_large");
});

test("global rules come before defaults; defaults can be dropped", () => {
  const deny = setup("messaging:\n  rules:\n    - {effect: deny, relation: [top_peer]}\n");
  expect(reason(() => checkSend(deny.ctx, send("external:claude-code", deny.user)))).toBe("msg_forbidden");
  const widen = setup("messaging:\n  rules:\n    - {effect: allow, relation: any}\n");
  expect(reason(() => checkSend(widen.ctx, send(widen.a, widen.user)))).toBe("allowed");
  const none = setup("messaging:\n  defaults: false\n");
  expect(reason(() => checkSend(none.ctx, send(none.a, none.top)))).toBe("msg_forbidden");
});

test("tree override sits above global rules, and confirm holds", () => {
  const s = setup();
  updateTask(s.ctx, s.topId, t => { t.messaging = { rules: [{ effect: "allow", from_position: "child", relation: ["parent"], limits: { confirm: true } }] }; });
  const r = checkSend(s.ctx, send(s.a, s.top));
  expect(r.hold).toBe(true);
  expect(r.layer).toBe("tree");
  expect(effectivePolicy(s.ctx, { root: s.top }).rules[0]!.layer).toBe("tree");
});

test("a refusal with no matching rule says so, names the closest grant rule and gives the check command", () => {
  const { ctx, a, b, user } = setup();
  const err = (f: () => unknown) => { try { f(); } catch (e) { return e as CoreError; } throw new Error("allowed"); };
  const sibling = err(() => checkSend(ctx, send(a, b)));
  expect(sibling.data).toMatchObject({ reason: "msg_forbidden", layer: "none", relation: "sibling", closest: { rule: 4, layer: "default", grant: "required" } });
  expect(sibling.message).toContain("no rule matched");
  expect(sibling.message).toContain("rule 4 (default) allows it with a work grant");
  expect(sibling.hint).toBe(`Run \`pacer msg policy --check --from ${a} --to ${b} --kind message\` to see which rule decides.`);
  const unrelated = err(() => checkSend(ctx, send(a, user)));
  expect(unrelated.message).toContain("no rule matched");
  expect(unrelated.message).not.toContain("work grant");
  expect(unrelated.data?.closest).toBeUndefined();
});
