import type { TaskDetail } from "../../../../src/core/task-detail";
import type { SessionInfo } from "../../../../src/session/service";
import { LazyTerminal } from "../../term/LazyTerminal";

/** Picks the renderer for a live session. The built-in terminal is the only renderer today. */
export function SessionView({
  task,
  session,
  active,
  footer,
  takeRequested,
  onTakeSent,
  onFiles,
}: {
  task: TaskDetail;
  session?: SessionInfo;
  active: boolean;
  footer: HTMLElement | null;
  takeRequested: boolean;
  onTakeSent: () => void;
  onFiles: (files: File[]) => void;
}) {
  if (session?.host === "builtin")
    return (
      <LazyTerminal
        id={task.id}
        url={session.attach.ws}
        cols={session.cols}
        rows={session.rows}
        control={active && session.capabilities.control}
        resize={active && session.capabilities.resize}
        live={active && session.live}
        controller={session.controller}
        takeRequested={takeRequested && session.live}
        onTakeSent={onTakeSent}
        conversation
        footer={footer}
        onFiles={onFiles}
      />
    );
  return (
    <div className="pc-session-empty" role="status">
      {task.state === "queued"
        ? "Your session is queued. It opens when your executor is ready."
        : active
          ? "Starting the session…"
          : task.state === "failed"
            ? "No live session is available."
            : "The agent process ended. Your output and changes are retained."}
    </div>
  );
}
