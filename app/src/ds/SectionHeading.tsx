import { createElement, type JSX, type ComponentChildren } from "preact";

export interface SectionHeadingProps extends JSX.HTMLAttributes<HTMLElement> {
  variant?: "headline";
  as?: "h2" | "h3" | "label" | "span";
  htmlFor?: string;
  children: ComponentChildren;
}

/** One section type style, with semantic headings or associated form labels. */
export function SectionHeading({ as: Tag = "h2", className, children, variant, ...rest }: SectionHeadingProps) {
  return createElement(Tag, { ...rest, className: ["pc-section-heading", variant&&`pc-section-heading--${variant}`, className].filter(Boolean).join(" ") }, children);
}
