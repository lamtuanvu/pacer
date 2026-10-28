import type { ComponentChildren } from "preact";
/** `size="sm"` is the 11 px key cap of the command menu and title-bar search. */
export function Kbd({ children, size }: { children: ComponentChildren; size?: "sm" }) { return <kbd className={size === "sm" ? "pc-kbd pc-kbd--sm" : "pc-kbd"}>{children}</kbd>; }
