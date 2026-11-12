import { lstatSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import type { Ctx } from "../types";
import type { Check } from "./doctor";

const NAME = "Plugin host socket";
const PROBE_MS = 1000;

/** Mirrors the serve-side probe: only a refused or failed connect counts as stale. */
function probe(socketPath: string): Promise<"live" | "stale" | "gone"> {
  return new Promise(resolve => {
    const socket = createConnection(socketPath);
    const done = (result: "live" | "stale" | "gone") => { clearTimeout(timer); socket.destroy(); resolve(result); };
    // A full accept backlog leaves the connect pending; only a live listener does that.
    const timer = setTimeout(() => done("live"), PROBE_MS);
    socket.once("connect", () => done("live"));
    socket.once("error", (error: NodeJS.ErrnoException) => done(error.code === "ENOENT" ? "gone" : "stale"));
  });
}

function ownerPid(sidecar: string): number | null {
  try {
    const text = readFileSync(sidecar, "utf8").trim();
    return /^[1-9]\d{0,9}$/.test(text) ? Number(text) : null;
  } catch { return null; }
}

/**
 * Who holds this home's native plugin host socket (ADR 0027, OD-7). A live socket means another
 * `pacer serve` owns the home, and a second serve exits 3 until it stops. No socket, no check.
 */
export async function hostSocketCheck(ctx: Ctx): Promise<Check | null> {
  const run = join(ctx.pacerHome, "run");
  const socketPath = join(run, "host.sock");
  try {
    if (!lstatSync(socketPath).isSocket()) {
      return { name: NAME, level: "warn", detail: `${socketPath} is not a socket; pacer serve with the native plugin host refuses to replace it`,
        fix: `remove ${socketPath}` };
    }
  } catch { return null; }
  const state = await probe(socketPath);
  if (state === "gone") return null;
  if (state === "stale") return { name: NAME, level: "info", detail: `${socketPath} is stale; the next pacer serve replaces it` };
  const pid = ownerPid(join(run, "host.sock.pid"));
  return { name: NAME, level: "info",
    detail: `${socketPath} is live (owner pid ${pid ?? "unknown"}); another pacer serve on this home exits 3 until it stops. Stop the owner (pacer service stop) or wait for it to exit.` };
}
