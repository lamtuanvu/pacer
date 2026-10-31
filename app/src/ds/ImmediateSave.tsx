import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Disclosure, Range } from "./Controls";

/** Plain public reasons; retain transport/diagnostic detail only in the disclosure. */
export function saveError(error: unknown): { message: string; detail: string } {
  const e = error as { code?: string; message?: string };
  const detail = e?.message ?? String(error);
  const code = e?.code;
  const reasons: Record<string,string> = {
    conflict: "This setting changed elsewhere. Reload and try again.",
    forbidden: "You don't have permission to change this setting.",
    not_allowed: "This change isn't allowed. Reconnect or check your permissions.",
    unauthorized: "Reconnect to the service and try again.",
    capability_denied: "This plugin needs permission before it can make this change.",
    invalid_input: "Choose a valid value and try again.",
    invalid_params: "Choose a valid value and try again.",
    invalid_config: "Choose a valid value and try again.",
    not_found: "This item was removed. Reload the settings and try again.",
    unknown_executor: "This agent was removed. Reload the settings and try again.",
    unknown_plugin: "This plugin was removed. Reload the settings and try again.",
    unknown_task: "This task is no longer available. Reload and try again.",
    unknown_op: "Update the service to change this setting.",
    too_large: "This value is too long. Use a shorter value.",
    unavailable: "The service isn't available. Try again shortly.",
    rate_limited: "Too many changes were sent. Wait a moment and try again.",
    plugin_timeout: "The plugin took too long to respond. Try again.",
    plugin_unavailable: "The plugin isn't available. Check its status in Plugins.",
    plugin_refused: "The plugin couldn't start. Check its status in Plugins.",
    internal: "The service could not save this change. Try again.",
  };
  const reason = /Live validation D8/.test(detail) ? "This change is blocked in the validation sandbox."
    : code && reasons[code] ? reasons[code]!
    : /network|fetch|connect/i.test(detail) ? "The service could not be reached. Try again."
    : /\b[A-Z]\d\b|\b[a-z_]+\.[a-z_.]+\b|\b[a-z]+_[a-z_]+\b|^[a-z_]+:/.test(detail) ? "The service could not save this change. Try again."
    : detail;
  return { message: `Couldn't save: ${reason}`, detail };
}

/** One immediate save boundary per control. Synchronous locking also blocks duplicate events before render. */
export function ImmediateSave<T>({ value, save, children, focusableWhileBusy = false }: {
  focusableWhileBusy?: boolean;
  value: T; save: (value: T) => Promise<unknown> | unknown;
  children: (value: T, change: (value: T) => void, busy: boolean) => ComponentChildren;
}) {
  const [local, setLocal] = useState<{ value: T; baseline: T }>();
  const [busy, setBusy] = useState(false), [saved, setSaved] = useState(false), [error, setError] = useState<ReturnType<typeof saveError>>();
  const pending = useRef(false), timer = useRef<ReturnType<typeof setTimeout>>(), alive = useRef(true);
  const control = useRef<HTMLDivElement>(null), invoking = useRef<HTMLElement>();
  useLayoutEffect(() => {
    const target = invoking.current;
    if (busy || !target) return;
    const active = target.ownerDocument.activeElement;
    if (!target.isConnected || (active !== target.ownerDocument.body && active !== target)) {
      invoking.current = undefined;
      return;
    }
    if (target.matches(':disabled,[aria-disabled="true"]') || target.closest("[inert]")) return;
    target.focus();
    invoking.current = undefined;
  });
  const displayed = local && (busy || Object.is(local.baseline, value)) ? local.value : value;
  useEffect(() => { alive.current = true; return () => { alive.current = false; clearTimeout(timer.current); }; }, []);
  const change = async (next: T) => {
    if (pending.current) return;
    const active = control.current?.ownerDocument.activeElement;
    invoking.current = active && active instanceof HTMLElement && control.current?.contains(active) ? active : undefined;
    pending.current = true; clearTimeout(timer.current); setSaved(false); setError(undefined); setBusy(true);
    setLocal({ value: next, baseline: value });
    try {
      const result = await save(next);
      if (result === false) { if (alive.current) setLocal({ value: displayed, baseline: value }); return; }
      if (alive.current) { setSaved(true); timer.current = setTimeout(() => setSaved(false), 2000); }
    } catch (e) {
      if (alive.current) { setLocal({ value: displayed, baseline: value }); setError(saveError(e)); }
    } finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  return <div className="pc-immediate-save">
    <div className="pc-immediate-save__line"><div ref={control} className="pc-immediate-save__control" aria-busy={busy} inert={!focusableWhileBusy && busy || undefined}>{children(displayed, next => void change(next), busy)}</div><span className="pc-immediate-save__status" role="status" aria-live="polite">{saved && <><span aria-hidden="true">✓</span> Saved</>}</span></div>
    {error && <div className="pc-immediate-save__error"><p role="alert">{error.message}</p><Disclosure summary="Technical details"><code>{error.detail}</code></Disclosure></div>}
  </div>;
}

/** Preview freely; one commit at pointer/key release (blur supports assistive input). */
export function ReleaseRange({ value, onCommit, ...props }: Omit<Parameters<typeof Range>[0], "value" | "onChange" | "onInput"> & { value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value), latest = useRef(value);
  useEffect(() => { latest.current = value; setDraft(value); }, [value]);
  const commit = () => { if (latest.current !== value) onCommit(latest.current); };
  return <Range {...props} value={draft} onInput={event => { latest.current = event.currentTarget.value; setDraft(latest.current); }} onPointerUp={commit} onKeyUp={commit} onBlur={commit} onPointerCancel={() => { latest.current = value; setDraft(value); }}/>;
}
