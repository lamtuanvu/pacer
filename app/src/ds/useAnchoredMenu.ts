import type { RefObject } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";

/** Measured viewport adapter; CSS owns appearance and the token-derived gutter. */
export function useAnchoredMenu(open: unknown, anchorRef?: RefObject<HTMLElement>) {
  const menuRoot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !menuRoot.current) return;
    const element = menuRoot.current;
    const anchor = anchorRef?.current ?? element.parentElement!;
    const position = () => {
      const rect = anchor.getBoundingClientRect();
      const viewport = document.documentElement;
      const gutter = parseFloat(getComputedStyle(element).paddingLeft);
      const below = viewport.clientHeight - rect.bottom - gutter;
      const above = rect.top - gutter;
      const down = below >= Math.min(element.scrollHeight, viewport.clientHeight / 2) || below >= above;
      const height = Math.min(viewport.clientHeight / 2, down ? below : above);
      element.style.maxHeight = `${Math.max(0, height)}px`;
      element.style.left = `${Math.max(gutter, Math.min(rect.right - element.offsetWidth, viewport.clientWidth - element.offsetWidth - gutter))}px`;
      element.style.top = `${down ? rect.bottom : rect.top - element.offsetHeight}px`;
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    const observer = new ResizeObserver(position); observer.observe(anchor); observer.observe(element);
    return () => { observer.disconnect(); window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [open, anchorRef]);
  return menuRoot;
}
