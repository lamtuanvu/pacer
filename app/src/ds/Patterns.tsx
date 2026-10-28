import { classNames as classes } from "./classNames";
// Beautiful UI TextRow, SegmentedControl, TaskRows, ApprovalCard and LoadingState adaptations.
// Pinned source map: docs/design-system.md. Domain state and actions stay with consumers.
import type { ComponentChildren, JSX } from 'preact';
import { Button, type ButtonProps } from "./Button";
import { useDensity } from "./Density";
import { SectionHeading } from "./SectionHeading";
export { ActionPanel, Cluster, DisclosurePanel, Page, PageBody, PageColumns, PageHeader, Section, Stack } from "./Page";

export function TextRow({ label, value, meta, className }: {
  label: ComponentChildren; value: ComponentChildren; meta?: ComponentChildren; className?: string;
}) {
  return <div className={classes('pc-text-row', className)}>
    <span className="pc-text-row__label">{label}</span>
    <span className="pc-text-row__value">{value}{meta && <span className="pc-text-row__meta">{meta}</span>}</span>
  </div>;
}

export interface ListRowProps extends JSX.HTMLAttributes<HTMLDivElement> {
  leading?: ComponentChildren; content?: ComponentChildren; meta?: ComponentChildren; actions?: ComponentChildren;
  density?: 'normal' | 'compact' | 'touch';
  layout?: 'aligned';
  outlined?: boolean; tone?: 'bad' | 'warn';
}
/** Sibling slots keep navigation and secondary actions from nesting interactive elements. */
export function ListRow({ leading, content, meta, actions, children, className, density, layout, outlined, tone, ...props }: ListRowProps) {
  const inherited = useDensity();
  return <div {...props} className={classes('pc-list-row', `pc-list-row--${density ?? inherited}`, layout && `pc-list-row--${layout}`, outlined && 'pc-list-row--outlined', tone && `pc-list-row--${tone}`, className)}>
    {leading && <span className="pc-list-row__leading">{leading}</span>}
    {content ? <div className="pc-list-row__content">{content}</div> : children}
    {meta && <div className="pc-list-row__meta">{meta}</div>}
    {actions && <div className="pc-list-row__actions">{actions}</div>}
  </div>;
}
/** Whole-row navigation is appropriate only when the row has no secondary controls. */
export function ListRowLink({ className, children, ...props }: JSX.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const density = useDensity();
  return <a {...props} className={classes('pc-list-row', `pc-list-row--${density}`, 'pc-list-row--link', className)}>{children}</a>;
}
export function SelectableRow({ selected, className, ...props }: ButtonProps & { selected?: boolean }) {
  return <Button {...props} variant="quiet" aria-pressed={selected ?? props['aria-pressed']}
    className={classes('pc-selectable-row', className)} />;
}
export function ChoiceCard(props: ButtonProps & { selected?: boolean }) {
  return <SelectableRow {...props} className={classes('pc-choice-card', props.className)} />;
}
export function FilterChip({ selected, className, ...props }: ButtonProps & { selected?: boolean }) {
  return <Button {...props} size="sm" aria-pressed={selected ?? props['aria-pressed']} className={classes('pc-chip', className)} />;
}

export interface SegmentOption { value: string; label: ComponentChildren; disabled?: boolean }
export function SegmentedControl({ label, value, options, onChange, disabled, className }: {
  label: string; value: string; options: readonly SegmentOption[];
  onChange: (value: string) => void; disabled?: boolean; className?: string;
}) {
  return <div role="group" aria-label={label} className={classes('pc-segmented', className)}>
    {options.map(option => <Button size="sm" key={option.value} disabled={disabled || option.disabled}
      aria-pressed={value === option.value} onClick={() => onChange(option.value)}>{option.label}</Button>)}
  </div>;
}
/** Roving tablist movement shared by Tabs and PanelTabs: the target index, or undefined for other keys. */
export function tabStep(key: string, at: number, length: number): number | undefined {
  return key === 'ArrowRight' ? (at + 1) % length : key === 'ArrowLeft' ? (at + length - 1) % length
    : key === 'Home' ? 0 : key === 'End' ? length - 1 : undefined;
}
export function Tabs({ label, id, value, options, onChange }: {
  label: string; id: string; value: string; options: readonly SegmentOption[]; onChange: (value: string) => void;
}) {
  const available = options.filter(option => !option.disabled);
  return <div role="tablist" aria-label={label} className="pc-tabs">
    {options.map(option => <Button key={option.value} id={`${id}-${option.value}-tab`} role="tab"
      aria-selected={value === option.value} aria-controls={`${id}-${option.value}-panel`}
      tabIndex={value === option.value ? 0 : -1} disabled={option.disabled}
      onClick={() => onChange(option.value)} onKeyDown={event => {
        const next = tabStep(event.key, available.indexOf(option), available.length);
        if (next === undefined) return;
        event.preventDefault();
        const target = available[next]!;
        onChange(target.value);
        document.getElementById(`${id}-${target.value}-tab`)?.focus();
      }}>{option.label}</Button>)}
  </div>;
}

export function Card({ children, className, ...props }: JSX.HTMLAttributes<HTMLElement>) {
  return <section {...props} className={classes('pc-card', className)}>{children}</section>;
}
export function ApprovalCard({ title, children, actions, className, ...props }: JSX.HTMLAttributes<HTMLElement> & {
  title?: string; actions?: ComponentChildren;
}) {
  return <section {...props} className={classes('pc-approval-card', className)}>
    {title && <header><SectionHeading>{title}</SectionHeading></header>}
    <div className="pc-approval-card__body">{children}</div>
    {actions && <footer className="pc-list-row__actions">{actions}</footer>}
  </section>;
}
/** Upstream's pixel grid and adjacent label; no elapsed timer, video or demo state. */
export function LoadingState({ label = 'Loading…', updating = false }: { label?: string; updating?: boolean }) {
  return <div className={classes('pc-loading', updating && 'pc-loading--updating')} role="status" aria-live="polite">
    <span className="pc-loading__indicator" aria-hidden="true">
      {Array.from({ length: 9 }, (_, index) => <span key={index} />)}
    </span>{label}
  </div>;
}
export function EmptyState({ title, description, children }: {
  title: string; description?: ComponentChildren; children?: ComponentChildren;
}) {
  return <section className="pc-empty"><SectionHeading>{title}</SectionHeading>
    {description && <p>{description}</p>}{children}
  </section>;
}
