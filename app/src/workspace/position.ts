export interface ScrollPosition { scrollTop: number; scrollLeft: number }
export interface ViewPosition { scroll: Record<string, ScrollPosition>; focus?: string }
export function capturePosition(containers: [string, ScrollPosition][], focus?: string): ViewPosition {
 return { scroll: Object.fromEntries(containers.map(([key, node]) => [key, { scrollTop: node.scrollTop, scrollLeft: node.scrollLeft }])), focus };
}
export function restorePosition(saved: ViewPosition, containers: [string, ScrollPosition][], focus: (id: string) => void) {
 for (const [key, node] of containers) { const position = saved.scroll[key]; if (position) { node.scrollTop = position.scrollTop; node.scrollLeft = position.scrollLeft; } }
 if (saved.focus) focus(saved.focus);
}
