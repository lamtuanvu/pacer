/** Draws pixel creatures, the person and the planner flag as SVG. Colours are design tokens through classes. */
import { mascotFor, MASCOT_COLUMNS, MASCOT_ROWS, PERSON_FIGURE, PLANNER_FLAG } from "./mascot";

/** Edge length of one drawn pixel for a creature `size` pixels wide. */
const px = (size: number) => size / MASCOT_COLUMNS;

function Pixels({ rows, size, cls }: { rows: readonly string[]; size: number; cls: string }) {
  const u = px(size);
  const out: preact.JSX.Element[] = [];
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      if (row[c] === "#") out.push(<rect key={`${r}:${c}`} class={cls} x={c * u} y={r * u} width={u} height={u} />);
    }
  });
  return <>{out}</>;
}

/** One executor's creature at (x, y), `size` pixels wide. `planner` adds the flag that marks the orchestrator. */
export function Creature({ identity, x, y, size, planner }: { identity: string; x: number; y: number; size: number; planner?: boolean }) {
  const m = mascotFor(identity);
  const u = px(size);
  return (
    <g transform={`translate(${x} ${y})`} aria-hidden="true">
      <Pixels rows={m.rows} size={size} cls={`lb-px-${m.tone}`} />
      {m.eyes.map(([c, r]) => <rect key={`e${c}:${r}`} class="lb-px-eye" x={c * u} y={r * u} width={u} height={u} />)}
      {planner ? (
        <g transform={`translate(${size - u} ${-(PLANNER_FLAG.length * u)})`}>
          <Pixels rows={PLANNER_FLAG} size={size} cls="lb-px-flag" />
        </g>
      ) : null}
    </g>
  );
}

/** The person: the only human figure on any board. */
export function PersonFigure({ x, y, size }: { x: number; y: number; size: number }) {
  return (
    <g transform={`translate(${x} ${y})`} aria-hidden="true">
      <Pixels rows={PERSON_FIGURE} size={size} cls="lb-px-person" />
    </g>
  );
}

/** Drawn height of a creature `size` pixels wide. */
export const creatureHeight = (size: number): number => (size * MASCOT_ROWS) / MASCOT_COLUMNS;
