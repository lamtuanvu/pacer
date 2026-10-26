import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { BuildConfig, BuildOutput, BunPlugin, Loader } from "bun";

interface Options {
  repositoryRoot: string;
  entrypoints: string[];
  tsconfig: string;
  splitting: boolean;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}

function scriptLoader(path: string): Loader {
  const ext = extname(path);
  if (ext === ".mjs" || ext === ".cjs") return "js";
  if ([".js", ".jsx", ".ts", ".tsx", ".json"].includes(ext)) return ext.slice(1) as Loader;
  // The app imports settings.css as a string. The native graph must confirm its attribute.
  if (ext === ".css") return "text";
  throw new Error(`Unsupported app module loader: ${ext}`);
}

function signatures(build: BuildOutput): string {
  return JSON.stringify(build.outputs.map(output => [output.path, output.hash])
    .sort((a, b) => a[0]!.localeCompare(b[0]!)));
}

/** App build only: preserve native browser resolution and replace module identities, never source. */
export async function buildDeterministicBrowser(options: Options): Promise<BuildOutput> {
  const repository = realpathSync(options.repositoryRoot);
  const dependencies = realpathSync(join(repository, "node_modules"));
  const source = new Map<string, Buffer>();
  const metadata = new Map<string, Buffer>();
  const bindings = new Map<string, string>();
  const paths = new Map<string, string>();
  const dependencyPackages: { physical: string; logical: string }[] = [];

  function identity(path: string): string {
    const actual = realpathSync(path);
    let id: string;
    if (inside(dependencies, actual)) {
      // Keep every nested node_modules segment: two versions must remain two modules.
      id = "node_modules/" + relative(dependencies, actual).split("\\").join("/");
    } else if (dependencyPackages.some(pkg => inside(pkg.physical, actual))) {
      const candidates = new Set(dependencyPackages
        .filter(pkg => inside(pkg.physical, actual))
        .map(pkg => join("node_modules", pkg.logical, relative(pkg.physical, actual))
          .split("\\").join("/")));
      if (candidates.size !== 1) {
        throw new Error("Stable app module identity collision through dependency aliases");
      }
      id = [...candidates][0]!;
    } else if (inside(repository, actual)) {
      id = relative(repository, actual).split("\\").join("/");
    } else {
      throw new Error(`App module outside repository/dependency roots: ${path}`);
    }
    const previous = paths.get(id);
    if (previous && previous !== actual) throw new Error(`Stable app module identity collision: ${id}`);
    paths.set(id, actual);
    return id;
  }

  function remember(path: string, map: Map<string, Buffer>): Buffer {
    const actual = realpathSync(path);
    const lexical = resolve(path);
    const bound = bindings.get(lexical);
    if (bound && bound !== actual) throw new Error(`App input identity changed during build: ${lexical}`);
    bindings.set(lexical, actual);
    const bytes = readFileSync(actual);
    const previous = map.get(actual);
    if (previous && !previous.equals(bytes)) throw new Error(`App input changed during build: ${actual}`);
    map.set(actual, bytes);
    return bytes;
  }

  function assertSnapshot(): void {
    for (const [path, actual] of bindings) {
      if (realpathSync(path) !== actual) throw new Error(`App input identity changed during build: ${path}`);
    }
    for (const [path, bytes] of [...source, ...metadata]) {
      if (!readFileSync(path).equals(bytes)) throw new Error(`App input changed during build: ${path}`);
    }
  }

  // Include package export/browser decisions, including declared symlinked packages.
  if (existsSync(join(repository, "package.json"))) remember(join(repository, "package.json"), metadata);
  const packages = new Bun.Glob("**/package.json").scanSync({
    cwd: dependencies, onlyFiles: true, followSymlinks: true,
  });
  for (const path of packages) {
    remember(join(dependencies, path), metadata);
    dependencyPackages.push({
      physical: realpathSync(join(dependencies, dirname(path))),
      logical: dirname(path),
    });
  }

  function compilerOptions(path: string, seen = new Set<string>()): Record<string, unknown> {
    const actual = realpathSync(path);
    if (!inside(repository, actual) || seen.has(actual)) throw new Error("Unsupported app tsconfig ancestry");
    seen.add(actual);
    const config = JSON.parse(remember(actual, metadata).toString("utf8"));
    let parent: Record<string, unknown> = {};
    if (config.extends !== undefined) {
      if (typeof config.extends !== "string" || !config.extends.startsWith(".")) {
        throw new Error("Unsupported app tsconfig extends");
      }
      parent = compilerOptions(resolve(dirname(actual), config.extends), seen);
    }
    return { ...parent, ...config.compilerOptions };
  }
  const compiler = compilerOptions(options.tsconfig);
  if (!["react-jsx", "react-jsxdev"].includes(String(compiler.jsx)) || typeof compiler.jsxImportSource !== "string") {
    throw new Error("Unsupported app JSX configuration");
  }
  // Bun's existing browser build requests preact/jsx-dev-runtime even with react-jsx.
  // Set that same default explicitly because a virtual namespace has no on-disk tsconfig.
  // The native-equivalence regression compares the unmodified build's graph/output partitions.
  const jsx: NonNullable<BuildConfig["jsx"]> = {
    runtime: "automatic", importSource: compiler.jsxImportSource, development: true,
  };
  let inputFailure: Error | undefined;
  const capture: BunPlugin = {
    name: "app-source-snapshot",
    setup(build) {
      build.onLoad({ filter: /.*/, namespace: "file" }, args => {
        try {
          identity(args.path);
          scriptLoader(args.path);
          remember(args.path, source);
          // Let the native loader honor import attributes and the physical tsconfig.
          return;
        } catch (error) {
          inputFailure = error as Error;
          throw error;
        }
      });
    },
  };
  const config: BuildConfig = {
    entrypoints: options.entrypoints,
    splitting: options.splitting,
    naming: { entry: "[name].js", chunk: "chunk-[hash].js" },
    target: "browser", minify: true, sourcemap: "none",
    tsconfig: options.tsconfig, jsx, metafile: true,
  };
  let native: BuildOutput;
  try {
    native = await Bun.build({ ...config, plugins: [capture] });
  } catch (error) {
    throw inputFailure ?? error;
  }
  if (!native.success) throw new AggregateError(native.logs, "Native app graph capture failed");
  if (!native.metafile) throw new Error("Missing app build graph");
  const graph = native.metafile;
  const nativeIds = new Map<string, string>();
  for (const path of Object.keys(graph.inputs)) {
    const actual = realpathSync(resolve(path));
    if (!source.has(actual)) throw new Error("Native app graph contains an unsnapshotted module");
    nativeIds.set(path, identity(actual));
  }
  const edges = new Map<string, string>();
  const cssText = new Set<string>();
  for (const [path, input] of Object.entries(graph.inputs)) {
    for (const edge of input.imports) {
      // Bun includes pruned/type-only placeholders without original specifiers.
      // They grant nothing: an actual resolver callback still requires a mapped edge.
      if (typeof edge.original !== "string") continue;
      const output = graph.outputs[edge.path];
      if (edge.external && !output) throw new Error("External app imports are unsupported");
      const target = nativeIds.get(edge.path)
        ?? (output?.entryPoint ? nativeIds.get(output.entryPoint) : undefined);
      if (!target) throw new Error("Unresolved native app graph edge");
      const attrs = (edge as typeof edge & { with?: Record<string, string> }).with;
      if (target.endsWith(".css")) {
        if (JSON.stringify(attrs) !== JSON.stringify({ type: "text" })) {
          throw new Error("CSS requires type:text in app build");
        }
        cssText.add(target);
      } else if (attrs && Object.keys(attrs).length) {
        throw new Error("Unsupported app import attributes");
      }
      const key = JSON.stringify([nativeIds.get(path), edge.kind, edge.original]);
      const previous = edges.get(key);
      if (previous && previous !== target) throw new Error("Conflicting native app resolution");
      edges.set(key, target);
    }
  }
  for (const path of source.keys()) {
    const id = identity(path);
    if (id.endsWith(".css") && !cssText.has(id)) throw new Error("CSS requires type:text in app build");
  }
  const stable: BunPlugin = {
    name: "app-stable-module-identities",
    setup(build) {
      build.onResolve({ filter: /.*/ }, args => {
        const id = !args.importer ? args.path : edges.get(JSON.stringify([args.importer, args.kind, args.path]));
        if (!id || !paths.has(id)) throw new Error(`Import absent from native app graph: ${args.path}`);
        return { path: id, namespace: "pacer-app" };
      });
      build.onLoad({ filter: /.*/, namespace: "pacer-app" }, args => {
        const path = paths.get(args.path);
        if (!path || !source.has(path)) throw new Error("Unsnapshotted app module");
        return { contents: source.get(path)!, loader: scriptLoader(path) };
      });
    },
  };
  const result = await Bun.build({
    ...config, entrypoints: options.entrypoints.map(identity), plugins: [stable],
  });
  if (!result.success) throw new AggregateError(result.logs, "Stable app build failed");
  assertSnapshot();

  // Verify native browser resolution again. This also catches aliases changed after capture.
  // The filesystem is not an atomic transaction: concurrent edits are rejected, not supported.
  let verificationFailure: Error | undefined;
  const verify: BunPlugin = {
    name: "app-snapshot-verification",
    setup(build) {
      build.onLoad({ filter: /.*/, namespace: "file" }, args => {
        const actual = realpathSync(args.path);
        const bytes = source.get(actual);
        if (!bytes || !readFileSync(actual).equals(bytes)) {
          verificationFailure = new Error(`App input changed during build: ${args.path}`);
          throw verificationFailure;
        }
      });
    },
  };
  let replay: BuildOutput;
  try {
    replay = await Bun.build({ ...config, plugins: [verify] });
  } catch (error) {
    throw verificationFailure ?? error;
  }
  if (!replay.success) throw new AggregateError(replay.logs, "App snapshot verification failed");
  if (signatures(native) !== signatures(replay)) throw new Error("App resolution changed during build");
  assertSnapshot();
  return result;
}
