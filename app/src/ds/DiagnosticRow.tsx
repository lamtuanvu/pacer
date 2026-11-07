import type { ComponentChildren } from 'preact';
import { Disclosure } from './Controls';
import { Pill } from './Pill';

/**
 * Causes and next steps stay visible; raw output is a separate, labelled disclosure.
 * With `kind`, a neutral pill names who does the fix and the status is read out instead of shown;
 * `notice` holds in-row progress, results and confirmations below the cause.
 */
export function DiagnosticRow({ title, caption, glyph, tone, status, kind, action, nextStep, notice, children, open = false }: {
  title: string; caption: string; glyph: string; tone: 'good' | 'warn' | 'bad' | 'neutral';
  status: string; kind?: string; action?: ComponentChildren; nextStep?: string; notice?: ComponentChildren; children: ComponentChildren; open?: boolean;
}) {
  return <div className={`pc-diagnostic-row pc-diagnostic-row--${tone}`}>
    <div className="pc-diagnostic-row__body">
      <div className="pc-diagnostic-row__heading">
        <span className={`pc-diagnostic-glyph pc-diagnostic-glyph--${tone}`} aria-hidden="true">{glyph}</span>
        <div className="pc-diagnostic-row__text">
          {kind
            ? <span className="pc-diagnostic-row__title"><b>{title}</b><span className="sr-only">: {status}.</span><Pill>{kind}</Pill></span>
            : <b>{title}</b>}
          <span className={kind ? 'pc-diagnostic-row__detail' : 'pc-diagnostic-caption'}>{caption}</span>
        </div>
        {!kind && <span className="pc-diagnostic-caption">{status}</span>}
      </div>
      {nextStep && <p className="pc-diagnostic-row__next">{nextStep}</p>}
      {notice && <div className="pc-diagnostic-row__notice">{notice}</div>}
      <Disclosure className="pc-diagnostic-row__details" open={open} summary={<span>Technical details<span className="sr-only"> for {title}</span></span>}>
        <div className="pc-diagnostic-row__output">{children}</div>
      </Disclosure>
    </div>
    {action && <div className="pc-diagnostic-row__action">{action}</div>}
  </div>;
}
