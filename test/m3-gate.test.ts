import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpDir } from "./helpers";
import { collect, main, renderReport, rustNonTest, type RowId } from "../scripts/gate/m3";

function tree(files: Record<string, string>): string {
  const root = tmpDir();
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
const count = (root: string, id: RowId) => collect(root).find(row => row.id === id)!.count;

const CASES: [RowId, Record<string, string>, number][] = [
  ["selective", { "docs/testing/m2-ledger.md": "x\nSelective operations: `a.b`, `c.d`, `e`.\n" }, 3],
  ["stays_forwarded", {
    "crates/server/src/serve/mod.rs": "fn h(){ if crate::native::a_stays_forwarded(&c) || crate::native::b_stays_forwarded(&c) || crate::native::a_stays_forwarded(&c) {} }\n#[cfg(test)]\nmod tests { fn t(){ c_stays_forwarded(); } }\n",
  }, 2],
  ["proxy_forward", {
    "crates/server/src/serve/mod.rs": "proxy::forward(a);\nproxy::forward(b);\n#[cfg(test)]\n#[path = \"tests/x.rs\"]\nmod x_tests;\n",
    "crates/server/src/serve/log_sse.rs": "let r = proxy::forward(x);\n",
    "crates/server/src/serve/tests/x.rs": "proxy::forward(y);\n",
  }, 3],
  ["internal_http", { "src/serve/http.ts": 'if (p === "/_internal/a") 1; if (p === "/_internal/a") 2; if (p === "/_internal/b/c") 3;\n' }, 2],
  ["internal_stdio", { "src/api/stdio.ts": 'case "_internal.a.b": case "_internal.c": if (m === "_internal.a.b") {}\n' }, 2],
  ["stdio_ts_methods", { "src/api/stdio.ts": 'case "snapshot": {} case "subscribe": {} case "hello": {}\n' }, 2],
  ["core_bridge_sync", { "crates/core-bridge/src/a_sync.rs": "", "crates/core-bridge/src/b_sync.rs": "", "crates/core-bridge/src/lib.rs": "" }, 2],
  ["exec_core", {
    "crates/cli/src/dispatch.rs": "use crate::core_exec::exec_core;\nfn m(){ exec_core(&c, a, &e) }\n",
    "crates/cli/src/core_exec.rs": "pub fn exec_core(c: &[String]) -> ! { loop {} }\n",
  }, 1],
  ["cli_case", { "src/cli.ts": 'function f(x){ switch (x) { case "zzz": } }\nasync function main(){\n  switch (cmd) {\n    case "a": case "b":\n      break;\n    case "c": {}\n  }\n}\n' }, 3],
  ["cli_extra", {
    "src/commands/index.ts": 'import { COMMANDS as A } from "./a";\nexport const EXTRA_COMMANDS = [...A, { name: "watch", usage: "", run }];\n',
    "src/commands/a.ts": "export const COMMANDS = [{ name: \"alpha\" }, { name: 'beta' }];\n",
  }, 3],
  ["core_child_spawn", {
    "crates/server/src/serve/mod.rs": "let a = core_child::CoreChild::spawn(c);\nlet b = core_child::CoreChild::spawn_native(c);\n",
    "crates/server/src/serve/core_child.rs": "#[cfg(test)]\nmod tests {\n  fn t(){ CoreChild::spawn(x); }\n}\n",
  }, 2],
  ["bundled_ts", { "plugins/bundled.ts": '[{main:()=>import("./a")},{ main: () => import("./b") },{ executable: "x" }]\n' }, 2],
  ["app_src_imports", {
    "app/src/a.ts": 'import { x } from "../../src/view-model/words";\n',
    "app/src/b.tsx": 'type T = import("../../src/types").UsageState;\n',
    "app/src/c.ts": 'import { y } from "./a";\n',
    "app/dist/d.js": 'import { z } from "../../src/x";\n',
  }, 2],
  ["consumer_src_imports", {
    "scripts/a.ts": 'import { a } from "../src/a";\n',
    "conformance/b.ts": 'export * from "../src/b";\n',
    "packages/p/src/c.ts": 'import { z } from "zod";\n',
  }, 2],
  ["build_rs_src", { "crates/server/build.rs": 'let a = root.join("src/app/assets.generated.ts");\n#[path = "src/x.rs"]\nmod x;\n' }, 1],
  ["release_pacer_core", {
    "scripts/release/npm.ts": "pacer-core\nx\npacer-core pacer-core\n",
    "install.sh": "rm pacer-core\n",
    "desktop/scripts/stage-cli.sh": "cp pacer-core .\n",
  }, 4],
  ["ts_service_timers", { "src/serve/http.ts": "setInterval(a, 1); setInterval(b, 2);\nnew Worker(u);\n" }, 3],
];

for (const [id, files, expected] of CASES) {
  test(`${id} counts the positive fixture`, () => expect(count(tree(files), id)).toBe(expected));
  test(`${id} is zero on an empty tree`, () => expect(count(tree({}), id)).toBe(0));
}

test("hits carry file and 1-based line", () => {
  const root = tree({ "src/serve/http.ts": "x\nsetInterval(a, 1);\n" });
  expect(collect(root).find(r => r.id === "ts_service_timers")!.hits).toEqual([{ file: "src/serve/http.ts", line: 2, text: "setInterval(a, 1);" }]);
});

test("rustNonTest drops cfg(test) items with attributes, one-liners and blocks", () => {
  const text = "a();\n#[cfg(test)]\n#[path = \"t.rs\"]\nmod t;\nb();\n#[cfg(test)]\nmod u {\n  fn x() { y(); }\n}\nc();\n";
  expect(rustNonTest(text).split("\n").filter(Boolean)).toEqual(["a();", "b();", "c();"]);
});

test("--report exits 0, --check exits 1 on any count and 0 on an empty tree", () => {
  const dirty = tree({ "plugins/bundled.ts": "main: () => import(\"./a\")\n" });
  expect(main(["--report", "--root", dirty])).toBe(0);
  expect(main(["--check", "--root", dirty])).toBe(1);
  expect(main(["--check", "--root", tree({})])).toBe(0);
});

test("the report is a markdown table with every row", () => {
  const text = renderReport(collect(tree({})), false);
  expect(text).toContain("| Row | Count |");
  for (const [id] of CASES) expect(text).toContain(`\`${id}\``);
});
