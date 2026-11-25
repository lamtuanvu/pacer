/** An agent's live output on the Live board: follows `task.log` (the `/v3/tasks/<id>/log` read) until the task is done. */
import { useEffect, useRef, useState } from "preact/hooks";
import type { BrowserApi } from "../../data/api";
import { Alert } from "../../ds/Alert";
import { Button, ButtonLink } from "../../ds/Button";
import { SectionHeading } from "../../ds/SectionHeading";

interface Chunk { stdout: string; stderr: string; next: { stdout: number; stderr: number }; done: boolean; source: string }
export const OUTPUT_POLL_MS = 2500;
const KEEP_CHARS = 24_000;

type OutputState = { text: string; phase: "loading" | "live" | "done" | "error"; error?: string };

const tail = (text: string): string => text.length > KEEP_CHARS ? text.slice(text.length - KEEP_CHARS) : text;

export function AgentOutput({ api, taskId, executor, stepLabel, sessionHref, onClose, pollMs = OUTPUT_POLL_MS }: {
  api: BrowserApi; taskId: string; executor: string; stepLabel: string; sessionHref: string; onClose: () => void; pollMs?: number;
}) {
  const [out, setOut] = useState<OutputState>({ text: "", phase: "loading" });
  const [attempt, retry] = useState(0);
  const panel = useRef<HTMLElement>(null);
  // The panel opens below the board; bring it into view without moving focus off the agent that opened it.
  useEffect(() => { panel.current?.scrollIntoView?.({ block: "nearest" }); }, [taskId]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let offsets = { stdout: 0, stderr: 0 };
    let source: string | undefined;
    let text = "";
    setOut({ text: "", phase: "loading" });
    const step = async () => {
      try {
        const chunk = await api.call<Chunk>("task.log", { id: taskId, ...offsets });
        if (!active) return;
        if (source !== undefined && chunk.source !== source) {
          // The output was rerouted: start again from the top rather than splice two sources.
          offsets = { stdout: 0, stderr: 0 }; text = ""; source = chunk.source;
          timer = setTimeout(step, 0);
          return;
        }
        source = chunk.source;
        const err = chunk.stderr ? chunk.stderr.split("\n").filter(Boolean).map(l => `stderr: ${l}`).join("\n") : "";
        text = tail(text + chunk.stdout + (err ? `${chunk.stdout && !chunk.stdout.endsWith("\n") ? "\n" : ""}${err}\n` : ""));
        offsets = chunk.next;
        setOut({ text, phase: chunk.done ? "done" : "live" });
        if (!chunk.done) timer = setTimeout(step, pollMs);
      } catch (e) {
        if (active) setOut({ text, phase: "error", error: e instanceof Error ? e.message : "The output could not be read." });
      }
    };
    void step();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [api, taskId, pollMs, attempt]);
  const status = out.phase === "loading" ? "Reading output…" : out.phase === "live" ? "Following live output" : out.phase === "done" ? "Task finished; this is its full output" : "";
  return (
    <section ref={panel} className="lb-section" aria-label={`Live output: ${executor} on ${stepLabel}`}>
      <div className="lb-row">
        <SectionHeading>Live output</SectionHeading>
        <span className="lb-cap">{executor} · {stepLabel}</span>
      </div>
      <p className="lb-cap" role="status" aria-live="polite">{status}</p>
      {out.phase === "error" ? (
        <Alert tone="error" title="Couldn't read the output">
          <p>{out.error}</p>
          <Button size="sm" onClick={() => retry(n => n + 1)}>Try again</Button>
        </Alert>
      ) : null}
      {out.text
        ? <pre className="lb-output" tabIndex={0} role="log" aria-label={`Output of ${executor}`}>{out.text}</pre>
        : out.phase === "live" || out.phase === "done" ? <p className="lb-cap">No output yet.</p> : null}
      <div className="lb-row">
        <ButtonLink size="sm" href={sessionHref}>Open session</ButtonLink>
        <Button size="sm" variant="quiet" onClick={onClose}>Close output</Button>
      </div>
    </section>
  );
}
