import { BUNDLED } from "./bundled";

/**
 * Narrow TypeScript fallback for `pacer-core plugin run <id>`. Every shipped
 * row is now served by the Rust door; this remains only for `pacer-dev`, the
 * workflow-frame plugin that has no native port yet (out of scope for M3 C13).
 * Serves a bundled plugin on this process's stdio. Returns the exit code.
 */
export async function runBundledPlugin(id: string, io: { stderr: (line: string) => void } = { stderr: l => process.stderr.write(`${l}\n`) }): Promise<number> {
  const bundled = BUNDLED.find(b => b.manifest.id === id);
  if (!bundled) { io.stderr(`pacer: no bundled plugin ${id}`); return 2; }
  if (!bundled.main) {
    io.stderr(bundled.executable
      ? `pacer: ${id} is a native plugin; run ${bundled.executable} next to pacer-core`
      : `pacer: bundled plugin ${id} has no TypeScript entry; use the Rust door`);
    return 2;
  }
  const { serve, stdinLines } = await import("@pacer/plugin");
  const { handlers } = await bundled.main();
  await serve({ manifest: bundled.manifest, handlers: handlers as Parameters<typeof serve>[0]["handlers"], input: stdinLines() });
  return 0;
}
