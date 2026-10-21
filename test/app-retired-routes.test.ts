import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Match route literals, not API endpoints, module imports, or state directories.
const retiredRoute = /(?:["'`](?:#?\/|(?=(?:executors|accounts|hosts|strategy)\/))(?:executors|accounts|hosts|strategy)(?=[/\s?"'`$])|\/app\/#\/?(?:executors|accounts|hosts|strategy)(?=[/\s?"'`$]))/g;

test("shipped sources contain no retired UI route literals", async () => {
  const violations: string[] = [];
  for (const root of ["app/src", "src", "desktop/src-tauri/src"]) {
    for await (const file of new Bun.Glob("**/*.{ts,tsx,rs}").scan(root)) {
      const path = `${root}/${file}`;
      readFileSync(path, "utf8").split("\n").forEach((line, i) => {
        retiredRoute.lastIndex = 0;
        if (retiredRoute.test(line)) violations.push(`${path}:${i + 1}: ${line.trim()}`);
      });
    }
  }
  expect(violations).toEqual([]);
});
