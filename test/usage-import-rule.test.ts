import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Import rule (ADR 0030 §6): nothing under app/ or src/view-model/ — except the one
// presentation module — reads the deprecated raw reading, imports the raw usage types,
// or defines a usage freshness constant of its own.

const ROOTS = ["app/src", "src/view-model"];
const ALLOWED = new Set(["src/view-model/usage.ts"]);

function walk(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, into);
    else if (/\.(ts|tsx)$/.test(entry)) into.push(path);
  }
  return into;
}

const files = ROOTS.flatMap(root => walk(root)).map(path => ({ path: relative(".", path).replaceAll("\\", "/"), text: readFileSync(path, "utf8") }))
  .filter(file => !/\.(test|stories)\.[tj]sx?$/.test(file.path) && !ALLOWED.has(file.path));

test("no app or view-model file reads the deprecated raw usage reading", () => {
  const offenders = files.filter(file => /\.usageReading\b|usageReading\?*:|\busageReading\b(?!\()/.test(file.text));
  expect(offenders.map(f => f.path)).toEqual([]);
});

test("no app or view-model file imports the raw usage types", () => {
  const offenders = files.filter(file =>
    /import\b[^;]*\b(UsageReading|UsageWindow)\b/.test(file.text)
    || /import type \{[^}]*\b(UsageReading|UsageWindow)\b/.test(file.text));
  expect(offenders.map(f => f.path)).toEqual([]);
});

test("usage freshness constants live only in src/usage/freshness.ts and the presentation module", () => {
  const offenders = files.filter(file =>
    // Usage staleness caps; calendar-day duration math (7 * 86400 for a week) is not a freshness rule.
    /(?:stale|historical|fresh|observedAt|capturedAt|freshness|usage)[^\n]*\b(7200|21600|86400)\b/.test(file.text)
    || /\b(7200|21600)\b/.test(file.text));
  expect(offenders.map(f => f.path)).toEqual([]);
});
