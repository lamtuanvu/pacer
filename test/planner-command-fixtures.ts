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
/** Owned pinned subprocess bridge; only this fixture's Claude MCP verbs reach its existing oracle. */
export function withClaudeCommandFixture(ctx: Ctx): Ctx {
  const previous = ctx.which,
    original = previous("claude") ?? "claude",
    token = crypto.randomUUID();
  const dir = join(ctx.pacerHome, "command-fixtures");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (
        request.method !== "POST" ||
        new URL(request.url).pathname !== `/${token}`
      )
        return new Response("denied", { status: 403 });
      const body = (await request.json()) as {
        argv: string[];
        env: Record<string, string>;
      };
      if (
        body.argv[0] !== "mcp" ||
        !["get", "add", "remove"].includes(body.argv[1]!)
      )
        return new Response("denied", { status: 403 });
      return Response.json(
        await ctx.run([original, ...body.argv], 30000, { env: body.env }),
      );
    },
  });
  writeFileSync(
    path,
    `#!${process.execPath}\nconst r=await fetch(${JSON.stringify(`http://127.0.0.1:${server.port}/${token}`)},{method:'POST',body:JSON.stringify({argv:process.argv.slice(2),env:process.env})});if(!r.ok)process.exit(125);const v=await r.json();process.stdout.write(v.stdout);process.stderr.write(v.stderr);process.exit(v.code);`,
    { mode: 0o700 },
  );
  ctx.which = (name) => (name === "claude" ? path : previous(name));
  fixtures.push({ ctx, server });
  return ctx;
}
