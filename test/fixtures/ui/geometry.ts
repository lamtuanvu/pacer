export interface Box { x: number; y: number; width: number; height: number }
/** True when two bounding boxes share any area; touching edges do not count. */
export const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
