/** An agent's live output on the Live board: follows `task.log` (the `/v3/tasks/<id>/log` read) until the task is done. */
import { useEffect, useRef, useState } from "preact/hooks";
import type { BrowserApi } from "../../data/api";
import { Alert } from "../../ds/Alert";
import { Button, ButtonLink } from "../../ds/Button";
import { SectionHeading } from "../../ds/SectionHeading";
import { RUN_OUTPUT_ERROR } from "../../../../src/view-model/runs";

interface Chunk { stdout: string; stderr: string; next?: { stdout: number; stderr: number }; done: boolean; source?: string }
export const OUTPUT_POLL_MS = 2500;
export const KEEP_CHARS = 24_000;
/** `task.log` returns at most this much per stream in one read. */
const PAGE_BYTES = 256 * 1024;

type Phase = "loading" | "live" | "draining" | "done" | "error";
/** What has been read of one task's output. It outlives a retry, so a failed read never loses the text on screen. */
interface Read { taskId: string; offsets: { stdout: number; stderr: number }; source?: string; text: string; truncated: boolean }
const fresh = (taskId: string, source?: string): Read => ({ taskId, offsets: { stdout: 0, stderr: 0 }, source, text: "", truncated: false });

export function AgentOutput({ api, taskId, executor, stepLabel, sessionHref, onClose, pollMs = OUTPUT_POLL_MS, left, closeRef: outerClose }: {
  api: BrowserApi; taskId: string; executor: string; stepLabel: string; sessionHref: string; onClose: () => void; pollMs?: number; left?: boolean; closeRef?: { current: HTMLButtonElement | null };
}) {
  const [out, setOut] = useState<{ text: string; truncated: boolean; phase: Phase }>({ text: "", truncated: false, phase: "loading" });
  const [attempt, retry] = useState(0);
  const panel = useRef<HTMLElement>(null);
  const log = useRef<HTMLPreElement>(null);
  /** The log stays at its end until the person scrolls up. */
  const follow = useRef(true);
  const read = useRef<Read>(fresh(taskId));
  const ownClose = useRef<HTMLButtonElement | null>(null);
  const closeRef = outerClose ?? ownClose;
  /** The pressed retry button, until the read it started succeeds. */
  const retried = useRef<EventTarget | null>(null);
  // The panel opens below the board; bring it into view without moving focus off the agent that opened it.
  useEffect(() => { panel.current?.scrollIntoView?.({ block: "nearest" }); }, [taskId]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (read.current.taskId !== taskId) { read.current = fresh(taskId); retried.current = null; follow.current = true; }
    // A retry keeps the failure, its button and the text on screen until a read works, so focus is not dropped.
    if (!retried.current) setOut({ text: read.current.text, truncated: read.current.truncated, phase: "loading" });
    const step = async () => {
      const held = read.current;
      try {
        const chunk = await api.call<Chunk>("task.log", { id: taskId, ...held.offsets });
        if (!active) return;
        if (held.source !== undefined && chunk.source !== held.source) {
          // The output was rerouted: start again from the top rather than splice two sources.
          read.current = fresh(taskId, chunk.source);
          timer = setTimeout(step, 0);
          return;
        }
        const next = chunk.next ?? held.offsets;
        const advanced = next.stdout > held.offsets.stdout || next.stderr > held.offsets.stderr;
        const fullPage = next.stdout - held.offsets.stdout >= PAGE_BYTES || next.stderr - held.offsets.stderr >= PAGE_BYTES;
        const err = chunk.stderr ? chunk.stderr.split("\n").filter(Boolean).map(l => `stderr: ${l}`).join("\n") : "";
        const all = held.text + chunk.stdout + (err ? `${chunk.stdout && !chunk.stdout.endsWith("\n") ? "\n" : ""}${err}\n` : "");
        const now: Read = { taskId, offsets: next, source: chunk.source, text: all.slice(-KEEP_CHARS), truncated: held.truncated || all.length > KEEP_CHARS };
        read.current = now;
        // The retry button leaves with the failure: move focus on, unless the person moved elsewhere.
        const button = retried.current;
        retried.current = null;
        if (button && (document.activeElement === button || document.activeElement === document.body || !document.activeElement)) closeRef.current?.focus();
        // A finished task is only done once a read brings nothing new: pages may remain.
        const phase: Phase = !chunk.done ? "live" : advanced ? "draining" : "done";
        setOut({ text: now.text, truncated: now.truncated, phase });
        if (phase !== "done") timer = setTimeout(step, advanced && (chunk.done || fullPage) ? 0 : pollMs);
      } catch (e) {
        // The raw error stays in the console; the page shows plain words (UI-12).
        console.warn("runs: task output read failed", e);
        if (active) setOut({ text: held.text, truncated: held.truncated, phase: "error" });
      }
    };
    void step();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [api, taskId, pollMs, attempt]);
  useEffect(() => {
    const el = log.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [out.text]);
  const status = out.phase === "loading" ? "Reading output…"
    : out.phase === "live" ? "Following live output"
      : out.phase === "draining" ? "Task finished; reading the rest of its output"
        : out.phase === "done" ? out.truncated ? "Task finished; showing the end of its output" : "Task finished; this is its full output"
          : "";
  return (
    <section ref={panel} className="lb-section" aria-label={`Live output: ${executor} on ${stepLabel}`}>
      <div className="lb-row">
        <SectionHeading>Live output</SectionHeading>
        <span className="lb-cap">{executor} · {stepLabel}</span>
      </div>
      <p className="lb-cap" role="status" aria-live="polite">{status}</p>
      {left ? <p className="lb-cap" role="status">This agent is no longer working on this step. Its output stays here until you close it.</p> : null}
      {out.truncated ? <p className="lb-cap">Earlier output is not shown here. Open the session to read it all.</p> : null}
      {out.phase === "error" ? (
        <Alert tone="error" title="Couldn't read the output">
          <p>{RUN_OUTPUT_ERROR}</p>
          <Button size="sm" onClick={e => { retried.current = e.currentTarget; retry(n => n + 1); }}>Try again</Button>
        </Alert>
      ) : null}
      {out.text
        // The status line above announces changes; the log itself stays quiet, or every read would be spoken.
        ? <pre ref={log} className="lb-output" tabIndex={0} role="log" aria-live="off" aria-label={`Output of ${executor}`}
          onScroll={e => { const el = e.currentTarget; follow.current = el.scrollHeight - el.clientHeight - el.scrollTop < 32; }}>{out.text}</pre>
        : out.phase === "live" || out.phase === "done" ? <p className="lb-cap">No output yet.</p> : null}
      <div className="lb-row">
        <ButtonLink size="sm" href={sessionHref}>Open session</ButtonLink>
        <Button size="sm" variant="quiet" ref={closeRef} onClick={onClose}>Close output</Button>
      </div>
    </section>
  );
}
