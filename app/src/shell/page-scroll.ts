function scrollTarget(): Window | HTMLElement {
  if (document.documentElement.hasAttribute("data-pacer-desktop")) {
    return document.querySelector<HTMLElement>(".pc-work") ?? document.getElementById("app") ?? window;
  }
  return window;
}

export function pageScrollY(): number {
  const target = scrollTarget();
  return target === window ? window.scrollY : (target as HTMLElement).scrollTop;
}

export function scrollPageTo(y: number): void {
  scrollTarget().scrollTo(0, y);
}

export function onPageScroll(listener: () => void): () => void {
  const content = document.querySelector<HTMLElement>(".pc-work");
  window.addEventListener("scroll", listener, { passive: true });
  content?.addEventListener("scroll", listener, { passive: true });
  return () => {
    window.removeEventListener("scroll", listener);
    content?.removeEventListener("scroll", listener);
  };
}

export function resetDesktopPageScroll(): void {
  if (document.documentElement.hasAttribute("data-pacer-desktop")) scrollPageTo(0);
}
