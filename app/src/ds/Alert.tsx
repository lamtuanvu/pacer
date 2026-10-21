import type { ComponentChildren } from 'preact';
export type AlertTone = 'success' | 'warning' | 'error' | 'info';
export function Alert({tone='info', title, children, announce=true}: {tone?: AlertTone; title: string; children?: ComponentChildren; announce?: boolean}) {
  return <div className={`pc-alert pc-alert--${tone}`} role={announce ? tone==='error'?'alert':'status' : undefined}>
    <span className="pc-alert__icon" aria-hidden="true">{tone==='success'?'✓':tone==='info'?'i':'!'}</span>
    <div className="pc-alert__content"><strong>{title}</strong>{children&&<div>{children}</div>}</div>
  </div>;
}
