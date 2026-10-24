import { afterEach, expect, spyOn, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { buildDeterministicBrowser } from "../app/deterministic-build";

const homes: string[] = [];
function put(root: string, path: string, text: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
}
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "pacer-asset-"));
  homes.push(root);
  mkdirSync(join(root, "node_modules"), { recursive: true });
  put(root, "app/tsconfig.json", JSON.stringify({ compilerOptions: { jsx: "react-jsx", jsxImportSource: "preact" } }));
  put(root, "app/main.ts", 'export const value="original 1234567890 chunk-literal.js";');
  return root;
}
function packageAt(root: string, path: string, value: number, name = "pkg"): void {
  put(root, join(path, "package.json"), JSON.stringify({ name, exports: "./index.js", type: "module" }));
  put(root, join(path, "index.js"), `export const value=${value};`);
}
function build(root: string) {
  return buildDeterministicBrowser({
    repositoryRoot: root, entrypoints: [join(root, "app/main.ts")],
    tsconfig: join(root, "app/tsconfig.json"), splitting: true,
  });
}
async function outputs(result: Awaited<ReturnType<typeof build>>) {
  return Promise.all(result.outputs.map(async output => ({
    name: output.path.split("/").pop()!, text: await output.text(),
  })));
}
async function importedValue(code: string): Promise<unknown> {
  return (await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"))).value;
}
async function changingAfterCapture(action: () => void, check: () => Promise<void>): Promise<void> {
  const original = Bun.build.bind(Bun);
  let calls = 0;
  const spy = spyOn(Bun, "build").mockImplementation(async options => {
    const result = await original(options);
    if (++calls === 1) action();
    return result;
  });
  try { await check(); } finally { spy.mockRestore(); }
}
afterEach(() => {
  for (const root of homes.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("cross-directory output remains exact and a source edit changes it without changing arbitrary literals", async () => {
  const a = fixture(), b = fixture();
  expect(await outputs(await build(a))).toEqual(await outputs(await build(b)));
  put(b, "app/main.ts", 'export const value="changed 1234567890 chunk-literal.js";');
  const changed = await outputs(await build(b));
  expect(changed).not.toEqual(await outputs(await build(a)));
  expect(changed[0]!.text).toContain("changed 1234567890 chunk-literal.js");
});

test("dynamic imports preserve their resolved target and code splitting", async () => {
  const a = fixture(), b = fixture();
  for (const root of [a, b]) {
    put(root, "app/main.ts", 'export const load=()=>import("./lazy");');
    put(root, "app/lazy.ts", "export const value=42;");
  }
  const result = await outputs(await build(a));
  expect(result).toEqual(await outputs(await build(b)));
  expect(result).toHaveLength(2);
  expect(result.some(file => file.name.startsWith("chunk-"))).toBe(true);
});

test("nested dependency versions retain distinct identities", async () => {
  const a = fixture(), b = fixture();
  for (const root of [a, b]) {
    put(root, "app/main.ts", 'import {value as one} from "pkg";import {value as two} from "consumer";export const value=one+two;');
    packageAt(root, "node_modules/pkg", 1);
    packageAt(root, "node_modules/consumer", 0, "consumer");
    put(root, "node_modules/consumer/index.js", 'export {value} from "pkg";');
    packageAt(root, "node_modules/consumer/node_modules/pkg", 8);
  }
  const result = await outputs(await build(a));
  expect(result).toEqual(await outputs(await build(b)));
  expect(await importedValue(result[0]!.text)).toBe(9);
});

test("CSS imported as text retains literal bytes and native loader semantics", async () => {
  const root = fixture();
  put(root, "app/main.ts", 'import css from "./style.css" with {type:"text"};export {css};');
  const css = '.literal::after { content: "1234567890 chunk-literal.js"; }';
  put(root, "app/style.css", css);
  const result = await outputs(await build(root));
  expect(result).toHaveLength(1);
  const module = await import("data:text/javascript;base64," + Buffer.from(result[0]!.text).toString("base64"));
  expect(module.css).toBe(css);
});

test("unsupported CSS processing is refused rather than silently converted to text", async () => {
  const root = fixture();
  put(root, "app/main.ts", 'import "./style.css";export const value=1;');
  put(root, "app/style.css", "body{color:red}");
  await expect(build(root)).rejects.toThrow();
});

test("source outside repository and dependency roots is refused", async () => {
  const root = fixture(), outside = fixture();
  put(root, "app/main.ts", `export {value} from ${JSON.stringify(join(outside, "app/main.ts"))};`);
  await expect(build(root)).rejects.toThrow("outside");
});

test("a same-size concurrent source edit cannot publish mixed snapshots", async () => {
  const root = fixture();
  await changingAfterCapture(() => {
    put(root, "app/main.ts", 'export const value="modified 1234567890 chunk-literal.js";');
  }, async () => { await expect(build(root)).rejects.toThrow("changed during build"); });
});

test("package metadata changes during native resolution are refused", async () => {
  const root = fixture();
  packageAt(root, "node_modules/pkg", 1);
  put(root, "app/main.ts", 'export {value} from "pkg";');
  await changingAfterCapture(() => {
    put(root, "node_modules/pkg/package.json", '{"name":"pkg","exports":"./other.js","type":"module"}');
  }, async () => { await expect(build(root)).rejects.toThrow("changed during build"); });
});

test("unknown import attributes fail closed", async () => {
  const root = fixture();
  put(root, "app/main.ts", 'import text from "./module.js" with {type:"text"};export {text};');
  put(root, "app/module.js", 'export default "source";');
  await expect(build(root)).rejects.toThrow();
});

test("unknown asset loaders fail closed", async () => {
  const root = fixture();
  put(root, "app/main.ts", 'import icon from "./icon.svg";export {icon};');
  put(root, "app/icon.svg", "<svg/>");
  await expect(build(root)).rejects.toThrow();
});

test("declared package symlinks retain deterministic logical identities", async () => {
  const a = fixture(), b = fixture(), external = fixture();
  packageAt(external, ".", 9);
  for (const root of [a, b]) {
    symlinkSync(external, join(root, "node_modules/pkg"));
    put(root, "app/main.ts", 'export {value} from "pkg";');
  }
  expect(await outputs(await build(a))).toEqual(await outputs(await build(b)));
});

test("ambiguous external package aliases are rejected instead of sharing an identity", async () => {
  const root = fixture(), external = fixture();
  packageAt(external, ".", 9);
  symlinkSync(external, join(root, "node_modules/one"));
  symlinkSync(external, join(root, "node_modules/two"));
  put(root, "app/main.ts", 'export {value} from "one";');
  await expect(build(root)).rejects.toThrow("identity collision");
});

test("a dependency symlink rebound during build is refused", async () => {
  const root = fixture(), a = fixture(), b = fixture();
  for (const target of [a, b]) packageAt(target, ".", 9);
  symlinkSync(a, join(root, "node_modules/pkg"));
  put(root, "app/main.ts", 'export {value} from "pkg";');
  await changingAfterCapture(() => {
    rmSync(join(root, "node_modules/pkg"));
    symlinkSync(b, join(root, "node_modules/pkg"));
  }, async () => { await expect(build(root)).rejects.toThrow(); });
});

function graphShape(result: Awaited<ReturnType<typeof build>>, root: string) {
  const graph = result.metafile!;
  function id(path: string): string {
    if (path.startsWith("pacer-app:")) return path.slice("pacer-app:".length);
    const actual = realpathSync(resolve(path));
    const dependency = actual.indexOf("/node_modules/");
    return dependency >= 0 ? actual.slice(dependency + 1) : relative(realpathSync(root), actual);
  }
  const inputs = new Map(Object.keys(graph.inputs).map(path => [path, id(path)]));
  const partitions = new Map(Object.entries(graph.outputs).map(([path, output]) => [
    path, JSON.stringify(Object.keys(output.inputs).map(input => inputs.get(input)).sort()),
  ]));
  const nodes = Object.entries(graph.inputs).map(([path, input]) => [
    inputs.get(path), input.imports.map(edge => ({
      target: inputs.get(edge.path) ?? partitions.get(edge.path) ?? edge.path,
      kind: edge.kind, original: edge.original,
      attributes: (edge as typeof edge & { with?: unknown }).with,
    })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  ]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return { nodes, partitions: [...partitions.values()].sort() };
}

// Exercises the actual app and tray with unchanged source files, not only a small surrogate.
test("the real app and tray produce identical output from two checkout directories", async () => {
  const repository = resolve(import.meta.dir, "..");
  const roots = [fixture(), fixture()];
  const results = [];
  for (const root of roots) {
    rmSync(join(root, "node_modules"), { recursive: true });
    symlinkSync(join(repository, "node_modules"), join(root, "node_modules"));
    cpSync(join(repository, "app/src"), join(root, "app/src"), { recursive: true });
    cpSync(join(repository, "src"), join(root, "src"), { recursive: true });
    for (const path of ["package.json", "tsconfig.json", "app/tsconfig.json"]) {
      cpSync(join(repository, path), join(root, path));
    }
    const entries = ["src/app.tsx", "src/term/term.tsx", "src/screens/setup/Setup.tsx", "src/shell/UpdateNotice.tsx", "src/screens/StartSession.tsx"];
    const app = await buildDeterministicBrowser({ repositoryRoot: root, entrypoints: entries.map(path => join(root, "app", path)), tsconfig: join(root, "app/tsconfig.json"), splitting: true });
    const tray = await buildDeterministicBrowser({ repositoryRoot: root, entrypoints: [join(root, "app/src/tray/main.tsx")], tsconfig: join(root, "app/tsconfig.json"), splitting: false });
    // This oracle uses the original Bun options: no helper, namespace or explicit JSX override.
    // It prevents matching helper outputs from masking a shared browser/JSX/loader change.
    if (results.length === 0) {
      const nativeApp = await Bun.build({ entrypoints: entries.map(path => join(root, "app", path)), splitting: true, naming: { entry: "[name].js", chunk: "chunk-[hash].js" }, target: "browser", minify: true, sourcemap: "none", tsconfig: join(root, "app/tsconfig.json"), metafile: true });
      const nativeTray = await Bun.build({ entrypoints: [join(root, "app/src/tray/main.tsx")], target: "browser", minify: true, sourcemap: "none", tsconfig: join(root, "app/tsconfig.json"), metafile: true });
      expect(nativeApp.success).toBe(true);
      expect(nativeTray.success).toBe(true);
      expect(graphShape(app, root)).toEqual(graphShape(nativeApp, root));
      expect(graphShape(tray, root)).toEqual(graphShape(nativeTray, root));
    }
    results.push({ app: await outputs(app), tray: await outputs(tray) });
  }
  expect(results[0]).toEqual(results[1]);
  expect(results[0]!.app).toHaveLength(13);
  expect(results[0]!.tray).toHaveLength(1);
}, 30_000);
