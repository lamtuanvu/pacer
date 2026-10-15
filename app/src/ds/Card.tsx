import type { ComponentChildren } from "preact";
export interface CardProps { tone?: "default" | "sunken" | "bad" | "warn"; children?: ComponentChildren; className?: string }
export function Card({ tone = "default", children, className }: CardProps) {
  return <div className={["pc-card", `pc-card--${tone}`, className].filter(Boolean).join(" ")}>{children}</div>;
}
