export interface MarkProps { size?: number; wordmark?: boolean; tile?: boolean }
function MarkSvg({ size, onDark = false }: { size: number; onDark?: boolean }) {
  return <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" className={onDark ? "pc-mark pc-mark--on-dark" : "pc-mark"}>
    <rect className="pc-mark__lane" x="4" y="20" width="40" height="8" rx="4" />
    <rect className="pc-mark__used" x="4" y="20" width="22" height="8" rx="4" />
    <rect className="pc-mark__tick" x="29" y="12" width="4" height="24" rx="2" />
  </svg>;
}
export function Mark({ size = 24, wordmark = true, tile = false }: MarkProps) {
  if (tile) return <span className="pc-mark-tile" role="img" aria-label="pacer" style={{ "--mark-size": `${size}px` }}><MarkSvg size={size} onDark /></span>;
  if (!wordmark) return <span role="img" aria-label="pacer" className="pc-mark-only"><MarkSvg size={size} /></span>;
  return <span className="pc-lockup"><MarkSvg size={size} /><span className="pc-wordmark">pacer</span></span>;
}
