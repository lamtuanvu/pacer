const PREFLIGHT_FACTS = ["ancestor", "dirty", "dirty_files", "commits", "emails", "signoffs", "head"];

function factsFrom(stdout: string): Map<string, string> | null {
  const facts = new Map<string, string>();
  for (const line of stdout.trimEnd().split("\n")) {
    const at = line.indexOf("=");
    if (at < 1 || facts.has(line.slice(0, at))) return null;
    facts.set(line.slice(0, at), line.slice(at + 1));
  }
  return facts.size === PREFLIGHT_FACTS.length && PREFLIGHT_FACTS.every(key => facts.has(key)) ? facts : null;
}

/** Only a complete fixed-script preflight can justify transfer after a failed run. */
export function hasCommittedWork(stdout: string): boolean {
  const facts = factsFrom(stdout);
  if (!facts) return false;
  const count = facts.get("commits")!;
  return /^[1-9]\d*$/.test(count) && Number.isSafeInteger(Number(count));
}

/** A no-work receipt needs every fixed fact, a clean tree and the original base head. */
export function hasNoCommittedWork(stdout: string, baseSha: string): boolean {
  const facts = factsFrom(stdout);
  return !!facts && facts.get("ancestor") === "1" && facts.get("dirty") === "0" &&
    facts.get("dirty_files") === "" && facts.get("commits") === "0" &&
    facts.get("emails") === "" && facts.get("signoffs") === "" &&
    facts.get("head") === baseSha;
}
