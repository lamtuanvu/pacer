import type { JSX } from "preact";
export interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> { variant?: "primary" | "secondary" | "ghost"; size?: "md" | "sm" }
export function Button({ variant = "secondary", size = "md", className, children, ...rest }: ButtonProps) {
  return <button type="button" {...rest} className={["pc-btn", `pc-btn--${variant}`, `pc-btn--${size}`, className].filter(Boolean).join(" ")}>{children}</button>;
}
