import { createServer } from "node:net";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMcpServer } from "../../../src/mcp/server";
import type { Ctx } from "../../../src/types";
import type { SpawnRunner } from "../../../src/tasks/api";

// Exercise the real TS domain handlers without the SDK's validation/envelopes.
// Otherwise a missing Rust validator could be masked by the TS SDK validating
// the same input a second time. No captured result is replayed by this backend.
export async function domainBackend(getCtx: () => Ctx, opts: { spawnRunner?: SpawnRunner } = {}) {
  const mcp = createMcpServer(getCtx, opts);
  const tools = (mcp as unknown as { _registeredTools: Record<string, {
    handler: (args: Record<string, unknown>, extra: unknown) => Promise<{
      structuredContent?: unknown; isError?: boolean; content: Array<{ text?: string }>;
    }>;
  }> })._registeredTools;
  const dir = mkdtempSync(join(tmpdir(), "mcp-backend-"));
  chmodSync(dir, 0o700);
  const path = join(dir, "domain.sock");
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let pending = "";
    socket.on("data", data => {
      pending += data.toString();
      const end = pending.indexOf("\n");
      if (end < 0) return;
      const frame = pending.slice(0, end);
      pending = "";
      void (async () => {
        try {
          const { name, arguments: args } = JSON.parse(frame);
          const result = await tools[name].handler(args, {});
          socket.end(JSON.stringify(result.isError
            ? { error: (result.structuredContent as { error: string } | undefined)?.error ?? result.content[0]?.text }
            : { value: result.structuredContent }) + "\n");
        } catch (error) {
          socket.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + "\n");
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { chmodSync(path, 0o600); resolve(); });
  });
  return { path, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await mcp.close();
    rmSync(dir, { recursive: true, force: true });
  } };
}
