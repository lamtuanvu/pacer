/** Pan and zoom math, the keyboard map, and the message channels' targets. */
import { expect, test } from "bun:test";
import {
  MAX_ZOOM, MIN_ZOOM, PAN_STEP, PAN_STEP_LARGE, ZOOM_STEP, clampZoom, fitView, keyAction, panBy, zoomAt,
} from "../app/src/screens/runs/live-board-view";
import { messageTargets, sendToTargets } from "../app/src/screens/runs/live-board-messages";

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

test("sendToTargets sends to each in order and reports the ones that failed without stopping", async () => {
  const seen: string[] = [];
  const out = await sendToTargets(async (to, body) => { seen.push(`${to}:${body}`); if (to === "task:t_a") throw new Error("not allowed"); }, ["task:t_orch", "task:t_a", "task:t_b"], "hi");
  expect(seen).toEqual(["task:t_orch:hi", "task:t_a:hi", "task:t_b:hi"]);
  expect(out).toEqual({ sent: ["task:t_orch", "task:t_b"], failed: [{ to: "task:t_a", message: "not allowed" }] });
});
