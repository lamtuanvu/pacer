import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { Button, ButtonLink, type ButtonProps, type ButtonLinkProps } from "./Button";
import { classNames } from "./classNames";

export interface SegmentOption {
  value: string; label: ComponentChildren; disabled?: boolean;
  /** Sibling actions (for example Close) never nest inside the tab. */
  trailing?: ComponentChildren; replacement?: ComponentChildren;
  buttonProps?: ButtonProps; href?: string; controls?: string;
}
export interface StripProps {
  label: string; id?: string; value: string; options: readonly SegmentOption[];
  onChange: (value: string) => void; disabled?: boolean; className?: string;
  variant?: "board" | "insights" | "result" | "pills"; describedBy?: string;
}
export function tabStep(key: string, at: number, length: number): number | undefined {
  if (!length) return undefined;
  return key === "ArrowRight" ? (at + 1) % length : key === "ArrowLeft" ? (at + length - 1) % length
    : key === "Home" ? 0 : key === "End" ? length - 1 : undefined;
}
const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** One geometry owner for value pickers, view tabs and page navigation. */
export function SelectionStrip({ label, id, value, options, onChange, disabled, className, variant, describedBy, mode }: StripProps & { mode: "segmented" | "tabs" | "nav" }) {
  const list = useRef<HTMLDivElement>(null), indicator = useRef<HTMLSpanElement>(null);
  const initialized = useRef(false), previous = useRef(value), snapshot = useRef<HTMLElement | null>(null);
  const finish = useRef<(() => void) | undefined>(undefined);
  const available = options.filter(option => !disabled && !option.disabled);
  const current = value;
  const focusValue = available.some(option => option.value === current) ? current : available[0]?.value;
  const panelFor = (selected: string) => {
    const button = Array.from(list.current?.querySelectorAll<HTMLElement>("[data-strip-value]") ?? []).find(item => item.dataset.stripValue === selected);
    const controls = button?.getAttribute("aria-controls");
    return controls ? document.getElementById(controls) : null;
  };
  useLayoutEffect(() => {
    const root = list.current!, marker = indicator.current!;
    let frame = 0;
    const measure = () => {
      const selected = Array.from(root.querySelectorAll<HTMLElement>("[data-strip-value]")).find(item => item.dataset.stripValue === current);
      if (!selected) { marker.hidden = true; return; }
      marker.hidden = false;
      // DOM measurements are geometry, never authored design dimensions.
      marker.style.width = `${selected.getBoundingClientRect().width}px`;
      marker.style.height = `${selected.getBoundingClientRect().height}px`;
      marker.style.transform = `translate(${selected.offsetLeft}px, ${selected.offsetTop}px)`;
      if (!initialized.current) frame = requestAnimationFrame(() => { root.dataset.measured = "true"; initialized.current = true; });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    root.querySelectorAll<HTMLElement>("[data-strip-value]").forEach(item => observer.observe(item));
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [current, options]);
  useLayoutEffect(() => {
    const panel = mode === "tabs" ? panelFor(value) : null;
    if (previous.current !== value) {
      finish.current?.();
      const old = snapshot.current;
      if (panel && old && !reduced()) {
        const parent = panel.parentElement!;
        old.removeAttribute("id"); old.setAttribute("aria-hidden", "true"); old.setAttribute("inert", "");
        old.querySelectorAll("[id]").forEach(item => item.removeAttribute("id"));
        old.classList.remove("pc-tab-enter");
        // A closed shadow tree keeps a visual snapshot out of live selectors and
        // accessibility, while preserving the surface's stylesheet context.
        const ghost = document.createElement("div");
        ghost.className = "pc-tab-leave";
        ghost.setAttribute("aria-hidden", "true"); ghost.setAttribute("inert", "");
        ghost.style.transform = `translateY(${panel.offsetTop}px)`;
        const shadow = ghost.attachShadow({ mode: "closed" });
        document.querySelectorAll('link[rel="stylesheet"], style').forEach(sheet => shadow.append(sheet.cloneNode(true)));
        const context = document.createElement("div");
        const ancestors: string[] = [];
        for (let node: HTMLElement | null = parent; node; node = node.parentElement) ancestors.push(node.className);
        context.className = `${ancestors.join(" ")} pc-tab-context`;
        context.append(old); shadow.append(context);
        const minimum = parent.style.minHeight;
        parent.classList.add("pc-tab-swap");
        parent.style.minHeight = `${Math.max(parent.offsetHeight, panel.offsetHeight, Number(old.dataset.containerHeight))}px`;
        parent.append(ghost);
        panel.classList.add("pc-tab-enter");
        const done = () => { ghost.remove(); panel.classList.remove("pc-tab-enter"); parent.classList.remove("pc-tab-swap"); parent.style.minHeight = minimum; finish.current = undefined; };
        // Read the same motion token used by CSS, including theme overrides.
        const duration = parseFloat(getComputedStyle(panel).getPropertyValue("--motion-panel"));
        const timer = window.setTimeout(done, duration);
        finish.current = () => { clearTimeout(timer); done(); };
      }
    }
    previous.current = value;
    snapshot.current = panel?.cloneNode(true) as HTMLElement | null;
    if (snapshot.current && panel) snapshot.current.dataset.containerHeight = String(panel.parentElement!.offsetHeight);
  }, [value, mode]);
  useLayoutEffect(() => () => finish.current?.(), []);
  const change = (next: string) => {
    if (next === value) return;
    const panel = mode === "tabs" ? panelFor(value) : null;
    if (panel) { snapshot.current = panel.cloneNode(true) as HTMLElement; snapshot.current.dataset.containerHeight = String(panel.parentElement!.offsetHeight); }
    onChange(next);
  };
  return <div ref={list} role={mode === "tabs" ? "tablist" : mode === "nav" ? "navigation" : "group"} aria-label={label} aria-describedby={describedBy}
    className={classNames(mode === "segmented" ? "pc-segmented" : "pc-tabs", "pc-selection-strip", mode === "nav" && "pc-tabs--nav", variant && `pc-segmented--${variant}`, className)}>
    <span ref={indicator} aria-hidden="true" className="pc-selection-indicator" hidden />
    {options.map(option => {
      const props: ButtonProps & { "data-strip-value": string } = {
        ...option.buttonProps, size: "sm", disabled: disabled || option.disabled,
        "data-strip-value": option.value,
        ...(mode === "tabs" ? { id: id && `${id}-${option.value}-tab`, role: "tab", "aria-selected": current === option.value,
          "aria-controls": option.controls ?? (id && `${id}-${option.value}-panel`) } : mode === "segmented" ? { "aria-pressed": current === option.value } : {}),
        tabIndex: focusValue === option.value ? 0 : -1,
        onClick: () => change(option.value),
        onKeyDown: event => {
          const next = tabStep(event.key, available.indexOf(option), available.length);
          if (next === undefined) return;
          event.preventDefault();
          const target = available[next]!;
          if (mode === "nav") location.hash = target.href!.replace(/^#/, ""); else change(target.value);
          Array.from(list.current!.querySelectorAll<HTMLElement>("[data-strip-value]")).find(item => item.dataset.stripValue === target.value)?.focus();
        },
      };
      const button = mode === "nav" ? <ButtonLink href={option.href!} aria-current={current === option.value ? "page" : undefined} {...(props as unknown as ButtonLinkProps)}>{option.label}</ButtonLink> : <Button {...props}>{option.label}</Button>;
      return <span key={option.value} className="pc-selection-item">{option.replacement ?? button}{option.trailing}</span>;
    })}
  </div>;
}
export function SegmentedControl(props: StripProps) { return <SelectionStrip {...props} mode="segmented" />; }
export function Tabs(props: StripProps) { return <SelectionStrip {...props} mode="tabs" />; }
