import type { ComponentChildren } from 'preact';
export const DETAIL_VIEW_CAP = 5;
export function activateView<T>(views: { key: string; route: T }[], key: string | null, route: T) {
 return key === null ? views : [...views.filter(view => view.key !== key), { key, route }].slice(-DETAIL_VIEW_CAP);
}
export function ViewVisibility({ active, children }: { active: boolean; children: ComponentChildren }) { return <div className="pc-view" hidden={!active} inert={!active ? true : undefined}>{children}</div>; }
