import { BUNDLED } from "../../plugins/bundled";

/** `pacer plugin run <id>`: serve a bundled plugin on this process's stdio. Returns the exit code. */
export async function runBundledPlugin(id: string, io: { stderr: (line: string) => void } = { stderr: l => process.stderr.write(`${l}\n`) }): Promise<number> {
  const bundled = BUNDLED.find(b => b.manifest.id === id);
  if (!bundled) { io.stderr(`pacer: no bundled plugin ${id}`); return 2; }
  const { serve, stdinLines } = await import("@pacer/plugin");
  const { handlers } = await bundled.main();
  await serve({ manifest: bundled.manifest, handlers: handlers as Parameters<typeof serve>[0]["handlers"], input: stdinLines() });
  return 0;
}
