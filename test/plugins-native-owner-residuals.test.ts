import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Pins the native process owner's remaining refusals (M3 B0b). Reads
// `src/plugins/registry.ts` as text and asserts that every
// `CoreError("plugin_unavailable", …)` whose message names the native process
// owner bridge — inside `callNativeOwner` and inside the
// `if (ctx.env.PACER_HOST_SOCKET)` block of `call` — is exactly the table
// below. This is the residual audit that gates flipping the native owner on by
// default (ADR 0027 addendum reproduces the table with its deleting slices).

const registrySource = readFileSync(
  join(dirname(import.meta.dir), "src", "plugins", "registry.ts"),
  "utf8",
);

// The five residual refusals, in the order the table lists them. Deleting
// slice: B0c (Rust issues plugin calls) or C (bundled plugins) per the ADR
// addendum; the keyless classifier residual was closed before B0b by #1192.
const residualPrefixes = [
  "needs credential bindings, which the native process owner bridge does not carry",
  "needs host-side call options the native process owner bridge does not carry",
  "needs hosts resources, which the native process owner bridge does not serve",
  "needs a staged command input, which the native process owner bridge does not carry",
  "needs a planner borrow the native process owner bridge does not carry",
] as const;

function bridgeRefusals(source: string): string[] {
  const unique = new Set<string>();
  // Every `throw new CoreError("plugin_unavailable", …)` whose message is a
  // template literal containing "the native process owner bridge". Most are
  // `` `\${method} … bridge …` ``; the planer borrow one uses `plannerBorrow`.
  const re = /throw new CoreError\("plugin_unavailable",\s*`([^`]*the native process owner bridge[^`]*)`/g;
  for (const match of source.matchAll(re)) {
    // The residual phrases follow `${method} ` (or `plannerBorrow`); strip the
    // interpolation prefix so the table lists the stable suffix.
    unique.add(match[1].replace(/^\$\{method\}\s*/, "").trim());
  }
  return [...unique].sort();
}

// The `callNativeOwner` method body (from its declaration to the next method at
// the same two-space indentation), plus every `if (ctx.env.PACER_HOST_SOCKET)`
// block in `call`. The residual refusals live only in these regions.
function ownedResidualRegions(): string {
  const start = registrySource.indexOf("private callNativeOwner");
  const end = registrySource.indexOf("\n  private ", start + 1);
  let regions = registrySource.slice(start, end);
  const re = /if \(ctx\.env\.PACER_HOST_SOCKET\) \{/g;
  for (const match of registrySource.matchAll(re)) {
    regions += "\n" + registrySource.slice(match.index, match.index + 2_000);
  }
  return regions;
}

test("the native owner's residual refusals match the pinned table", () => {
  expect(bridgeRefusals(ownedResidualRegions())).toEqual([
    ...residualPrefixes,
  ].sort());
});

test("every residual prefix is present and listed once in registry.ts", () => {
  const refusals = bridgeRefusals(registrySource);
  for (const prefix of residualPrefixes) {
    expect(refusals).toContain(prefix);
  }
  expect(refusals.length).toBe(residualPrefixes.length);
});