import { KINDS } from "../config/strategy";
import { DelegateError } from "../tasks/api";

type Kind = (typeof KINDS)[number];
const ALIASES: Readonly<Record<string, Kind>> = {
  bugfix: "debug",
  fix: "debug",
  bug: "debug",
  test: "tests",
  doc: "docs",
  perf: "performance",
};

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length];
}

export function parseDelegateKind(value: string): Kind {
  if ((KINDS as readonly string[]).includes(value)) return value as Kind;
  if (Object.hasOwn(ALIASES, value)) return ALIASES[value];
  const closest = [...KINDS].sort((a, b) => distance(value, a) - distance(value, b))[0];
  throw new DelegateError(`unknown kind "${value}" (allowed: ${KINDS.join(", ")}); did you mean "${closest}"?`);
}
