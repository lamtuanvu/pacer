import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { Glob } from "bun";

const ROOT = resolve(import.meta.dir, "..");
const PKG = resolve(ROOT, "packages/protocol-schema");
const BARE = new Set(["zod"]);
const SPEC = /(?:from\s+|import\s*\(\s*|^import\s+|^export\s+\*\s+from\s+|^export\s+(?:type\s+)?\{[^}]*\}\s+from\s+)["']([^"']+)["']/gm;

export function offenders(pkg: string, bare: Set<string>, siblings: string[] = []): string[] {
  const bad: string[] = [];
  for (const file of new Glob("src/**/*.ts").scanSync({ cwd: pkg })) {
    const path = resolve(pkg, file);
    for (const [, spec] of readFileSync(path, "utf8").matchAll(SPEC)) {
      if (spec.startsWith(".")) {
        const target = resolve(dirname(path), spec);
        if (!target.startsWith(pkg + "/")) bad.push(`${relative(ROOT, path)} -> ${spec}`);
      } else if (!bare.has(spec) && !siblings.some(prefix => spec === prefix || spec.startsWith(prefix + "/"))) bad.push(`${relative(ROOT, path)} -> ${spec}`);
    }
  }
  return bad;
}

test("packages/protocol-schema imports only zod and its own files", () => {
  expect(existsSync(PKG)).toBe(true);
  expect(offenders(PKG, BARE)).toEqual([]);
});

test("one zod instance (G5)", () => {
  expect(existsSync(resolve(PKG, "node_modules/zod"))).toBe(false);
});

test("src shims re-export the package's class objects", async () => {
  const shim = await import("../src/core/errors");
  const pkg = await import("@pacer/protocol-schema/errors");
  expect(shim.CoreError).toBe(pkg.CoreError);
  expect((await import("../src/update/errors")).ReleaseError).toBe((await import("@pacer/protocol-schema/shared/release-error")).ReleaseError);
  expect((await import("../src/plugins/protocol")).manifestSchema).toBe((await import("@pacer/protocol-schema/plugin/protocol")).manifestSchema);
});

test("moved src files are pure shims", () => {
  const shims = ["src/plugins/protocol.ts", "src/plugins/ui-schema.ts", "src/dispatch/types.ts", "src/core/errors.ts", "src/api/errors.ts", "src/update/errors.ts",
    ...["capability", "classifier", "endpoint", "executor-orca", "executor", "executor-worktree", "host-runner", "hosts", "http", "notifier", "planner", "policy", "remote-caller", "usage", "write"].map(n => `src/plugins/${n}-protocol.ts`)];
  for (const file of shims) {
    const code = readFileSync(resolve(ROOT, file), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "").split("\n").map(l => l.trim()).filter(Boolean);
    expect({ file, extra: code.filter(l => !/^export (?:type )?(?:\*|\{[^}]*\}) from "@pacer\/protocol-schema\/[\w/-]+";$/.test(l)) }).toEqual({ file, extra: [] });
  }
});