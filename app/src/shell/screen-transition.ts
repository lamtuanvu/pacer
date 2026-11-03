type ViewTransitionDocument = Document & { startViewTransition?: (update: () => Promise<void> | void) => unknown };

const screenOf = (hash: string) => hash.split("?")[0] || "#/";

/**
 * Applies a route change, cross-fading the page when it moves to another screen. A change of query or panel
 * on the same screen, a browser without view transitions and reduced motion all switch instantly.
 */
export function changeScreen(from: string, to: string, update: () => void) {
  const doc = document as ViewTransitionDocument;
  if (screenOf(from) === screenOf(to) || !doc.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { update(); return; }
  // Preact renders on a microtask; resolving after a macrotask lets the transition capture the rendered screen.
  doc.startViewTransition(() => { update(); return new Promise<void>(resolve => setTimeout(resolve, 0)); });
}
