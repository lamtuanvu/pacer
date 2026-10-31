const PREFLIGHT_FACTS = ["ancestor", "dirty", "dirty_files", "commits", "emails", "signoffs", "head"];

/** A failed attempt transfers only when a complete preflight reports committed work. */
export function hasCommittedWork(stdout: string): boolean {
  const facts = new Map<string, string>();
  for (const line of stdout.trimEnd().split("\n")) {
    const at = line.indexOf("=");
    if (at < 1 || facts.has(line.slice(0, at))) return false;
    facts.set(line.slice(0, at), line.slice(at + 1));
  }
  if (facts.size !== PREFLIGHT_FACTS.length || PREFLIGHT_FACTS.some(key => !facts.has(key))) return false;
  const count = facts.get("commits")!;
  return /^[1-9]\d*$/.test(count) && Number.isSafeInteger(Number(count));
}
