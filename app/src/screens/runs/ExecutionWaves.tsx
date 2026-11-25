/** Board 4: execution waves from the generated child run (or the run's own steps), with dependencies and liveness. */
import { Pill } from "../../ds/Pill";
import { StepState } from "./run-shared";
import { clock } from "../../../../src/view-model/time";
import type { WavesData, WaveStep } from "../../../../src/view-model/run-board";

function Liveness({ step, now }: { step: WaveStep; now: number }) {
  const live = step.liveness;
  if (!live) return step.status === "running" ? <span className="rv-cap">Working</span> : null;
  return live.stalled
    ? <Pill tone="bad"><span aria-hidden="true">! </span>Stalled{live.since ? ` since ${clock(live.since, now)}` : ""}</Pill>
    : <span className="rv-cap">{live.waitingOn ? `Waiting on ${live.waitingOn}` : "Working"}</span>;
}

export function ExecutionWaves({ data, now }: { data: WavesData | null; now: number }) {
  if (!data) return <p className="rv-cap">No execution plan yet.</p>;
  return (
    <section className="rv-section" aria-label="Execution waves">
      <p className="rv-cap">{data.source === "generated" ? "Waves from the generated plan." : "Waves from this run's own steps."} Steps in a wave can run at the same time.</p>
      <ol className="rv-waves">
        {data.waves.map(wave => (
          <li key={wave.index} className="rv-wave" aria-label={`Wave ${wave.index}`}>
            <strong className="rv-num">Wave {wave.index}</strong>
            <ul className="rv-wave-steps rv-list">
              {wave.steps.map(step => (
                <li key={step.stepId} className="rv-box" data-step={step.stepId}>
                  <span className="rv-row">
                    <strong className="rv-grow rv-clip">{step.label}</strong>
                    <StepState marker={step.marker} status={step.status} />
                  </span>
                  {step.blocked
                    ? <p className="rv-text">Blocked until {step.after.join(", ")} {step.after.length === 1 ? "finishes" : "finish"}.</p>
                    : step.after.length ? <p className="rv-cap">After {step.after.join(", ")}</p> : null}
                  <Liveness step={step} now={now} />
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  );
}
