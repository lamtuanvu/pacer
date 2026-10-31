import { useLayoutEffect, useState } from 'preact/hooks';

export type SkeletonLayout = 'task' | 'list' | 'settings' | 'dashboard' | 'rows';
export const SKELETON_DELAY = 150;
const four = [0, 1, 2, 3];
function Block({ kind = 'line' }: { kind?: string }) {
  return <span className={`pc-skeleton__block pc-skeleton__block--${kind}`} />;
}
function Rows() {
  return <div className="pc-skeleton__rows">{four.map(i => <div key={i} className={`pc-skeleton__row pc-skeleton__row--${i}`}>
    <Block kind="circle" /><div className="pc-skeleton__lines"><Block /><Block kind="secondary" /></div><Block kind="time" />
  </div>)}</div>;
}
function Tiles() {
  return <div className="pc-skeleton__tiles">{four.map(i => <div key={i} className="pc-skeleton__tile"><Block kind="eyebrow" /><Block kind="value" /><Block kind="secondary" /></div>)}</div>;
}
function Header({ task = false }: { task?: boolean }) {
  return <div className="pc-skeleton__header"><div className="pc-skeleton__heading"><Block kind="title" />{task && <div className="pc-skeleton__pills"><Block kind="pill" /><Block kind="pill" /><Block kind="meta" /></div>}</div>
    <div className="pc-skeleton__buttons"><Block kind="button" />{task && <><Block kind="button-short" /><Block kind="button" /></>}</div></div>;
}
/** Page-shaped placeholders. Mount only for missing data; retain existing content during refresh. */
export function Skeleton({ layout = 'rows', label = 'Loading content' }: { layout?: SkeletonLayout; label?: string }) {
  const [visible, setVisible] = useState(false);
  useLayoutEffect(() => {
    const timer = setTimeout(() => setVisible(true), SKELETON_DELAY);
    return () => clearTimeout(timer);
  }, []);
  if (!visible) return null;
  return <div role="status" aria-busy="true" aria-label={label} className={`pc-skeleton pc-skeleton--${layout}`}>
    <div aria-hidden="true" className="pc-skeleton__shape">
      {layout === 'task' ? <>
        <Block kind="breadcrumb" /><Header task />
        <div className="pc-skeleton__card pc-skeleton__now"><Block kind="circle" /><div className="pc-skeleton__lines"><Block /><Block kind="secondary" /></div><Block kind="button" /></div>
        <Tiles />
        <div className="pc-skeleton__columns"><div className="pc-skeleton__card pc-skeleton__trace"><div className="pc-skeleton__trace-header"><Block kind="meta" /></div><Rows /></div>
          <div className="pc-skeleton__aside">{[0, 1, 2].map(i => <div key={i} className="pc-skeleton__card pc-skeleton__aside-card"><Block kind="meta" /><Block /><Block kind="secondary" /></div>)}</div></div>
      </> : layout === 'dashboard' ? <><Header /><Tiles /><div className="pc-skeleton__columns"><div className="pc-skeleton__card"><Rows /></div><div className="pc-skeleton__card"><Rows /></div></div></>
        : <>{layout !== 'rows' && <Header />}<Rows /></>}
    </div>
  </div>;
}
