import type { ComponentChildren } from "preact";
export interface PillProps { tone?: "good" | "warn" | "bad" | "info" | "neutral"; children?: ComponentChildren; className?: string; title?: string }
export function Pill({ tone = "neutral", children, className, title }: PillProps) {
  const valid = ["good", "warn", "bad", "info", "neutral"].includes(tone) ? tone : "neutral";
  return <span title={title} className={["pc-pill", `pc-pill--${valid}`, className].filter(Boolean).join(" ")}>{children}</span>;
}
