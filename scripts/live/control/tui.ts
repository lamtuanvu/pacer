import { createHash } from "node:crypto";
import { run, type Session } from "../core";
import { ControlError, type SurfaceAdapter, type Target } from "./contract";
export function createTuiAdapter(session: Session): SurfaceAdapter {
  const pane = `pacer-live-${session.id}`;
  const target: Target = { id: "main", surface: "tui", generation: session.createdAt ?? session.id, capabilities: ["inspect", "type", "key", "capture", "resize"] };
  async function tmux(args: string[]): Promise<string> {
    if (!Bun.which("tmux")) throw new ControlError("observer_unavailable", "tmux is unavailable");
    const result = await run(["tmux", ...args], session, false);
    if (result.code) throw new ControlError("target_unavailable", result.stderr.trim());
    return result.stdout;
  }
  async function screen() { return tmux(["capture-pane", "-p", "-t", pane]); }
  return {
    targets: async () => [target],
    inspect: async () => {
      const text = await screen();
      const position = (await tmux(["display-message", "-p", "-t", pane, "#{cursor_x},#{cursor_y},#{pane_pid},#{pane_id}"])).trim().split(",");
      target.generation = `${session.createdAt}:${position[2]}:${position[3]}`;
      return { target, revision: createHash("sha256").update(text + position.join(",")).digest("hex").slice(0, 24), text, elements: [], truncated: false, cursor: { x: Number(position[0]), y: Number(position[1]) } };
    },
    act: async (_target, action) => {
      if (action.kind === "type") await tmux(["send-keys", "-t", pane, "-l", "--", action.text!]);
      else if (action.kind === "key") await tmux(["send-keys", "-t", pane, "--", action.key!]);
      else if (action.kind === "resize") await tmux(["resize-window", "-t", pane, "-x", String(action.width), "-y", String(action.height)]);
      else throw new ControlError("unsupported_capability", action.kind, "not_delivered");
      return { delivery: "delivered" };
    },
    capture: async () => ({ method: "terminal", bytes: new TextEncoder().encode(await screen()), mime: "text/plain" }),
    close: async () => {},
  };
}
