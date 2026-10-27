import type { ShareSegment } from "../../../src/view-model/dispatch";
import { AgentMark } from "./AgentMark";

/** Gap between segments, in viewBox units of a 100-wide bar. */
const GAP = 0.6;

/**
 * Shares of one whole as a stacked bar on the calm chart series, with a text legend in the same order.
 * The bar is one image named in words, and the legend states every name and percentage, so no share is colour alone.
 */
export function StackedShareBar({ label, segments }: { label: string; segments: ShareSegment[] }) {
  const shown = segments.filter(segment => segment.share > 0);
  if (!shown.length) return null;
  const room = 100 - GAP * (shown.length - 1), total = shown.reduce((n, s) => n + s.share, 0);
  let x = 0;
  return <div className="pc-share-bar">
    <svg className="pc-share-bar__bar" role="img" aria-label={`${label}: ${segments.map(s => `${s.label} ${s.share}%`).join(", ")}`} viewBox="0 0 100 4" preserveAspectRatio="none">
      {shown.map(segment => {
        const width = segment.share / total * room, at = x;
        x += width + GAP;
        return <rect key={segment.id} className={`pc-share-bar__seg pc-share-bar__seg--${segment.series}`} x={at} y={0} width={width} height={4} />;
      })}
    </svg>
    <ul className="pc-share-bar__legend" aria-label={`${label} by agent`}>
      {segments.map(segment => <li key={segment.id} className="pc-share-bar__item">
        <span className={`pc-share-bar__swatch pc-share-bar__seg--${segment.series}`} aria-hidden="true" />
        {segment.agent && <AgentMark agent={segment.agent} size={18} labelled={false} />}
        <span className="pc-share-bar__name" title={segment.label}>{segment.label}</span>
        <span className="pc-share-bar__detail">{segment.detail}</span>
        <span className="pc-share-bar__share">{segment.share}%</span>
      </li>)}
    </ul>
  </div>;
}
