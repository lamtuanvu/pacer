import { useContext } from "preact/hooks";
import { NarrowContext } from "../shell/narrow";
import type { JSX } from "preact";
export interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> { variant?: "primary" | "secondary" | "ghost"; size?: "md" | "sm" }
export function Button({ variant = "secondary", size = "md", className, children, ...rest }: ButtonProps) {
  const narrow = useContext(NarrowContext);
  return <button type="button" {...rest} className={["pc-btn", `pc-btn--${variant}`, `pc-btn--${size}`, narrow && "pc-btn--touch", className].filter(Boolean).join(" ")}>{children}</button>;
}
