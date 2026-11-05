import { useLayoutEffect } from 'preact/hooks';
import { workspaceManager } from './manager';
import { capturePosition, restorePosition, type ViewPosition, type ScrollPosition } from './position';
/** The active view owns page scroll plus its content and portal scroll containers. Terminals own their viewport. */
export function useViewPosition(key: string, active: boolean) {
 useLayoutEffect(() => {
  if (!active) return;
  const roots = () => Array.from(document.querySelectorAll<HTMLElement>('[data-workspace-root]')).filter(node => node.dataset.workspaceRoot === key && !node.closest("[hidden]"));
  const nodes = () => {
   const result: [string, HTMLElement][] = [];
   const page = document.querySelector<HTMLElement>('.pc-main-scroll'); if (page) result.push(['page', page]);
   for (const root of roots()) for (const node of root.querySelectorAll<HTMLElement>('[data-scroll-id]')) if (!node.closest('.xterm,[hidden],[inert]')) result.push([node.dataset.scrollId!, node]);
   return result;
  };
  const focusId = (node: HTMLElement) => node.dataset.focusId ?? node.getAttribute('name') ?? (node.id || undefined);
  const disclosures = () => roots().flatMap((root, r) => [...root.querySelectorAll<HTMLDetailsElement>('details')].map(node => ({ node, id: node.id || `${r}:${node.querySelector('summary')?.textContent}` })));
  const restoreCards = () => { const saved = workspaceManager.get<Record<string, boolean>>(key, 'disclosures', {}); for (const { node, id } of disclosures()) if (saved[id] !== undefined) node.open = saved[id]!; };
  const rememberCards = () => { const saved = workspaceManager.get<Record<string, boolean>>(key, 'disclosures', {}), next = { ...saved }; let changed = false; for (const { node, id } of disclosures()) { if (saved[id] !== node.open) changed = true; next[id] = node.open; } if (changed) workspaceManager.set(key, 'disclosures', next); };
  const onToggle = (event: Event) => { if (disclosures().some(item => item.node === event.target)) rememberCards(); };
  let focus = workspaceManager.get<ViewPosition | undefined>(key, 'position', undefined)?.focus;
  let restoring = true, applying = false;
  const remember = () => { if (!restoring && roots().length) { rememberCards(); workspaceManager.set(key, 'position', capturePosition(nodes(), focus)); } };
  let frame = 0;
  const pending: Record<string, ScrollPosition> = {};
  const flushScroll = () => { if (Object.keys(pending).length) { const previous = workspaceManager.get<ViewPosition>(key, 'position', { scroll: {} }); workspaceManager.set(key, 'position', { scroll: { ...previous.scroll, ...pending }, focus }); for (const id of Object.keys(pending)) delete pending[id]; } };
  const onScroll = (event: Event) => {
   const target = event.target as HTMLElement;
   if (restoring || target?.closest?.('.xterm')) return;
   const id = target?.matches?.('.pc-main-scroll') ? 'page' : target?.dataset?.scrollId;
   if (!id || id !== 'page' && !roots().some(root => root.contains(target))) return;
   pending[id] = { scrollTop: target.scrollTop, scrollLeft: target.scrollLeft };
   if (!frame) frame = requestAnimationFrame(() => { frame = 0; flushScroll(); });
  };
  const onFocus = (event: FocusEvent) => { const node = event.target as HTMLElement; if (roots().some(root => root.contains(node))) { focus = focusId(node); if (!applying) { restoring = false; remember(); } } };
  const saved = workspaceManager.get<ViewPosition | undefined>(key, 'position', undefined);
  const restore = () => {
   applying = true;
   restoreCards();
   if (saved) restorePosition(saved, nodes(), id => {
    const node = roots().flatMap(root => [...root.querySelectorAll<HTMLElement>('[data-focus-id],[name],[id]')]).find(node => focusId(node) === id && !node.closest('[hidden],[inert]'));
    node?.focus({ preventScroll: true });
   });
   else { const page = document.querySelector<HTMLElement>('.pc-main-scroll'); if (page) page.scrollTop = 0; const heading = roots().flatMap(root => [...root.querySelectorAll<HTMLElement>('#nt-request')])[0] ?? document.querySelector<HTMLElement>('.pc-page-head h1') ?? document.querySelector<HTMLElement>('.pc-topbar h1') ?? roots().flatMap(root => [...root.querySelectorAll<HTMLElement>('h1,h2')])[0] ?? document.getElementById('main-content'); if (heading) { if (!heading.matches('input,textarea')) heading.tabIndex = -1; heading.focus({ preventScroll: true }); } }
   applying = false;
  };
  restore();
  // Lazy content may mount after activation; retry saved geometry until it arrives, yielding immediately to input.
  const observer = new MutationObserver(() => { if (restoring) restore(); });
  const main = document.getElementById('main-content'); if (main) observer.observe(main, { childList: true, subtree: true });
  const finish = () => { restoring = false; observer.disconnect(); };
  const input = () => { finish(); remember(); };
  const timer = setTimeout(finish, 1000);
  document.addEventListener('wheel', input, true); document.addEventListener('touchstart', input, true);
  document.addEventListener('toggle', onToggle, true); document.addEventListener('scroll', onScroll, true); document.addEventListener('focusin', onFocus); document.addEventListener('pointerdown', input, true); document.addEventListener('keydown', input, true); window.addEventListener('hashchange', remember);
  return () => { finish(); cancelAnimationFrame(frame); flushScroll(); clearTimeout(timer); document.removeEventListener('wheel', input, true); document.removeEventListener('touchstart', input, true); document.removeEventListener('toggle', onToggle, true); document.removeEventListener('scroll', onScroll, true); document.removeEventListener('focusin', onFocus); document.removeEventListener('pointerdown', input, true); document.removeEventListener('keydown', input, true); window.removeEventListener('hashchange', remember); };
 }, [key, active]);
}
