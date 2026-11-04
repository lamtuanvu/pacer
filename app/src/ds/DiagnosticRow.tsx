import type { ComponentChildren } from 'preact';
import { Disclosure } from './Controls';

/** Causes and next steps stay visible; raw output is a separate, labelled disclosure. */
export function DiagnosticRow({ title, caption, glyph, tone, status, action, nextStep, children, open = false }: {
  title: string; caption: string; glyph: string; tone: 'good' | 'warn' | 'bad' | 'neutral';
  status: string; action?: ComponentChildren; nextStep?: string; children: ComponentChildren; open?: boolean;
}) {
  return <div className={`pc-diagnostic-row pc-diagnostic-row--${tone}`}>
    <div className="pc-diagnostic-row__body">
      <div className="pc-diagnostic-row__heading">
        <span className={`pc-diagnostic-glyph pc-diagnostic-glyph--${tone}`} aria-hidden="true">{glyph}</span>
        <div className="pc-diagnostic-row__text"><b>{title}</b><span className="pc-diagnostic-caption">{caption}</span></div>
        <span className="pc-diagnostic-caption">{status}</span>
      </div>
      {nextStep && <p className="pc-diagnostic-row__next">{nextStep}</p>}
      <Disclosure className="pc-diagnostic-row__details" open={open} summary={<span>Technical details<span className="sr-only"> for {title}</span></span>}>
        <div className="pc-diagnostic-row__output">{children}</div>
      </Disclosure>
    </div>
    {action && <div className="pc-diagnostic-row__action">{action}</div>}
  </div>;
}
