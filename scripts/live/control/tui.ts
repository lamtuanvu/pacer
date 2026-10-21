import { join } from "node:path";
import type { OperationContext } from "./deadline";
import { createHash } from "node:crypto";
import { sandboxEnv, type Session } from "../core";
import { ControlError, type SurfaceAdapter, type Target } from "./contract";
export function createTuiAdapter(session: Session): SurfaceAdapter {
  const pane = `pacer-live-${session.id}`;
  const target: Target = { id: "main", surface: "tui", generation: session.createdAt ?? session.id, capabilities: ["inspect", "type", "key", "capture", "resize"] };
  async function tmux(args: string[], clock?: OperationContext, mutation = false): Promise<string> {
    if (!Bun.which("tmux", { PATH: sandboxEnv(session).PATH })) throw new ControlError("observer_unavailable", "tmux is unavailable");
    clock?.check();
    const child = Bun.spawn(["tmux", ...args], { cwd: join(session.root, "repo"), env: sandboxEnv(session), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const stdout = child.stdout.getReader(), stderr = child.stderr.getReader();
    const cancel = () => {
      child.kill("SIGKILL");
      void stdout.cancel().catch(() => {}); void stderr.cancel().catch(() => {});
    };
    const read = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > 1024 * 1024) { cancel(); throw new ControlError("observer_unavailable", "tmux output exceeds limit"); }
        chunks.push(part.value);
      }
      return Buffer.concat(chunks).toString("utf8");
    };
    clock?.signal.addEventListener("abort", cancel, { once: true });
    if (clock?.signal.aborted) cancel();
    try {
      const [code, output, error] = await Promise.all([child.exited, read(stdout), read(stderr)]);
      if (clock?.signal.aborted || (clock && Date.now() >= clock.deadline_ms))
        throw new ControlError("command_timeout", "tmux operation deadline expired", mutation ? "unknown" : undefined);
      if (code) throw new ControlError("target_unavailable", error.trim(), mutation ? "unknown" : undefined);
      return output;
    } finally {
      clock?.signal.removeEventListener("abort", cancel);
      await Promise.allSettled([stdout.cancel(), stderr.cancel()]);
      stdout.releaseLock(); stderr.releaseLock();
    }
  }
  async function screen(clock?: OperationContext) { return tmux(["capture-pane", "-p", "-t", pane], clock); }
  return {
    targets: async () => [target],
    inspect: async (_target, clock) => {
      const text = await screen(clock);
      const position = (await tmux(["display-message", "-p", "-t", pane, "#{cursor_x},#{cursor_y},#{pane_pid},#{pane_id}"], clock)).trim().split(",");
      target.generation = `${session.createdAt}:${position[2]}:${position[3]}`;
      return { target, revision: createHash("sha256").update(text + position.join(",")).digest("hex").slice(0, 24), text, elements: [], truncated: false, cursor: { x: Number(position[0]), y: Number(position[1]) } };
    },
    act: async (_target, action, clock) => {
      clock?.check();
      if (action.kind === "type") await tmux(["send-keys", "-t", pane, "-l", "--", action.text!], clock, true);
      else if (action.kind === "key") await tmux(["send-keys", "-t", pane, "--", action.key!], clock, true);
      else if (action.kind === "resize") await tmux(["resize-window", "-t", pane, "-x", String(action.width), "-y", String(action.height)], clock, true);
      else throw new ControlError("unsupported_capability", action.kind, "not_delivered");
      return { delivery: "delivered" };
    },
    capture: async (_target, _mode, _captureId, clock) => ({ method: "terminal", bytes: new TextEncoder().encode(await screen(clock)), mime: "text/plain" }),
    close: async () => {},
  };
}
