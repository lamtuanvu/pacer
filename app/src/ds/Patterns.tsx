import { classNames as classes } from "./classNames";
// Beautiful UI TextRow, SegmentedControl, TaskRows, ApprovalCard and LoadingState adaptations.
// Pinned source map: docs/design-system.md. Domain state and actions stay with consumers.
import type { ComponentChildren, JSX } from 'preact';
import { Button, ButtonLink, type ButtonProps } from "./Button";
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
  layout?: 'aligned' | 'planner';
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
export function ChoiceCard({ layout, ...props }: ButtonProps & { selected?: boolean; layout?: "agent" | "alias" }) {
  return <SelectableRow {...props} className={classes('pc-choice-card', layout && `pc-choice-card--${layout}`, props.className)} />;
}
export function FilterChip({ selected, className, ...props }: ButtonProps & { selected?: boolean }) {
  return <Button {...props} size="sm" aria-pressed={selected ?? props['aria-pressed']} className={classes('pc-chip', className)} />;
}

export interface SegmentOption { value: string; label: ComponentChildren; disabled?: boolean }
export function SegmentedControl({ label, value, options, onChange, disabled, className, variant, describedBy }: {
  variant?: "board" | "insights"; label: string; value: string; options: readonly SegmentOption[];
  onChange: (value: string) => void; disabled?: boolean; className?: string;
  /** Id of visible text that explains the group, such as why it is disabled (UI-13). */
  describedBy?: string;
}) {
  return <div role="group" aria-label={label} aria-describedby={describedBy} className={classes('pc-segmented', variant && `pc-segmented--${variant}`, className)}>
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

/** Tabs that are pages: links in a labelled nav, the current one marked with aria-current="page". */
export function NavTabs({ label, items }: { label: string; items: readonly { href: string; label: ComponentChildren; current?: boolean }[] }) {
  return <nav aria-label={label} className="pc-tabs pc-tabs--nav">
    {items.map(item => <ButtonLink key={item.href} href={item.href} size="sm" aria-current={item.current ? "page" : undefined}>{item.label}</ButtonLink>)}
  </nav>;
}

export function Card({ children, className, tone, ...props }: JSX.HTMLAttributes<HTMLElement>&{tone?:"bad"|"sunken"}) {
  return <section {...props} className={classes('pc-card', tone&&`pc-card--${tone}`, className)}>{children}</section>;
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
export function EmptyState({ title, description, children, bodyTitle = false }: {
  title: string; description?: ComponentChildren; children?: ComponentChildren; bodyTitle?: boolean;
}) {
  return <section className="pc-empty">{bodyTitle ? <strong className="pc-empty__body-title">{title}</strong> : <SectionHeading>{title}</SectionHeading>}
    {description && <p>{description}</p>}{children}
  </section>;
}

/** Native radios provide browser keyboard navigation and one selected account policy. */
export function RadioChoices({label,name,value,options,onChange,disabled,layout}:{label:string;name:string;value:string;options:readonly SegmentOption[];onChange:(value:string)=>void;disabled?:boolean;layout?:"options"}) {
  return <div role="radiogroup" aria-label={label} className={classes("pc-radio-choices",layout && `pc-radio-choices--${layout}`)}>{options.map(option=><label key={option.value}><input type="radio" name={name} value={option.value} checked={value===option.value} disabled={disabled||option.disabled} onChange={()=>onChange(option.value)}/><span>{option.label}</span></label>)}</div>;
}
