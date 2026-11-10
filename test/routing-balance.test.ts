import { expect, test } from "bun:test";
import { route } from "../src/core/routing";
import { createTask, readTask, updateTask, listTasksWhere } from "../src/tasks/store";
import { fakeCtx, withLoginIndicators } from "./helpers";
import { pairStrategy } from "./fixtures/balance-pair";

// Login indicator files keep the CLI accounts signed in; without a budget observation both
// stay in the uncertain fallback band, which balance still sorts by load.
const setup = (balance: "off" | "least-loaded") => ({ ctx: withLoginIndicators(fakeCtx()), s: pairStrategy(balance) });

const runningOn = (ctx: ReturnType<typeof fakeCtx>, executor: string) => {
  const task = createTask(ctx, { brief: { goal: `running ${executor}`, repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, task.id, t => { t.state = "running"; t.executor = executor; });
  return task;
};

test("balance on: the route preview spreads across equally acceptable executors by load", async () => {
  const { ctx, s } = setup("least-loaded");
  expect(s.pacing.balance).toBe("least-loaded");
  runningOn(ctx, "codex");
  const running = listTasksWhere(ctx, { states: ["running"] });
  expect(readTask(ctx, running[0].id)?.executor).toBe("codex");
  const r = await route(ctx, null, s, {});
  expect(r.ranked[0].id).toBe("opencode#tse");
  // The fuller executor stays ranked, after its band, and is not excluded.
  expect(r.ranked.map(e => e.id)).toContain("codex");
  expect(r.excluded.map(e => e.id)).not.toContain("codex");
});

test("balance off: the route preview keeps today's order", async () => {
  const { ctx, s } = setup("off");
  runningOn(ctx, "codex");
  const r = await route(ctx, null, s, {});
  expect(r.ranked[0].id).toBe("codex");
});

test("balance on: a full executor never jumps ahead of an emptier one", async () => {
  const { ctx, s } = setup("least-loaded");
  // Fill the codex band to the brim: utilization 1+ sorts after its band in the preview.
  for (let i = 0; i < 3; i++) runningOn(ctx, "codex");
  const running = listTasksWhere(ctx, { states: ["running"] });
  expect(running).toHaveLength(3);
  const r = await route(ctx, null, s, {});
  expect(r.ranked[0].id).toBe("opencode#tse");
});
