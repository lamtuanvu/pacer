import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { liveSnapshot, liveV2Snapshot, eventsSince } from "../src/api/events";
import { handleV2 } from "../src/api/http";
import { publish } from "../src/link/publish";
import { appendOutbox } from "../src/link/store";
import { latestPath } from "../src/link/paths";
import { createTask, updateTask } from "../src/tasks/store";
import { insertMessage } from "../src/messaging/store";
import { updateState } from "../src/discovery/state";
import { fakeCtx } from "./helpers";
import { writeJsonAtomic } from "../src/fsutil";
import { taskData } from "../src/link/pump";

// Golden files are the serialized TS wire contract. Replace only process, platform,
// temporary-home and random identifiers; preserve every other field and ordering.
const golden = join(import.meta.dir, "fixtures", "read-model", "ts-golden.json");
const normalize = (value: unknown, home: string, ids: string[]): unknown => {
  let json = JSON.stringify(value);
  json = json.replaceAll(home, "$HOME");
  json = json.replaceAll(home.split("/").at(-1)!, "FIXTURE_HOME");
  json = json.replace(/local:[0-9a-f]{12}/g, "local:FIXTURE");
  ids.forEach((id, i) => { json = json.replaceAll(id, `TASK_${i + 1}`); });
  json = json.replace(/m-\d{14}-[0-9a-f]{8}/g, "MESSAGE_ID");
  const parsed = JSON.parse(json) as { snapshot?: { service?: Record<string, unknown>; machine?: Record<string, unknown> } };
  const snapshots = Array.isArray(parsed) ? parsed : [parsed];
  for (const row of snapshots) {
    const s = row?.snapshot;
    if (s?.service) { s.service.pid = 0; s.service.startedAt = 0; }
    if (s?.machine) { s.machine.os = "PLATFORM"; s.machine.arch = "ARCH"; }
  }
  return parsed;
};

const status = async (ctx: ReturnType<typeof fakeCtx>) => ({ generatedAt: ctx.now, strategy: "default", planner: "codex", mode: "normal", disabled: false, calendarPace: false, providers: [], executors: { ranked: [], excluded: [] } }) as never;

test("TS full read-model and event/cursor golden over isolated fixture homes", async () => {
  const ctx = fakeCtx({ which: () => null, readOnly: true });
  const ids: string[] = [];
  const empty = normalize(await liveSnapshot(ctx, { status }), ctx.home, ids);

  // Old-release transport state is an input to the current v2 adapter. The richer
  // task and message state comes from SQLite, not from this legacy JSON file.
  mkdirSync(join(ctx.pacerHome, "link"), { recursive: true });
  writeJsonAtomic(latestPath(ctx), { v: 1, seq: 7, at: ctx.now - 20,
    mode: { mode: "paused", previous: "normal", strategy: "old-release", at: ctx.now - 20 },
    budget: null, tasks: [], alerts: [{ key: "legacy", level: "warn", title: "Old release", body: "upgrade", at: ctx.now - 20 }], console: null });
  const task = createTask(ctx, { brief: { goal: "Review the read model. Then reply", repo: ctx.home }, kind: "feature", requestedExecutor: null, timeoutS: 60 });
  ids.push(task.id);
  updateTask(ctx, task.id, row => { row.queue = { reason: "paused", since: ctx.now, position: 1 }; });
  insertMessage(ctx, { taskId: task.id, rootId: `task:${task.id}`, from: `task:${task.id}`, to: "human", kind: "question", body: "Which path?", replyTo: null, requestId: null });
  await updateState({ ...ctx, readOnly: false }, state => { state.seen["AAAAAAAAAAAAAAAAAAAAAAAAAA"] = { discoveryId: "AAAAAAAAAAAAAAAAAAAAAAAAAA", name: "studio", version: "1.2", hints: "", network: "test", firstSeen: ctx.now, lastSeen: ctx.now, promptedAt: ctx.now }; });
  const rich = normalize(await liveSnapshot(ctx, { status }), ctx.home, ids);
  const v2 = normalize(await liveV2Snapshot(ctx, { status }), ctx.home, ids);
  await publish({ ...ctx, readOnly: false }, [
    { type: "budget", data: { generatedAt: ctx.now, strategy: "old-release", planner: "codex", mode: "normal", providers: [], ranked: [] } },
    { type: "task", data: taskData(task) },
    { type: "config", data: { area: "strategy", at: ctx.now } },
    { type: "discovery.found", data: { discoveryId: "AAAAAAAAAAAAAAAAAAAAAAAAAA", name: "studio", version: "1.2" } },
    { type: "entity", data: { kind: "attention", id: "discovery:AAAAAAAAAAAAAAAAAAAAAAAAAA", value: { id: "discovery:AAAAAAAAAAAAAAAAAAAAAAAAAA", kind: "discovery" } } },
    { type: "entity", data: { kind: "counts", id: "counts", value: { attention: 2, running: 0 } } },
    { type: "alert", data: { key: "upgrade", level: "info", title: "Upgrade", body: "", at: ctx.now } },
    { type: "entity", data: { kind: "executor", id: "gone", removed: true } },
  ]);
  const replayLast = eventsSince(ctx, 0, 3).last;
  const eventCases = [
    eventsSince(ctx, 0, 3), eventsSince(ctx, 0, 2),
    eventsSince(ctx, 1, 3), // a pre-v3 cursor forces protocol reset
    eventsSince(ctx, 7, 2), // retained outbox begins after the old-release seq
    eventsSince(ctx, 9_007_199_254_740_992, 3), // current cursor with no newer event
  ].map(row => normalize(row, ctx.home, ids));
  const gapCtx = fakeCtx({ which: () => null });
  appendOutbox(gapCtx, [{ seq: 50, at: gapCtx.now, envelope: { type: "entity", data: { kind: "executor", id: "old", removed: true } } }]);
  const gap = normalize(eventsSince(gapCtx, 3_000_000_000_010, 3), gapCtx.home, ids);
  const stream = await handleV2(new Request("http://127.0.0.1/v3/events?since=0"), { getCtx: () => ctx, tailMs: 1000 });
  const reader = stream.body!.getReader();
  let initialFrames = "";
  while (!initialFrames.includes(`id: ${replayLast}\n`)) initialFrames += new TextDecoder().decode((await reader.read()).value);
  await publish({ ...ctx, readOnly: false }, [{ type: "entity", data: { kind: "executor", id: "new", value: { id: "new" } } }]);
  const wakeFrame = new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  const sse = normalize({ contentType: stream.headers.get("content-type"), cacheControl: stream.headers.get("cache-control"), initialFrames, wakeFrame }, ctx.home, ids);
  const http = await handleV2(new Request("http://127.0.0.1/v3/events?since=-1"), { getCtx: () => ctx });
  const invalidCursor = { status: http.status, body: await http.json() };
  const observed = { empty, rich, v2, eventCases, gap, sse, invalidCursor };
  if (process.env.UPDATE_READ_MODEL_GOLDEN === "1") {
    mkdirSync(join(import.meta.dir, "fixtures", "read-model"), { recursive: true });
    writeFileSync(golden, JSON.stringify(observed, null, 2) + "\n");
  }
  expect(observed).toEqual(JSON.parse(readFileSync(golden, "utf8")));
});
