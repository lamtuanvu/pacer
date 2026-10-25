import { afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../src/types";
import { shutdownPlugins } from "../src/plugins";
const fixtures: { ctx: Ctx; server: ReturnType<typeof Bun.serve> }[] = [];
afterEach(async () => {
  for (const { ctx, server } of fixtures.splice(0)) {
    await shutdownPlugins(ctx);
    await server.stop(true);
  }
});
/** Actual pinned binaries accept only the fixture's exact --version probe. */
export function withVersionFixtures(ctx: Ctx): Ctx {
  const previous = ctx.which,
    run = ctx.run,
    selected = new Map<string, { path: string; original: string }>(),
    token = crypto.randomUUID();
  const bin = join(ctx.pacerHome, "version-fixtures");
  mkdirSync(bin, { recursive: true });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (
        request.method !== "POST" ||
        new URL(request.url).pathname !== `/${token}`
      )
        return new Response("denied", { status: 403 });
      const input = (await request.json()) as { name: string; argv: string[] };
      const chosen = selected.get(input.name);
      if (!chosen || JSON.stringify(input.argv) !== '["--version"]')
        return new Response("denied", { status: 403 });
      try {
        return Response.json(
          await run([chosen.original, "--version"], 5000, { env: ctx.env }),
        );
      } catch {
        return Response.json({
          code: 1,
          stdout: "",
          stderr: "synthetic version failure",
        });
      }
    },
  });
  for (const name of [
    "claude",
    "codex",
    "cursor-agent",
    "cursor",
    "opencode",
  ]) {
    const original = previous(name);
    if (!original) continue;
    const path = join(bin, name);
    selected.set(name, { path, original });
    writeFileSync(
      path,
      `#!${process.execPath}\nconst r=await fetch(${JSON.stringify(`http://127.0.0.1:${server.port}/${token}`)},{method:'POST',body:JSON.stringify({name:${JSON.stringify(name)},argv:process.argv.slice(2)})});if(!r.ok)process.exit(125);const v=await r.json();process.stdout.write(v.stdout);process.stderr.write(v.stderr);process.exit(v.code);`,
      { mode: 0o700 },
    );
  }
  ctx.which = (name) => selected.get(name)?.path ?? previous(name);
  fixtures.push({ ctx, server });
  return ctx;
}
