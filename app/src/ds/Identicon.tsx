/** FNV-1a over UTF-16 code units: stable across browsers and server rendering. */
function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++) {
    hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619);
  }
  return hash >>> 0;
}

export function Identicon({ seed, size = 24 }: { seed: string; size?: 16 | 24 | 32 }) {
  const hash = hashSeed(seed);
  const cells = [];
  for (let row = 0; row < 5; row++) {
    for (let column = 0; column < 3; column++) {
      if ((hash >>> (row * 3 + column)) & 1) {
        cells.push(<rect key={`${row}-${column}`} x={column} y={row} width={1} height={1} />);
        if (column < 2) cells.push(<rect key={`${row}-${4 - column}`} x={4 - column} y={row} width={1} height={1} />);
      }
    }
  }
  return <svg className={`pc-identicon pc-identicon--${size} pc-identicon--chart-${hash % 5 + 1}`}
    viewBox="0 0 5 5" aria-hidden="true" focusable="false">{cells}</svg>;
}
