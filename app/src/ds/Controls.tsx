import { classNames as classes } from "./classNames";
import { useDensity } from "./Density";
import { forwardRef } from "preact/compat";
import { cloneElement, isValidElement, toChildArray, type JSX, type ComponentChildren, type VNode } from "preact";
import { useId, useLayoutEffect, useRef } from "preact/hooks";
import { ChoicePicker } from "./ChoicePicker";

type InputProps = JSX.InputHTMLAttributes<HTMLInputElement>;

/** Native attributes and refs reach the actual control. */
export const TextInput = forwardRef<HTMLInputElement, InputProps>(function TextInput({ className, ...props }, ref) {
  const density = useDensity();
  return <input {...props} ref={ref} className={classes('pc-input', `pc-control--${density}`, className)} />;
});
export const TextArea = forwardRef<HTMLTextAreaElement, JSX.TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea({ className, ...props }, ref) {
  const density = useDensity();
  return <textarea {...props} ref={ref} className={classes('pc-input', 'pc-textarea', `pc-control--${density}`, className)} />;
});
type FieldNode = VNode<{ id?: string; children?: ComponentChildren; 'aria-describedby'?: string; 'aria-invalid'?: boolean }>;
/** `skip` names elements not searched, e.g. a control's own native label. */
export function findControl(children: ComponentChildren, skip: readonly string[] = []): FieldNode | undefined {
  for (const child of toChildArray(children)) {
    if (!isValidElement(child)) continue;
    const node = child as FieldNode;
    if ([TextInput, TextArea, ChoicePicker, Checkbox, Switch, Range].includes(node.type as never)) return node;
    if (typeof node.type === 'string' && skip.includes(node.type)) continue;
    const nested = findControl(node.props.children, skip);
    if (nested) return nested;
  }
}
/** `wrap` optionally places the connected control inside another element. */
export function connectControl(children: ComponentChildren, target: FieldNode, attributes: Partial<FieldNode['props']>, wrap?: (control: VNode) => VNode): ComponentChildren {
  return toChildArray(children).map(child => {
    if (!isValidElement(child)) return child;
    const node = child as FieldNode;
    if (node === target) { const connected = cloneElement(node, attributes); return wrap ? wrap(connected) : connected; }
    return node.props.children ? cloneElement(node, { children: connectControl(node.props.children, target, attributes, wrap) }) : node;
  });
}
/** Labels the first canonical control, including within layout elements; keeps sibling feedback intact. */
export function Field({ label, help, error, children, className }: {
  label: ComponentChildren; help?: ComponentChildren; error?: ComponentChildren;
  children: ComponentChildren; className?: string;
}) {
  const generated = useId();
  const control = findControl(children);
  const id = control?.props.id ?? `field-${generated}`;
  const describedBy = [control?.props['aria-describedby'], help && `${id}-help`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
  return <div className={classes('pc-field', 'field', className)}>
    <label htmlFor={control ? id : undefined}>{label}</label>
    {control ? connectControl(children, control, { id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : control.props['aria-invalid'] }) : children}
    {help && <small id={`${id}-help`}>{help}</small>}
    {error && <small id={`${id}-error`} className="pc-field__error" role="alert">{error}</small>}
  </div>;
}

export interface CheckboxProps extends InputProps { label?: ComponentChildren; help?: ComponentChildren; mixed?: boolean }
/** Beautiful UI Switch's controlled track, using a native checkbox for forms and keyboard semantics. */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox({ label, help, mixed, className, ...props }, forwardedRef) {
  const density = useDensity();
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { if (input.current) input.current.indeterminate = !!mixed; }, [mixed]);
  const control = <input {...props} ref={node => {
    input.current = node;
    if (typeof forwardedRef === 'function') forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  }} type="checkbox" aria-checked={mixed ? 'mixed' : props['aria-checked']} className={classes('pc-checkbox__input', `pc-control--${density}`, className)} />;
  return label ? <label className="pc-checkbox">{control}<span>{label}{help && <small className="pc-control-help">{help}</small>}</span></label> : control;
});
export function Radio({ className, ...props }: InputProps) {
  return <input {...props} type="radio" className={classes('pc-radio', className)} />;
}
export const Switch = forwardRef<HTMLInputElement, CheckboxProps>(function Switch(props, ref) {
  return <Checkbox {...props} ref={ref} role="switch" className={classes('pc-switch', props.className)} />;
});
export const Range = forwardRef<HTMLInputElement, InputProps & { label?: ComponentChildren }>(function Range({ label, id, className, ...props }, ref) {
  const generated = useId();
  const density = useDensity();
  const inputId = id ?? `range-${generated}`;
  const input = <input {...props} ref={ref} id={inputId} type="range" className={classes('pc-range', `pc-control--${density}`, className)} />;
  return label ? <label className="pc-range-field" htmlFor={inputId}>{label}{input}</label> : input;
});
export function Disclosure({ summary, children, className, ...props }: JSX.HTMLAttributes<HTMLDetailsElement> & { summary: ComponentChildren; open?: boolean }) {
  return <details {...props} className={classes('pc-disclosure', className)}><summary>{summary}</summary>{children}</details>;
}
