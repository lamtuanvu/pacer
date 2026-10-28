import type { ComponentChildren } from 'preact';
import { Disclosure } from './Controls';

/** Row actions remain siblings of the native disclosure, never nested targets. */
export function DiagnosticRow({ title, caption, glyph, tone, status, action, children, open = false }: {
  title: string; caption: string; glyph: string; tone: 'good' | 'warn' | 'bad' | 'neutral';
  status: string; action?: ComponentChildren; children: ComponentChildren; open?: boolean;
}) {
  return <div className={`pc-diagnostic-row pc-diagnostic-row--${tone}`}>
    <Disclosure className="pc-diagnostic-row__details" open={open} summary={<>
      <span className={`pc-diagnostic-glyph pc-diagnostic-glyph--${tone}`} aria-hidden="true">{glyph}</span>
      <span className="pc-diagnostic-row__text"><b>{title}</b><span className="pc-diagnostic-caption">{caption}</span></span>
      <span className="sr-only">{status}</span>
    </>}><div className="pc-diagnostic-row__output">{children}</div></Disclosure>
    {action && <div className="pc-diagnostic-row__action">{action}</div>}
  </div>;
}
