import { type Ctx } from "../types";

const MAX_BUNDLE = 50 * 1024 * 1024;

/** Keep binary Git bundle bytes outside plugin RPC; the host owns this bounded snapshot. */
export async function baseBundle(ctx: Ctx, repo: string, taskId: string, baseSha: string): Promise<Uint8Array> {
  const ref = `refs/pacer/base/${taskId}`;
  const set = await ctx.run(["git", "-C", repo, "update-ref", ref, baseSha], 10000);
  if (set.code) throw new Error(set.stderr);
  try {
    const proc = Bun.spawn(["git", "-C", repo, "bundle", "create", "-", ref], { env: ctx.env, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), 60000);
    const stderr = new Response(proc.stderr).text();
    try {
      const chunks: Uint8Array[] = []; let bytes = 0;
      for await (const chunk of proc.stdout) {
        bytes += chunk.length;
        if (bytes > MAX_BUNDLE) {
          proc.kill(); await proc.exited; await stderr;
          throw new Error("base bundle over 50 MB");
        }
        chunks.push(chunk);
      }
      const code = await proc.exited, error = await stderr;
      if (code) throw new Error(error || "base bundle failed");
      return Buffer.concat(chunks);
    } finally { clearTimeout(timer); }
  } finally {
    await ctx.run(["git", "-C", repo, "update-ref", "-d", ref], 10000);
  }
}
