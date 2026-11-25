/** Pan and zoom math, the keyboard map, and the message channels' targets. */
import { expect, test } from "bun:test";
import {
  MAX_ZOOM, MIN_ZOOM, PAN_STEP, PAN_STEP_LARGE, ZOOM_STEP, clampZoom, fitView, keyAction, panBy, zoomAt,
} from "../app/src/screens/runs/live-board-view";
import { messageTargets, sendToTargets, summarizeSend } from "../app/src/screens/runs/live-board-messages";

test("panBy moves the view by exactly the drag distance", () => {
  expect(panBy({ x: 10, y: 20, k: 1.5 }, 7, -3)).toEqual({ x: 17, y: 17, k: 1.5 });
});

test("zoomAt keeps the point under the pointer fixed", () => {
  const v = { x: 30, y: 40, k: 1 };
  const z = zoomAt(v, 2, 200, 100);
  expect(z.k).toBe(2);
  // the board point under (200,100) before: ((200-30)/1, (100-40)/1); after zooming it must still sit at (200,100)
  const before = { x: (200 - v.x) / v.k, y: (100 - v.y) / v.k };
  expect(before.x * z.k + z.x).toBeCloseTo(200, 1);
  expect(before.y * z.k + z.y).toBeCloseTo(100, 1);
});

test("zoom is clamped and a clamped zoom leaves the view alone", () => {
  expect(clampZoom(99)).toBe(MAX_ZOOM);
  expect(clampZoom(0.01)).toBe(MIN_ZOOM);
  const atMax = { x: 5, y: 5, k: MAX_ZOOM };
  expect(zoomAt(atMax, 2, 10, 10)).toBe(atMax);
  let v = { x: 0, y: 0, k: 1 };
  for (let i = 0; i < 40; i++) v = zoomAt(v, 1 / ZOOM_STEP, 100, 100);
  expect(v.k).toBe(MIN_ZOOM);
});

test("fitView centres the whole board and never zooms in past 1", () => {
  const v = fitView({ width: 2000, height: 1000 }, { width: 1000, height: 500 }, 0);
  expect(v.k).toBe(0.5);
  expect(v.x).toBe(0);
  const small = fitView({ width: 100, height: 100 }, { width: 1000, height: 500 }, 0);
  expect(small).toEqual({ x: 450, y: 200, k: 1 });
  expect(fitView({ width: 0, height: 0 }, { width: 1000, height: 500 })).toEqual({ x: 0, y: 0, k: 1 });
});

test("keyboard map: arrows pan toward what they name, Shift pans further, + - zoom, 0 fits, browser chords pass", () => {
  expect(keyAction({ key: "ArrowRight" })).toEqual({ type: "pan", dx: -PAN_STEP, dy: 0 });
  expect(keyAction({ key: "ArrowLeft" })).toEqual({ type: "pan", dx: PAN_STEP, dy: 0 });
  expect(keyAction({ key: "ArrowDown" })).toEqual({ type: "pan", dx: 0, dy: -PAN_STEP });
  expect(keyAction({ key: "ArrowUp", shiftKey: true })).toEqual({ type: "pan", dx: 0, dy: PAN_STEP_LARGE });
  expect(keyAction({ key: "+" })).toEqual({ type: "zoom", factor: ZOOM_STEP });
  expect(keyAction({ key: "=" })).toEqual({ type: "zoom", factor: ZOOM_STEP });
  expect(keyAction({ key: "-" })).toEqual({ type: "zoom", factor: 1 / ZOOM_STEP });
  expect(keyAction({ key: "0" })).toEqual({ type: "fit" });
  expect(keyAction({ key: "ArrowLeft", metaKey: true })).toBeNull();
  expect(keyAction({ key: "=", ctrlKey: true })).toBeNull();
  expect(keyAction({ key: "Tab" })).toBeNull();
  expect(keyAction({ key: "a" })).toBeNull();
});

const ctx = { orchestratorTaskId: "t_orch", agentTaskIds: ["t_a", "t_b"], whisperTaskId: "t_b" };

test("message channels: party is the planner and every working agent, whisper is one agent, planner is the planner only", () => {
  expect(messageTargets("party", ctx)).toEqual({ ok: true, to: ["task:t_orch", "task:t_a", "task:t_b"] });
  expect(messageTargets("whisper", ctx)).toEqual({ ok: true, to: ["task:t_b"] });
  expect(messageTargets("planner", ctx)).toEqual({ ok: true, to: ["task:t_orch"] });
});

test("message channels refuse an impossible target instead of sending somewhere else", () => {
  expect(messageTargets("planner", { agentTaskIds: ["t_a"] })).toMatchObject({ ok: false });
  expect(messageTargets("whisper", { ...ctx, whisperTaskId: undefined })).toMatchObject({ ok: false, reason: "Pick the agent to whisper to." });
  expect(messageTargets("whisper", { ...ctx, whisperTaskId: "t_gone" })).toMatchObject({ ok: false, reason: "That agent is no longer working." });
  expect(messageTargets("party", { agentTaskIds: [] })).toMatchObject({ ok: false });
  // the planner is never listed twice when it is also an agent task
  expect(messageTargets("party", { orchestratorTaskId: "t_x", agentTaskIds: ["t_x", "t_y"] })).toEqual({ ok: true, to: ["task:t_x", "task:t_y"] });
});

test("sendToTargets sends to each in order, keeps each result's delivery and turns a failure into the shared refusal words without stopping", async () => {
  const seen: string[] = [];
  const out = await sendToTargets(async (to, body) => {
    seen.push(`${to}:${body}`);
    if (to === "task:t_a") throw Object.assign(new Error("raw service text"), { data: { reason: "msg_node_closed" } });
    return to === "task:t_b" ? { delivery: "held" } : { delivery: "queued" };
  }, ["task:t_orch", "task:t_a", "task:t_b"], "hi");
  expect(seen).toEqual(["task:t_orch:hi", "task:t_a:hi", "task:t_b:hi"]);
  expect(out.results).toEqual([
    { to: "task:t_orch", delivery: "queued" },
    { to: "task:t_a", refusal: "This task is closed for messages." },
    { to: "task:t_b", delivery: "held" },
  ]);
  const raw = await sendToTargets(async () => { throw new Error("socket hang up"); }, ["task:t_a"], "hi");
  expect(raw.results).toEqual([{ to: "task:t_a", refusal: "The message was not sent. Try again." }]);
});

test("summarizeSend says what became of the message, one recipient or several, in the shared words", () => {
  expect(summarizeSend([{ to: "a", delivery: "turn_started" }])).toEqual({ text: "Sent. The task is picking it up.", problem: false, stored: true });
  expect(summarizeSend([{ to: "a", delivery: "held" }])).toEqual({ text: "Sent. A messaging rule holds it until you confirm.", problem: true, stored: true });
  expect(summarizeSend([{ to: "a", delivery: "closed" }])).toMatchObject({ text: "Sent, but this task is closed for messages.", problem: true });
  expect(summarizeSend([{ to: "a", refusal: "Too many messages at once. Wait a minute and send again." }])).toEqual({ text: "Too many messages at once. Wait a minute and send again.", problem: true, stored: false });
  expect(summarizeSend([{ to: "a", delivery: "pending" }]).text).toBe("Message recorded; delivery is not confirmed yet.");
  const mixed = summarizeSend([{ to: "a", delivery: "queued" }, { to: "b", delivery: "held" }, { to: "c", delivery: "cap" }, { to: "d", refusal: "This task is closed for messages." }]);
  expect(mixed.text).toBe("Delivered to 1 of 4 recipients. 2 saved but not delivered: Sent. A messaging rule holds it until you confirm. Sent, but this task tree has reached its turn limit. 1 not sent: This task is closed for messages.");
  expect(mixed).toMatchObject({ problem: true, stored: true });
  expect(summarizeSend([{ to: "a", delivery: "queued" }, { to: "b", delivery: "live" }])).toEqual({ text: "Delivered to 2 of 2 recipients.", problem: false, stored: true });
  expect(summarizeSend([{ to: "a", refusal: "x" }, { to: "b", refusal: "x" }]).stored).toBe(false);
});

test("createLoadGuard: only the newest load counts, and nothing counts after unmount", async () => {
  const { createLoadGuard } = await import("../app/src/screens/runs/run-data");
  const g = createLoadGuard();
  const first = g.begin();
  expect(first()).toBe(true);
  const second = g.begin();
  expect(first()).toBe(false);
  expect(second()).toBe(true);
  g.unmount();
  expect(second()).toBe(false);
  g.mount();
  expect(second()).toBe(true);
});
