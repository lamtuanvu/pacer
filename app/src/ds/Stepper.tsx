import type { ComponentChildren, JSX } from "preact";
import { Button } from "./Button";

export interface StepperStep { id: string; title: ComponentChildren; detail?: ComponentChildren; state: "done" | "current" | "todo"; reachable: boolean }

/** Wizard progress. Reachable steps are buttons; Up/Down, Left/Right, Home and End move focus between them. */
export function Stepper({ label, steps, onSelect }: { label: string; steps: readonly StepperStep[]; onSelect: (id: string) => void }) {
  const keys = (event: JSX.TargetedKeyboardEvent<HTMLOListElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")], at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = ({ ArrowDown: at + 1, ArrowRight: at + 1, ArrowUp: at - 1, ArrowLeft: at - 1, Home: 0, End: items.length - 1 } as Record<string, number>)[event.key];
    if (next === undefined || at < 0) return;
    event.preventDefault();
    items[Math.max(0, Math.min(items.length - 1, next))]?.focus();
  };
  return <ol aria-label={label} className="pc-stepper" onKeyDown={keys}>
    {steps.map((step, index) => {
      const body = <>
        <span className="pc-stepper__mark" aria-hidden="true">{step.state === "done" ? "✓" : index + 1}</span>
        <span className="pc-stepper__text"><span className="pc-stepper__title">{step.title}{step.state === "done" && <span className="sr-only">, done</span>}</span>
          {step.detail && <span className="pc-stepper__detail">{step.detail}</span>}</span>
      </>;
      return <li key={step.id}>{step.reachable
        ? <Button variant="quiet" className={`pc-stepper__step pc-stepper__step--${step.state}`} aria-current={step.state === "current" ? "step" : undefined} onClick={() => onSelect(step.id)}>{body}</Button>
        : <span className={`pc-stepper__step pc-stepper__step--${step.state}`}>{body}</span>}</li>;
    })}
  </ol>;
}

export interface CheckItem { id: string; label: ComponentChildren; state: "passed" | "failed" | "running" | "pending" | "skipped"; note?: ComponentChildren }
const glyphs = { passed: "✓", failed: "✕", running: "●", pending: "○", skipped: "–" } as const;
const words = { passed: "Passed", failed: "Failed", running: "Checking", pending: "Not started", skipped: "Skipped" } as const;

/** A live check list: each row states its result in words as well as a glyph and tone. */
export function CheckList({ label, items }: { label: string; items: readonly CheckItem[] }) {
  return <ul aria-label={label} className="pc-check-list">
    {items.map(item => <li key={item.id} className={`pc-check-list__item pc-check-list__item--${item.state}`}>
      <span className="pc-check-list__glyph" aria-hidden="true">{glyphs[item.state]}</span>
      <span className="pc-check-list__label"><span className="sr-only">{words[item.state]}: </span>{item.label}</span>
      {item.note && <span className="pc-check-list__note">{item.note}</span>}
    </li>)}
  </ul>;
}
