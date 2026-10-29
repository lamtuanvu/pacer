function scrollTarget(): Window | HTMLElement {
  // The viewport-pinned frame scrolls its work area on web, desktop and with an open dock.
  return document.querySelector<HTMLElement>(".pc-work") ?? document.getElementById("app") ?? window;
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
  scrollPageTo(0);
}
