import type { Ctx } from "../../types";
import { type CheckResult, type OrcaClient, parsePayload } from "./client";
import { hasInbox, putInbox, takeInbox } from "./state";

export const NO_ANSWER =
  "pacer cannot answer questions while a task runs. Decide within the task's stated scope and continue. " +
  "If you cannot finish without an answer, send worker_done with --outcome failed and say what you need.";
export const SETTLED_STATES = ["succeeded", "failed", "stopped"];
const SUCCEEDED_GRACE_PASSES = 2;

export interface WaitOpts {
  coordinator: string;
  run: string;
  dispatchId: string;
  terminal: string | null;
  deadlineMs: number;
  isStopped: () => boolean;
  sliceMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export type WaitResult =
  | { kind: "done"; outcome: string; subject: string; body: string; filesModified: string[] }
  | { kind: "settled"; state: string; error: string | null }
  | { kind: "timeout" }
  | { kind: "stopped" };

/** Cursor and others can leave a long pasted prompt sitting unsubmitted (e.g. after refusing a model). */
export function needsSubmit(preview: string): boolean {
  return preview.includes("Pasted text") && !preview.includes("ctrl+c to stop");
}

async function processBatch(
  ctx: Ctx, c: OrcaClient, o: WaitOpts, batch: CheckResult, replied: Set<string>, log: (l: string) => void,
): Promise<void> {
  for (const m of batch.messages ?? []) {
    const p = parsePayload(m);
    if (m.type === "worker_done" && typeof p?.dispatchId === "string") {
      putInbox(ctx, p.dispatchId, {
        outcome: typeof p.outcome === "string" ? p.outcome : "unknown",
        subject: m.subject ?? "",
        body: m.body ?? "",
        filesModified: Array.isArray(p.filesModified) ? p.filesModified.map(String) : [],
        messageId: m.id,
      });
    } else if ((m.type === "question" || m.type === "escalation") && !replied.has(m.id)) {
      replied.add(m.id);
      const r = await c.reply({ id: m.id, body: NO_ANSWER, run: o.run, from: o.coordinator });
      log(`answered ${m.type} ${m.id}: ${r.ok ? "ok" : r.error.code}`);
    }
  }
}

/** Wait until this dispatch reports worker_done, settles, times out, or its task is stopped. */
export async function waitForWorker(ctx: Ctx, c: OrcaClient, o: WaitOpts): Promise<WaitResult> {
  const now = o.now ?? (() => Date.now());
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
  const log = o.log ?? (() => {});
  const slice = o.sliceMs ?? 30_000;
  const replied = new Set<string>();
  let pendingAck: string | null = null;
  let nudged = false;
  let succeededPasses = 0;
  try {
    for (;;) {
      const mail = takeInbox(ctx, o.dispatchId);
      if (mail) {
        return { kind: "done", outcome: mail.outcome, subject: mail.subject, body: mail.body, filesModified: mail.filesModified };
      }
      if (o.isStopped()) return { kind: "stopped" };
      const left = o.deadlineMs - now();
      if (left <= 0) return { kind: "timeout" };

      if (!nudged && o.terminal) {
        const t = await c.terminalShow(o.terminal);
        if (t.ok && needsSubmit(t.result.terminal?.preview ?? "")) {
          nudged = true;
          const sent = await c.terminalEnter(o.terminal);
          log(`the prompt was pasted but not submitted; pressed Enter in ${o.terminal} (${sent.ok ? "ok" : sent.error.code})`);
        }
      }

      const r = await c.check({ terminal: o.coordinator, run: o.run, waitMs: Math.min(slice, left), ack: pendingAck });
      pendingAck = null;
      if (r.ok) {
        await processBatch(ctx, c, o, r.result, replied, log);
        pendingAck = r.result.deliveryId ?? null;
      } else {
        log(`orca check failed: ${r.error.code} ${r.error.message}`);
        await sleep(Math.min(5_000, Math.max(0, left)));
      }
      if (hasInbox(ctx, o.dispatchId)) continue;

      const w = await c.workerShow(o.dispatchId);
      const state = w.ok ? (w.result.worker?.state ?? "") : "";
      if (SETTLED_STATES.includes(state)) {
        if (state !== "succeeded" || ++succeededPasses > SUCCEEDED_GRACE_PASSES) {
          return { kind: "settled", state, error: w.ok ? (w.result.worker?.lastError ?? null) : null };
        }
      }
    }
  } finally {
    if (pendingAck) {
      const r = await c.check({ terminal: o.coordinator, run: o.run, waitMs: null, ack: pendingAck });
      if (r.ok) await processBatch(ctx, c, o, r.result, replied, log);
    }
  }
}
