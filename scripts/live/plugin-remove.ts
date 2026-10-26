/** One-use D8 permission for one inert plugin in a private seeded sandbox. */
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { processIdentity, sameProcess } from "../../src/update/desktop/process-identity";
import { liveRoot, loadSession, type Session } from "./core";
import { REMOVE_FIXTURE_ENTRY, REMOVE_FIXTURE_ID, REMOVE_FIXTURE_MANIFEST } from "./seed";

const bodySchema = z.object({ id: z.literal(REMOVE_FIXTURE_ID) }).strict();

/** Reject a replacement, extra entry, symlink or hardlink before authorizing deletion. */
export function ownedRemovalTree(root: string): boolean {
  try {
    if (realpathSync(root) !== root) return false;
    const uid = process.getuid?.();
    if (uid === undefined) return false;
    const parts = [root, join(root, "home"), join(root, "home/plugins"), join(root, "home/plugins", REMOVE_FIXTURE_ID)];
    for (const path of parts) {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) return false;
    }
    const dir = parts.at(-1)!;
    const strategy = lstatSync(join(root, "home/strategy.yaml"));
    if (!strategy.isFile() || strategy.nlink !== 1 || strategy.uid !== uid || (strategy.mode & 0o077) !== 0) return false;
    // setPluginGrant/setPluginDisabled edit strategy.yaml under the `orca` lock.
    // Both paths must remain inside the sandbox before the destructive op runs.
    const lockDir = join(root, "home/orca");
    try {
      const lock = lstatSync(lockDir);
      if (!lock.isDirectory() || lock.uid !== uid || (lock.mode & 0o077) !== 0) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    if (readdirSync(dir).sort().join("\n") !== "main.ts\npacer-plugin.json") return false;
    for (const [name, content] of [["main.ts", REMOVE_FIXTURE_ENTRY], ["pacer-plugin.json", REMOVE_FIXTURE_MANIFEST]]) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o077) !== 0 || stat.size !== Buffer.byteLength(content)) return false;
      if (readFileSync(path, "utf8") !== content) return false;
    }
    return true;
  } catch { return false; }
}

export async function authorizeSeedPluginRemove(session: Session, request: Request): Promise<boolean> {
  try {
    const url = new URL(request.url);
    if (session.seed !== "plugin-remove" || session.stopped || session.root !== join(liveRoot, session.id) ||
      request.method !== "POST" || url.pathname !== "/v3/ops/plugin.remove" || url.search ||
      ![`http://127.0.0.1:${session.port}`, `http://localhost:${session.port}`].includes(request.headers.get("origin") ?? "") ||
      request.headers.get("x-pacer-client") !== "app" ||
      request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return false;

    const reader = request.clone().body?.getReader();
    if (!reader) return false;
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > 256) return false;
        chunks.push(next.value);
      }
    } finally { await reader.cancel(); }
    bodySchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));

    const recorded = loadSession(session.id);
    if (recorded.seed !== "plugin-remove" || recorded.stopped || recorded.root !== session.root ||
      recorded.port !== session.port || recorded.innerPort !== session.innerPort ||
      !sameProcess(recorded.serviceIdentity ?? null, session.serviceIdentity ?? null) ||
      !sameProcess(session.serviceIdentity ?? null, processIdentity(session.pid)) ||
      !ownedRemovalTree(session.root)) return false;

    // wx is a durable, atomic one-use claim across proxy processes. A failed or
    // uncertain forwarded request does not restore the capability.
    writeFileSync(join(session.root, "plugin-remove.claimed"), "claimed\n", { flag: "wx", mode: 0o600 });
    return true;
  } catch { return false; }
}
