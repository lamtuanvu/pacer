import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// ARCH-1: the dashboard is a thin client. It reads and writes through the API client and the shared
// view model; it never imports core state, config, task or strategy modules for their values.
const ROOT = resolve(import.meta.dir, "..");
const DASHBOARD = join(ROOT, "src/dashboard");

/** Value imports allowed outside src/dashboard and src/view-model, each with the reason it is needed. */
const ALLOWED: Record<string, string> = {
  "src/api/client": "the API client",
  "src/api/protocol": "protocol constants for the in-process client",
  "src/api/ops": "the in-process client used when the service is unavailable",
  "src/api/events": "the in-process client's live snapshot",
  "src/messaging/participants": "the local human identity the in-process client acts as",
  "src/link/envelope": "the empty snapshot shown before the first read",
  "src/session/attach": "the terminal viewer for Watch here",
  "src/install/self": "the pacer argv for child CLI handoffs",
  "src/update/version": "the package version in the footer",
  "app/src/ds/tokens.json": "design tokens",
};
const ALWAYS = [/^src\/dashboard\//, /^src\/view-model\//];

const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []);

/** Relative module specifiers a file imports for their values (type-only imports are erased). */
function valueImports(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/^\s*(?:import|export)\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/gm)) {
    const clause = m[2]!.trim();
    const typeOnlyBraces = /^\{[\s\S]*\}$/.test(clause) && clause.slice(1, -1).split(",").every(n => !n.trim() || /^\s*type\s/.test(n));
    if (!m[1] && !typeOnlyBraces) found.push(m[3]!);
  }
  for (const m of source.matchAll(/(?:import\(|require\()\s*["']([^"']+)["']/g)) found.push(m[1]!);
  for (const m of source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) found.push(m[1]!);
  return found;
}

test("the import scanner treats type-only imports as erased", () => {
  expect(valueImports('import type { A } from "../x";\nimport { type B, type C } from "../y";\nimport { D, type E } from "../z";\nimport f from "../w";\nconst g = await import("../v");'))
    .toEqual(["../z", "../w", "../v"]);
});

test("src/dashboard imports only the API client, the view model and the listed helpers (ARCH-1)", () => {
  const violations: string[] = [];
  for (const file of files(DASHBOARD)) {
    for (const spec of valueImports(readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".")) continue;
      const target = relative(ROOT, resolve(dirname(file), spec)).replace(/\.(tsx?|js)$/, "");
      if (ALWAYS.some(r => r.test(target)) || target in ALLOWED) continue;
      violations.push(`${relative(ROOT, file)} imports ${target}`);
    }
  }
  expect(violations).toEqual([]);
});
