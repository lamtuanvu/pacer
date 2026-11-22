#!/usr/bin/env bun
/**
 * M3 test-suite triage (slice A6).
 *
 * Classifies every code file under `test/**` (*.ts, *.tsx) into one of five
 * buckets and maps the data files (everything else under `test/`) to the code
 * files that reference them. Writes `docs/testing/m3-test-triage.md`.
 *
 * argv:
 *   (none)                       write docs/testing/m3-test-triage.md
 *   --check                      exit 1 if the generated file differs
 *   --root <dir>                 triage the given repository root
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

export type Bucket = "binary-e2e" | "src-unit" | "kept" | "parity" | "plugin";
export interface CodeInput {
  path: string;    // repository-relative path (e.g. "test/foo.test.ts")
  text: string;
  imports: string[]; // repository-relative resolved paths or bare specifiers
}
export interface CodeRow {
  path: string;
  kind: "test" | "support";
  bucket: Bucket;
  signal: "parity" | "plugin" | "e2e" | "src" | "none";
  lines: number;
  src: number;
  transitiveSrc: boolean;
  area: string;
}
export interface DataRow {
  group: string;
  files: number;
  buckets: Bucket[] | "unreferenced";
}

const CODE_SOURCE = new Set(["ts", "tsx", "mts", "mtsx"]);
const EXTENSIONS = ["ts", "tsx", "js", "jsx", "mts", "mtsx", "mjs", "json"];
const TEST_SUFFIX = /\.test\.(?:tsx?|mtsx?|jsx?)$/;

/** Exact heuristic, first match wins (A6 slice section). */
const IMPORT_RE = /(?:from\s+|import\s*\(\s*|^import\s+|^export\s+\*\s+from\s+)["']([^"']+)["']/gm;
const PARITY_IMPORTS = new Set([
  "test/parity-harness.ts",
  "test/read-model-rust-helpers.ts",
  "test/native-repo-front-door.ts",
  "test/native-plugin-door.ts",
  "test/native-plugin-ops-service.ts",
]);
const PARITY_TEXT = /PACER_TEST_NATIVE_FRONT_DOOR|PACER_TEST_FRONT_DOOR|PACER_TEST_RUST_MCP|PACER_TEST_REFERENCE_CORE/;
const E2E_SPAWN = /\b(?:Bun\.spawn(?:Sync)?|spawnSync|execFileSync|execFile|spawn|realRun)\s*\(/;
const E2E_TARGET = /(?:src\/cli\.ts|dist\/pacer\b|target\/(?:debug|release)\/pacer\b|PACER_TEST_CLI)/;
const PLUGIN_IMPORT = /^plugins\/(?!bundled\.ts)[^/"']+\//;

/** Directories whose import closure may carry `src/` references (transitive-src). */
const CLOSURE_DIRS = new Set(["test", "scripts", "app", "conformance", "packages", "plugins"]);

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}
function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function extractSpecifiers(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(text)) !== null) out.push(m[1]);
  return out;
}

/** Resolve a relative specifier to an existing repository-relative path (or the
 * normalized target when no file matches, so heuristics still see it). */
function resolveRelative(spec: string, fromRel: string, root: string): string[] {
  const base = dirname(fromRel);
  const target = join(base, spec).split("/").filter(Boolean).join("/");
  if (isFile(join(root, target))) return [target];
  for (const ext of EXTENSIONS) {
    const cand = `${target}.${ext}`;
    if (isFile(join(root, cand))) return [cand];
  }
  if (isDir(join(root, target))) {
    for (const ext of EXTENSIONS) {
      const cand = `${target}/index.${ext}`;
      if (isFile(join(root, cand))) return [cand];
    }
  }
  // No file found: keep the normalized target for heuristic matching.
  return [target];
}

/** Resolve a file's imports into repository-relative paths / bare specifiers. */
export function importsOf(path: string, text: string, root: string): string[] {
  const out: string[] = [];
  for (const spec of extractSpecifiers(text)) {
    if (spec.startsWith(".")) out.push(...resolveRelative(spec, path, root));
    else if (spec === "@pacer/plugin") out.push("packages/plugin-sdk");
    else out.push(spec); // bare specifier (node:, bun:, package names)
  }
  return out;
}

/** True if any `src/` file is reachable through the value+type import closure. */
export function hasTransitiveSrc(
  path: string,
  text: string,
  root: string,
  cache: Map<string, string>,
): boolean {
  const seen = new Set<string>();
  const stack = [...importsOf(path, text, root)];
  while (stack.length) {
    const target = stack.pop()!;
    if (seen.has(target)) continue;
    seen.add(target);
    if (target.startsWith("src/")) return true;
    const dir = target.split("/")[0];
    if (!CLOSURE_DIRS.has(dir)) continue; // bare specifier or outside closure dirs
    let body = cache.get(target);
    if (body === undefined) {
      body = isFile(join(root, target)) ? readFileSync(join(root, target), "utf8") : "";
      cache.set(target, body);
    }
    if (!body) continue;
    stack.push(...importsOf(target, body, root));
  }
  return false;
}

/** First-match-wins classifier described by the A6 slice section. */
export function classify(input: CodeInput): { bucket: Bucket; signal: CodeRow["signal"] } {
  const { path, text, imports } = input;
  if (/(?:parity|differential)/.test(basename(path))) return { bucket: "parity", signal: "parity" };
  if (imports.some((i) => PARITY_IMPORTS.has(i))) return { bucket: "parity", signal: "parity" };
  if (PARITY_TEXT.test(text)) return { bucket: "parity", signal: "parity" };
  if (imports.some((i) => PLUGIN_IMPORT.test(i))) return { bucket: "plugin", signal: "plugin" };
  if (E2E_SPAWN.test(text) && E2E_TARGET.test(text)) return { bucket: "binary-e2e", signal: "e2e" };
  if (imports.some((i) => i.startsWith("src/"))) return { bucket: "src-unit", signal: "src" };
  return { bucket: "kept", signal: "none" };
}

function walkTree(dir: string, out: string[]): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    const abs = join(dir, entry);
    if (isDir(abs)) walkTree(abs, out);
    else out.push(abs);
  }
}

function collectCodeFiles(root: string): string[] {
  const raw: string[] = [];
  walkTree(join(root, "test"), raw);
  const rel: string[] = [];
  for (const abs of raw) {
    const r = relative(root, abs);
    const ext = extname(r).slice(1);
    if (CODE_SOURCE.has(ext)) rel.push(r.split(sep).join("/"));
  }
  return rel.sort();
}

function collectDataFiles(root: string): string[] {
  const raw: string[] = [];
  walkTree(join(root, "test"), raw);
  const rel: string[] = [];
  for (const abs of raw) {
    const r = relative(root, abs);
    const ext = extname(r).slice(1);
    if (!CODE_SOURCE.has(ext)) rel.push(r.split(sep).join("/"));
  }
  return rel.sort();
}

export function triage(root: string): { code: CodeRow[]; data: DataRow[] } {
  const cache = new Map<string, string>();
  const codeFiles = collectCodeFiles(root);
  const code: CodeRow[] = [];
  const textByPath = new Map<string, string>();

  for (const path of codeFiles) {
    const text = isFile(join(root, path)) ? readFileSync(join(root, path), "utf8") : "";
    cache.set(path, text);
    textByPath.set(path, text);
    const imports = importsOf(path, text, root);
    const { bucket, signal } = classify({ path, text, imports });
    const isTest = TEST_SUFFIX.test(path);
    code.push({
      path,
      kind: isTest ? "test" : "support",
      bucket,
      signal,
      lines: text === "" ? 0 : text.split("\n").length,
      src: imports.filter((i) => i.startsWith("src/")).length,
      transitiveSrc: hasTransitiveSrc(path, text, root, cache),
      area: isTest ? basename(path).split("-")[0] : "",
    });
  }

  // ---- data grouping -----------------------------------------------------
  const dataFiles = collectDataFiles(root);
  const groups = new Map<string, string[]>();
  for (const df of dataFiles) {
    let group: string;
    if (df.startsWith("test/fixtures/")) {
      const rest = df.slice("test/fixtures/".length);
      const slash = rest.indexOf("/");
      group = slash === -1 ? `fixtures/${rest}` : `fixtures/${rest.slice(0, slash)}`;
    } else if (df.startsWith("test/__snapshots__/")) {
      group = "__snapshots__";
    } else {
      group = basename(df); // file directly under test/ root
    }
    const arr = groups.get(group) ?? [];
    arr.push(df);
    groups.set(group, arr);
  }

  const data: DataRow[] = [];
  for (const [group, files] of groups) {
    const buckets = new Set<Bucket>();
    let referenced = false;
    if (group === "__snapshots__") {
      // __snapshots__/<name>.snap -> code file test/<name>
      for (const df of files) {
        const name = basename(df).replace(/\.snap$/, "");
        const row = code.find((r) => r.path === `test/${name}` || r.path === `test/${name}.ts` || r.path === `test/${name}.tsx`);
        if (row) { referenced = true; buckets.add(row.bucket); }
      }
    } else {
      const needle = group; // "fixtures/<dir>" or a root data file's basename/group key
      for (const row of code) {
        const body = textByPath.get(row.path) ?? "";
        if (body.includes(needle)) {
          referenced = true;
          buckets.add(row.bucket);
        }
      }
    }
    data.push({ group, files: files.length, buckets: referenced ? [...buckets] : "unreferenced" });
  }
  data.sort((a, b) => a.group.localeCompare(b.group));

  return { code, data };
}

export function render(result: ReturnType<typeof triage>): string {
  const { code, data } = result;
  const distinct = new Set(code.map((c) => c.path));
  if (distinct.size !== code.length) {
    throw new Error(`test-triage: duplicate code rows (${code.length} rows, ${distinct.size} distinct files)`);
  }
  const bucketCounts = new Map<Bucket, number>();
  const bucketLines = new Map<Bucket, number>();
  for (const row of code) {
    bucketCounts.set(row.bucket, (bucketCounts.get(row.bucket) ?? 0) + 1);
    bucketLines.set(row.bucket, (bucketLines.get(row.bucket) ?? 0) + row.lines);
  }
  const tests = code.filter((c) => c.kind === "test").length;
  const support = code.filter((c) => c.kind === "support").length;

  const out: string[] = [];
  out.push(
    "# M3 Test Triage",
    "",
    "Snapshot of the Bun test tree for the M3 (Rust) migration. Every `test/**` code file",
    "(`*.ts`, `*.tsx`) is classified into exactly one bucket; data files map to the code",
    "files that reference them. Regenerate with `bun run test:triage`.",
    "",
    "## Buckets",
    "",
    "| Bucket | Meaning | Fate |",
    "|---|---|---|",
    "| `binary-e2e` | drives `pacer` as a process over the CLI, stdio or HTTP | kept; repointed to the Rust binary in D3 |",
    "| `src-unit` | imports `src/` to unit-test TypeScript behavior | deleted in the B or C slice that ports the behavior |",
    "| `kept` | tests `app/`, `packages/`, `conformance/` or `scripts/` without importing `src/` | kept |",
    "| `parity` | compares TypeScript with Rust (front-door differential, parity harness, Rust goldens) | deleted in D3; its goldens stay as Rust tests |",
    "| `plugin` | tests a bundled TS plugin under `plugins/<id>/` | moves with C13 (to `examples/plugins/<id>/` tests or deleted with the TS plugin) |",
    "",
    "## Summary",
    "",
    "| Bucket | Files | Lines |",
    "|---|---:|---:|",
  );
  for (const b of ["binary-e2e", "src-unit", "kept", "parity", "plugin"] as Bucket[]) {
    out.push(`| ${b} | ${bucketCounts.get(b) ?? 0} | ${bucketLines.get(b) ?? 0} |`);
  }
  out.push(
    "",
    `**Total: ${code.length} code files (${tests} tests + ${support} support).**`,
    "",
    "## Code files",
    "",
    "| Path | Kind | Bucket | Signal | Lines | src | transitive-src | Area |",
    "|---|---|---|---|---:|---:|---|---|",
  );
  for (const row of [...code].sort((a, b) => a.path.localeCompare(b.path))) {
    out.push(`| ${row.path} | ${row.kind} | ${row.bucket} | ${row.signal} | ${row.lines} | ${row.src} | ${row.transitiveSrc ? "yes" : "no"} | ${row.area} |`);
  }
  out.push("", "## Data files", "", "| Group | Files | Referenced by buckets |", "|---|---:|---|");
  for (const row of data) {
    const b = row.buckets === "unreferenced" ? "unreferenced" : row.buckets.join(", ");
    out.push(`| ${row.group} | ${row.files} | ${b} |`);
  }
  const unreferenced = data.filter((d) => d.buckets === "unreferenced");
  if (unreferenced.length) {
    out.push("", "## Unreferenced data", "", "| Group | Files |", "|---|---:|");
    for (const row of unreferenced) out.push(`| ${row.group} | ${row.files} |`);
  }
  out.push("");
  return out.join("\n");
}

export function main(argv: string[]): number {
  let check = false;
  let root = resolve(import.meta.dir, "..");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--check") check = true;
    else if (argv[i] === "--root" && argv[i + 1]) { root = resolve(argv[i + 1]); i++; }
    else throw new Error(`usage: bun scripts/test-triage.ts [--check] [--root <dir>]`);
  }
  const result = triage(root);
  const codeFiles = collectCodeFiles(root);
  if (result.code.length !== codeFiles.length) {
    throw new Error(`test-triage: classified ${result.code.length} files but found ${codeFiles.length} code files`);
  }
  const doc = render(result);
  const target = join(root, "docs", "testing", "m3-test-triage.md");
  if (check) {
    const existing = isFile(target) ? readFileSync(target, "utf8") : null;
    if (existing !== doc) {
      console.error(`FAIL docs/testing/m3-test-triage.md is stale; run \`bun run test:triage\`.`);
      return 1;
    }
    console.log(`test-triage: docs/testing/m3-test-triage.md is up to date (${result.code.length} code files)`);
    return 0;
  }
  writeFileSync(target, doc);
  console.log(`test-triage: wrote docs/testing/m3-test-triage.md (${result.code.length} code files, ${result.data.length} data groups)`);
  return 0;
}

if (import.meta.main) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(`FAIL test-triage: ${(error as Error).message}`); process.exitCode = 1; }
}