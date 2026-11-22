#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

export type RowId =
  | "selective" | "stays_forwarded" | "proxy_forward" | "internal_http" | "internal_stdio"
  | "stdio_ts_methods" | "core_bridge_sync" | "exec_core" | "cli_case" | "cli_extra"
  | "core_child_spawn" | "bundled_ts" | "app_src_imports" | "consumer_src_imports"
  | "build_rs_src" | "release_pacer_core" | "ts_service_timers";

export interface Hit { file: string; line: number; text: string }
export interface Row { id: RowId; label: string; count: number; hits: Hit[] }

const LABELS: Record<RowId, string> = {
  selective: "docs/testing/m2-ledger.md",
  stays_forwarded: "crates/server/src/serve/mod.rs",
  proxy_forward: "crates/**/src/**/*.rs (excl. tests/)",
  internal_http: "src/serve/http.ts",
  internal_stdio: "src/api/stdio.ts",
  stdio_ts_methods: "src/api/stdio.ts",
  core_bridge_sync: "crates/core-bridge/src/",
  exec_core: "crates/cli/src/**/*.rs",
  cli_case: "src/cli.ts",
  cli_extra: "src/commands/index.ts + its ./<name> modules",
  core_child_spawn: "crates/**/src/**/*.rs",
  bundled_ts: "plugins/bundled.ts",
  app_src_imports: "app/**/*.{ts,tsx} (excl. app/dist/)",
  consumer_src_imports: "scripts/, conformance/, plugins/, packages/ *.ts",
  build_rs_src: "crates/*/build.rs",
  release_pacer_core: "release scripts and desktop build (pacer-core)",
  ts_service_timers: "src/serve/http.ts",
};

const IMPORT_SPEC_RE = /(?:from\s+|import\s*\(\s*|^import\s+|^export\s+\*\s+from\s+)["']([^"']+)["']/gm;

/** Strip `#[cfg(test)]` items (see the rule). Attribute lines after the marker are skipped,
 * then one item: a line ending in `;` or `,`, or a brace-balanced block from the first line
 * that contains `{`. */
export function rustNonTest(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*#\[cfg\(test\)\]\s*$/.test(line)) {
      let j = i + 1;
      while (j < lines.length && /^\s*#\[.*\]\s*$/.test(lines[j])) j++;
      if (j < lines.length) {
        const first = lines[j];
        if (!first.includes("{")) {
          i = j + 1;
        } else {
          let depth = 0, started = false, k = j;
          while (k < lines.length) {
            for (const ch of lines[k]) {
              if (ch === "{") { depth++; started = true; }
              else if (ch === "}") { depth--; }
            }
            if (started && depth <= 0) { k++; break; }
            k++;
          }
          i = k;
        }
      } else {
        i = j;
      }
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join("\n");
}

/** Files under `root` matching any of `patterns`, relative to `root`, sorted and de-duplicated. */
function globFiles(root: string, patterns: string[]): string[] {
  const out = new Set<string>();
  for (const pattern of patterns) {
    for (const f of new Glob(pattern).scanSync({ cwd: root })) out.add(f);
  }
  return [...out].sort();
}

function readLines(root: string, file: string): string[] {
  const p = join(root, file);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n");
}

function isTestRustPath(path: string): boolean {
  return path.split("/").includes("tests") || path.endsWith("tests.rs");
}

/** Line number (1-based) of the byte `index` inside `text`. */
function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

interface Counter {
  globs: string[]; // relative globs under root
  /** `collectNonTestRust` if true: apply rustNonTest (on the joined text) and skip test paths. */
  nonTestRust: boolean;
  excludeDist?: boolean;
  collect: (root: string, file: string, text: string) => Hit[];
}

const counters: Record<RowId, Counter> = {
  selective: {
    globs: ["docs/testing/m2-ledger.md"], nonTestRust: false,
    collect: (root, file, text) => {
      const hits: Hit[] = [];
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith("Selective operations:")) continue;
        for (const span of lines[i].matchAll(/`([^`]+)`/g)) {
          hits.push({ file, line: i + 1, text: span[1] });
        }
      }
      return hits;
    },
  },
  stays_forwarded: {
    globs: ["crates/server/src/serve/mod.rs"], nonTestRust: true,
    collect: (root, file, text) => {
      const seen = new Set<string>(); const hits: Hit[] = [];
      let m: RegExpExecArray | null;
      const re = /\b([a-z_]+_stays_forwarded)\s*\(/g;
      while ((m = re.exec(text))) {
        const name = m[1];
        if (seen.has(name)) continue;
        seen.add(name);
        hits.push({ file, line: lineOf(text, m.index), text: name });
      }
      return hits;
    },
  },
  proxy_forward: {
    globs: ["crates/**/src/**/*.rs"], nonTestRust: true,
    collect: (root, file, text) => {
      const hits: Hit[] = [];
      let m: RegExpExecArray | null;
      const re = /proxy::forward\(/g;
      while ((m = re.exec(text))) hits.push({ file, line: lineOf(text, m.index), text: m[0] });
      return hits;
    },
  },
  internal_http: {
    globs: ["src/serve/http.ts"], nonTestRust: false,
    collect: (root, file, text) => {
      const seen = new Set<string>(); const hits: Hit[] = [];
      let m: RegExpExecArray | null;
      const re = /"\/_internal\/([a-z0-9/_.-]+)"/g;
      while ((m = re.exec(text))) {
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        hits.push({ file, line: lineOf(text, m.index), text: "/_internal/" + m[1] });
      }
      return hits;
    },
  },
  internal_stdio: {
    globs: ["src/api/stdio.ts"], nonTestRust: false,
    collect: (root, file, text) => {
      const seen = new Set<string>(); const hits: Hit[] = [];
      let m: RegExpExecArray | null;
      const re = /"_internal\.([a-z0-9_.-]+)"/g;
      while ((m = re.exec(text))) {
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        hits.push({ file, line: lineOf(text, m.index), text: "_internal." + m[1] });
      }
      return hits;
    },
  },
  stdio_ts_methods: {
    globs: ["src/api/stdio.ts"], nonTestRust: false,
    collect: (root, file, text) => {
      const hits: Hit[] = [];
      let m: RegExpExecArray | null;
      const re = /case "(snapshot|subscribe)":/g;
      while ((m = re.exec(text))) hits.push({ file, line: lineOf(text, m.index), text: m[0] });
      return hits;
    },
  },
  core_bridge_sync: {
    globs: ["crates/core-bridge/src/*_sync.rs"], nonTestRust: false,
    collect: (root, file, text) => [{ file, line: 1, text: "" }],
  },
  exec_core: {
    globs: ["crates/cli/src/**/*.rs"], nonTestRust: true,
    collect: (root, file, text) => {
      const hits: Hit[] = [];
      let m: RegExpExecArray | null;
      const re = /\bexec_core\(/g;
      while ((m = re.exec(text))) {
        if (/\bfn\s*$/.test(text.slice(0, m.index))) continue;
        hits.push({ file, line: lineOf(text, m.index), text: "exec_core(" });
      }
      return hits;
    },
  },
  cli_case: {
    globs: ["src/cli.ts"], nonTestRust: false,
    collect: (root, file, text) => {
      const lines = text.split("\n");
      let start = -1;
      for (let i = 0; i < lines.length; i++) if (/^\s*switch \(cmd\) \{/.test(lines[i])) { start = i; break; }
      const hits: Hit[] = [];
      if (start < 0) return hits;
      for (let i = start + 1; i < lines.length; i++) {
        for (const m of lines[i].matchAll(/case "([^"]+)":/g)) {
          hits.push({ file, line: i + 1, text: `case "${m[1]}":` });
        }
      }
      return hits;
    },
  },
  cli_extra: {
    globs: ["src/commands/index.ts"], nonTestRust: false,
    collect: (root, file, text) => {
      const seen = new Set<string>(); const hits: Hit[] = [];
      const addName = (name: string, line: number, src: string) => {
        if (seen.has(name)) return;
        seen.add(name);
        hits.push({ file: src, line, text: name });
      };
      const files = [file];
      const im = /(?:from\s+|import\s*\(\s*|^import\s+|^export\s+\*\s+from\s+)["']\.\/([a-zA-Z0-9_-]+)["']/g;
      let m: RegExpExecArray | null;
      while ((m = im.exec(text))) files.push(join("src", "commands", m[1] + ".ts"));
      // stabilize order of extra modules
      files.sort();
      for (const f of files) {
        const lines = readLines(root, f);
        for (let i = 0; i < lines.length; i++) {
          for (const ma of lines[i].matchAll(/\bname:\s*["']([a-z][a-z0-9-]*)["']/g)) {
            addName(ma[1], i + 1, f);
          }
        }
      }
      return hits;
    },
  },
  core_child_spawn: {
    globs: ["crates/**/src/**/*.rs"], nonTestRust: true,
    collect: (root, file, text) => {
      const hits: Hit[] = [];
      let m: RegExpExecArray | null;
      const re = /CoreChild::spawn_native\(|CoreChild::spawn\(/g;
      while ((m = re.exec(text))) hits.push({ file, line: lineOf(text, m.index), text: m[0] });
      return hits;
    },
  },
  bundled_ts: {
    globs: ["plugins/bundled.ts"], nonTestRust: false,
    collect: (root, file, text) => {
      const hits: Hit[] = [];
      let m: RegExpExecArray | null;
      const re = /main:\s*\(\)\s*=>\s*import\(/g;
      while ((m = re.exec(text))) hits.push({ file, line: lineOf(text, m.index), text: m[0] });
      return hits;
    },
  },
  app_src_imports: {
    globs: ["app/**/*.{ts,tsx}"], nonTestRust: false, excludeDist: true,
    collect: (root, file, text) => {
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (/(?:from\s+|import\s*\(\s*|^import\s+|^export\s+\*\s+from\s+)["']((?:\.\.\/)+src\/)/.test(lines[i])) {
          return [{ file, line: i + 1, text: lines[i].trim() }];
        }
      }
      return [];
    },
  },
  consumer_src_imports: {
    globs: ["scripts/**/*.ts", "conformance/**/*.ts", "plugins/**/*.ts", "packages/**/*.ts"],
    nonTestRust: false,
    collect: (root, file, text) => {
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (/(?:from\s+|import\s*\(\s*|^import\s+|^export\s+\*\s+from\s+)["']((?:\.\.\/)+src\/)/.test(lines[i])) {
          return [{ file, line: i + 1, text: lines[i].trim() }];
        }
      }
      return [];
    },
  },
  build_rs_src: {
    globs: ["crates/*/build.rs"], nonTestRust: false,
    collect: (root, file, text) => {
      const hits: Hit[] = [];
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("src/") && !lines[i].trimStart().startsWith("#[path")) {
          hits.push({ file, line: i + 1, text: lines[i].trim() });
        }
      }
      return hits;
    },
  },
  release_pacer_core: {
    globs: ["scripts/release/**/*.ts", "install.sh", "desktop/scripts/*.sh", "desktop/src-tauri/tauri.conf.json", "npm/**"],
    nonTestRust: false,
    collect: (root, file, text) => {
      const hits: Hit[] = [];
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("pacer-core")) hits.push({ file, line: i + 1, text: lines[i].trim() });
      }
      return hits;
    },
  },
  ts_service_timers: {
    globs: ["src/serve/http.ts"], nonTestRust: false,
    collect: (root, file, text) => {
      const hits: Hit[] = [];
      let m: RegExpExecArray | null;
      const re = /setInterval\(|new Worker\(/g;
      while ((m = re.exec(text))) {
        const line = lineOf(text, m.index);
        const lineText = text.split("\n")[line - 1] ?? "";
        hits.push({ file, line, text: lineText.trim() });
      }
      return hits;
    },
  },
};

/** Pure apart from reading files under `root`; missing files count 0. */
export function collect(root: string): Row[] {
  return (Object.keys(counters) as RowId[]).map((id) => {
    const c = counters[id];
    const files = globFiles(root, c.globs).filter(f => {
      if (c.excludeDist && f.startsWith("app/dist/")) return false;
      if (c.nonTestRust && isTestRustPath(f)) return false;
      return true;
    });
    const hits: Hit[] = [];
    for (const f of files) {
      const text = c.nonTestRust
        ? rustNonTest(readFileSync(join(root, f), "utf8"))
        : readFileSync(join(root, f), "utf8");
      hits.push(...c.collect(root, f, text));
    }
    const row: Row = { id, label: LABELS[id], count: 0, hits: [] };
    if (id === "app_src_imports" || id === "consumer_src_imports") {
      const byFile = new Map<string, Hit>();
      for (const h of hits) if (!byFile.has(h.file)) byFile.set(h.file, h);
      row.hits = [...byFile.values()];
      row.count = row.hits.length;
    } else {
      row.hits = hits;
      row.count = hits.length;
    }
    return row;
  });
}

/** Markdown table `| Row | Count |`, then with `verbose` one `file:line  text` list per row. */
export function renderReport(rows: Row[], verbose: boolean): string {
  const out = ["| Row | Count |", "| --- | --- |"];
  for (const row of rows) out.push(`| \`${row.id}\` | ${row.count} |`);
  if (verbose) {
    for (const row of rows) {
      if (!row.hits.length) continue;
      out.push("", `### \`${row.id}\` (${row.count})`);
      for (const h of row.hits) out.push(`${h.file}:${h.line}  ${h.text}`);
    }
  }
  return out.join("\n") + "\n";
}

/** argv: `--report` (default) | `--check` | `--json`, `--verbose`, `--root <dir>`. Returns the exit code. */
export function main(argv: string[]): number {
  let mode: "report" | "check" | "json" = "report";
  let verbose = false;
  let root = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--report") mode = "report";
    else if (a === "--check") mode = "check";
    else if (a === "--json") mode = "json";
    else if (a === "--verbose") verbose = true;
    else if (a === "--root") root = argv[++i];
    else { console.error(`unknown arg: ${a}`); return 2; }
  }
  const rows = collect(root);
  if (mode === "json") {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  console.log(renderReport(rows, verbose));
  if (mode === "check") return rows.every(r => r.count === 0) ? 0 : 1;
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));