/** Board 1: the step strip. One chip per root step in the engine's order; steps that wait on you are marked. */
import { StepState } from "./run-shared";
import type { StripStep } from "../../../../src/view-model/run-board";

export function RunStrip({ steps }: { steps: StripStep[] }) {
  if (!steps.length) return <p className="rv-cap">No steps have started yet.</p>;
  return (
    <ol className="rv-strip" aria-label="Run steps">
      {steps.map(step => (
        <li key={step.id} className={`rv-step${step.waitsOnYou ? " rv-step--you" : ""}`} data-step={step.stepId}>
          <span className="rv-step-name" title={step.label}>{step.label}</span>
          <span className="rv-row">
            <StepState marker={step.marker} status={step.status} waitsOnYou={step.waitsOnYou} awaitsReview={step.awaitsReview} />
            {step.progress ? <span className="rv-cap rv-num">{step.progress.done} of {step.progress.total} done</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
