/** Run list letters: A–Z, then AA, AB, … (bijective base-26). */

export function letterAt(index: number): string {
  if (index < 0 || !Number.isFinite(index)) throw new Error("letter index out of range");
  let i = Math.floor(index);
  let out = "";
  do {
    out = String.fromCharCode(65 + (i % 26)) + out;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return out;
}

/** Next unused letter given the set already taken (any case; compared uppercased). */
export function nextLetter(used: Iterable<string>): string {
  const taken = new Set([...used].map(l => l.toUpperCase()).filter(Boolean));
  for (let i = 0; ; i++) {
    const letter = letterAt(i);
    if (!taken.has(letter)) return letter;
  }
}

/**
 * Resolve letters for a list of runs. Rows that already have a letter keep it.
 * Letterless rows get the next free letters in createdAt, then id order.
 * Pure: does not write.
 */
export function resolveRunLetters<T extends { id: string; letter?: string | null; createdAt: number }>(
  runs: T[],
): Map<string, string> {
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const r of runs) {
    const existing = typeof r.letter === "string" ? r.letter.trim().toUpperCase() : "";
    if (existing) {
      out.set(r.id, existing);
      used.add(existing);
    }
  }
  const missing = runs
    .filter(r => !out.has(r.id))
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  for (const r of missing) {
    const letter = nextLetter(used);
    used.add(letter);
    out.set(r.id, letter);
  }
  return out;
}
