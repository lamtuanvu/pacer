import { classNames as classes } from "./classNames";
// Beautiful UI TextRow, SegmentedControl, TaskRows, ApprovalCard adaptations.
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
export function ListRowLink({ className, children, layout, ...props }: JSX.AnchorHTMLAttributes<HTMLAnchorElement> & { layout?: "dispatch" }) {
  const density = useDensity();
  return <a {...props} className={classes('pc-list-row', `pc-list-row--${density}`, layout && `pc-list-row--${layout}`, 'pc-list-row--link', className)}>{children}</a>;
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

export { SegmentedControl, Tabs, tabStep, type SegmentOption } from "./SelectionStrip";
import { SelectionStrip } from "./SelectionStrip";

/** Tabs that are pages: links in a labelled nav, the current one marked with aria-current="page". */
export function NavTabs({ label, items }: { label: string; items: readonly { href: string; label: ComponentChildren; current?: boolean }[] }) {
  return <SelectionStrip mode="nav" label={label} value={items.find(item => item.current)?.href ?? ""}
    options={items.map(item => ({ value: item.href, href: item.href, label: item.label }))} onChange={() => {}} />;
}

export function Card({ children, className, tone, ...props }: JSX.HTMLAttributes<HTMLElement>&{tone?:"bad"|"warn"|"sunken"}) {
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
export { Skeleton } from './Skeleton';
export function EmptyState({ title, description, children, bodyTitle = false }: {
  title: string; description?: ComponentChildren; children?: ComponentChildren; bodyTitle?: boolean;
}) {
  return <section className="pc-empty">{bodyTitle ? <strong className="pc-empty__body-title">{title}</strong> : <SectionHeading>{title}</SectionHeading>}
    {description && <p>{description}</p>}{children}
  </section>;
}

/** Native radios provide browser keyboard navigation and one selected account policy. */
import type { SegmentOption } from "./SelectionStrip";
export function RadioChoices({label,name,value,options,onChange,disabled,layout}:{label:string;name:string;value:string;options:readonly SegmentOption[];onChange:(value:string)=>void;disabled?:boolean;layout?:"options"}) {
  return <div role="radiogroup" aria-label={label} className={classes("pc-radio-choices",layout && `pc-radio-choices--${layout}`)}>{options.map(option=><label key={option.value}><input type="radio" name={name} value={option.value} checked={value===option.value} disabled={disabled||option.disabled} onChange={()=>onChange(option.value)}/><span>{option.label}</span></label>)}</div>;
}
