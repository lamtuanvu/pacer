import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { conversationActivity } from "../session/conversation";
import { withLock } from "../core/lock";
import { FrameType, WireDecoder, wire } from "../session/framing";
import { sessionSocket } from "../session/service";
import { transcriptReport } from "../session/reports";
import { readRun, type RunState } from "../supervisor/run";
import type { SpawnRunner } from "../tasks/api";
import { readTask, updateTask } from "../tasks/store";
import type { RunRef, TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
import { rootOf } from "./participants";
import { effectivePolicy } from "./policy";
import * as store from "./store";
import type { Message } from "./types";
import { agentReport, beginTurn, isClosed, notifyMessage, renderTurnPrompt, report, reportReader } from "./turns";

const PASTE_START = "\x1b[200~", PASTE_END = "\x1b[201~";
/** Larger bodies go to a run-dir file and only a short prompt is typed, as a conversation's first request does. */
const INLINE_BYTES = 32 * 1024;

export interface LiveDeps { submitDelayMs?: number; timeoutMs?: number; readState?: (dir: string) => RunState }

const statusMtime = (dir: string): number => { try { return statSync(join(dir, "session-status.json")).mtimeMs / 1000; } catch { return 0; } };

/** Between turns: a delegated agent ended its turn; a conversation is also ready while it waits for input. */
function betweenTurns(t: TaskRecord, s: RunState): boolean {
  if (t.interactionMode === "conversation") return ["idle", "waiting"].includes(conversationActivity(s));
  return s.report?.status === "turn-ended";
}

/**
 * One poll of a live interactive run (a conversation or an interactive delegated task): finish an in-flight live turn
 * when the agent ends it, otherwise type pending messages into the session while the agent is idle and nobody holds
 * control. Messages are never dropped: a failed delivery puts them back to pending.
 */
export async function liveTick(ctx: Ctx, task: TaskRecord, run: RunRef, s: RunState, deps: LiveDeps = {}): Promise<void> {
  try { await withLock(ctx, `msg-live-${task.id}`, () => liveTickLocked(ctx, task, run, s, deps), { timeoutMs: 0, staleMs: 10 * 60_000 }); }
  catch (e) { if (!(e instanceof Error && e.message.includes("timed out waiting for"))) throw e; }
}

/** Fresh run activity and control: the agent is still between turns and nobody but `pacer` holds the terminal. */
function stillBetweenTurns(ctx: Ctx, id: string, run: RunRef, deps: LiveDeps): boolean {
  const t = readTask(ctx, id), s = deps.readState?.(run.dir) ?? readRun(run.dir);
  return !!t && t.run?.dir === run.dir && !t.liveTurn && !t.run.takeover && t.takeover?.state !== "driving" &&
    s.alive && !!s.interactive && (!s.controller || s.controller === "pacer") && betweenTurns(t, s);
}

/** One claim at a time per task, so two ticks never type the same turn. */
async function liveTickLocked(ctx: Ctx, task: TaskRecord, run: RunRef, s: RunState, deps: LiveDeps): Promise<void> {
  if (run.takeover || run.host || !s.interactive || !s.alive) return;
  const t = readTask(ctx, task.id);
  if (!t || t.run?.dir !== run.dir || t.takeover?.state === "driving") return;
  const now = { ...ctx, now: Date.now() / 1000 };
  if (t.liveTurn) {
    if (s.report?.status === "turn-ended" && statusMtime(run.dir) > t.liveTurn.statusAt) finishLiveTurn(now, t);
    return;
  }
  const to = `task:${t.id}`;
  if (isClosed(t) || !store.pendingFor(ctx, to).length) return setBlocked(ctx, t, false);
  if (!betweenTurns(t, s)) return;
  if (s.controller) return setBlocked(ctx, t, true);
  // Admission is fresh at the point the live driver claims the next turn, including broker nudges.
  if ((await beginTurn(ctx, t.id, undefined, { quiet: true })).delivery !== "live") return;
  // Admission may have awaited a plugin while the agent started another turn or a viewer took over.
  if (!stillBetweenTurns(ctx, t.id, run, deps)) return;
  const root = rootOf(ctx, to);
  if (store.turnsForRoot(ctx, root) >= effectivePolicy(ctx, { root }).config.tree.max_turns) return;
  const turnId = `${t.id}#live.${store.turnsForTask(ctx, t.id) + 1}`;
  const messages = store.claimPending(now, to, turnId);
  if (!messages.length) return;
  for (const m of messages) notifyMessage(ctx, m);
  const statusAt = statusMtime(run.dir);
  try {
    let body = renderTurnPrompt(ctx, t, messages, { live: true });
    if (Buffer.byteLength(body) > INLINE_BYTES) {
      mkdirSync(run.dir, { recursive: true, mode: 0o700 });
      const path = join(run.dir, `messages-${turnId.replace(/[^A-Za-z0-9.-]/g, "_")}.md`);
      writeFileSync(path, body, { mode: 0o600 });
      body = `Read the new messages in ${JSON.stringify(path)} and respond to them.`;
    }
    const typed = await typeIntoSession(sessionSocket(run.dir), body, deps, () => stillBetweenTurns(ctx, t.id, run, deps));
    if (typed === "busy") return release(ctx, turnId, messages);
    if (typed === "refused") {
      release(ctx, turnId, messages);
      return setBlocked(ctx, t, true);
    }
  } catch (e) {
    release(ctx, turnId, messages);
    updateTask(ctx, t.id, x => { x.liveError = { at: now.now, message: (e as Error).message || String(e) }; delete x.liveBlocked; });
    return;
  }
  store.recordTurn(ctx, { id: turnId, taskId: t.id, rootId: root, at: now.now });
  updateTask(ctx, t.id, x => { x.liveTurn = { id: turnId, at: now.now, statusAt }; delete x.liveBlocked; delete x.liveError; });
}

function release(ctx: Ctx, turnId: string, messages: Message[]): void {
  store.releaseTurn(ctx, turnId);
  for (const m of messages) { const back = store.getMessage(ctx, m.id); if (back) notifyMessage(ctx, back); }
}

function setBlocked(ctx: Ctx, t: TaskRecord, blocked: boolean): void {
  if (blocked === (t.liveBlocked === "viewer")) return;
  updateTask(ctx, t.id, x => { if (blocked) x.liveBlocked = "viewer"; else delete x.liveBlocked; });
}

/**
 * The live turn ended (or its run did): report the agent's last reply to the parent and to the other senders, as a
 * run-end report does, then end the turn. A report the agent already sent to the parent replaces the parent's copy.
 */
export function finishLiveTurn(ctx: Ctx, t: TaskRecord, spawn?: SpawnRunner): void {
  const live = t.liveTurn;
  if (!live || !t.run) return;
  const id = t.id, parent = reportReader(ctx, t);
  const body = transcriptReport(t.run.dir) || "The agent ended its turn without a reply.";
  const reported = store.sentSince(ctx, `task:${id}`, live.at).some(m => m.to === parent && agentReport(m));
  if (parent && !reported) report(ctx, id, parent, "", body, `report:${live.id}`, spawn);
  const others = new Set(store.claimedMessages(ctx, live.id).filter(m => m.from !== parent && m.from !== `task:${id}` && m.kind !== "report").map(m => m.from));
  for (const to of others) report(ctx, id, to, "", body, `report:${live.id}:${to}`, spawn);
  store.endTurn(ctx, live.id, "turn-ended", ctx.now);
  updateTask(ctx, id, x => { if (x.liveTurn?.id === live.id) delete x.liveTurn; });
}

/**
 * Take control as viewer `pacer`, paste the body, submit it, and hand control back. "refused": a viewer took control first;
 * "busy": with control held, the agent was no longer between turns, so nothing was typed.
 */
async function typeIntoSession(path: string, body: string, deps: LiveDeps, stillIdle: () => boolean): Promise<"typed" | "refused" | "busy"> {
  const timeoutMs = deps.timeoutMs ?? 3000;
  const socket: Socket = createConnection(path);
  const decoder = new WireDecoder();
  const controls: Array<{ controller?: string | null; you?: boolean; reason?: string }> = [];
  let waiter: (() => void) | undefined, failure: Error | undefined;
  socket.on("data", data => {
    try { for (const f of decoder.push(Buffer.from(data))) if (f.type === FrameType.control) controls.push(JSON.parse(f.data.toString())); }
    catch (e) { failure = e as Error; }
    waiter?.();
  });
  socket.on("error", e => { failure = e; waiter?.(); });
  socket.on("close", () => { failure ??= Error("the session closed the connection"); waiter?.(); });
  const next = async (): Promise<{ controller?: string | null; you?: boolean; reason?: string }> => {
    const until = Date.now() + timeoutMs;
    while (!controls.length) {
      if (failure) throw failure;
      if (Date.now() >= until) throw Error("the session did not answer in time");
      await new Promise<void>(r => { waiter = r; setTimeout(r, Math.max(1, until - Date.now())); });
      waiter = undefined;
    }
    return controls.shift()!;
  };
  const send = (bytes: Buffer) => new Promise<void>((resolve, reject) => socket.write(bytes, e => e ? reject(e) : resolve()));
  try {
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    await send(wire(FrameType.hello, { v: 1, client: "cli", label: "pacer" }));
    await next();
    await send(wire(FrameType.take, {}));
    let control = await next();
    while (!control.you && control.reason !== "refused" && !control.controller) control = await next();
    if (!control.you) return "refused";
    if (!stillIdle()) { await send(wire(FrameType.release, {})); return "busy"; }
    await send(wire(FrameType.input, Buffer.from(`${PASTE_START}${body}${PASTE_END}`)));
    // Give the agent's input box a moment to take the paste before it is submitted.
    if (deps.submitDelayMs ?? 150) await Bun.sleep(deps.submitDelayMs ?? 150);
    await send(wire(FrameType.input, Buffer.from("\r")));
    await send(wire(FrameType.release, {}));
    // The host applies frames in order: once control is back, the input reached the PTY.
    while ((await next()).you);
    return "typed";
  } finally {
    socket.end();
  }
}
