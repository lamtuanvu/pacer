import type { TaskDetail } from "../../../../src/core/task-detail";
import type { SessionInfo } from "../../../../src/session/service";
import { LinkedTerminal, type ReadSessionFile } from "./LinkedTerminal";
import { ReopenToUpdate } from "./ReopenToUpdate";
import { answerRestartsFor, sessionActive } from "../../term/activity";
import { markAgent } from "../../../../src/view-model/agents";

/** Picks the renderer for a live session. The built-in terminal is the only renderer today. */
export function SessionView({
  task,
  session,
  active,
  footer,
  takeRequested,
  onTakeSent,
  onFiles,
  onReadFile,
  onReopen,
  onSessionLive,
}: {
  task: TaskDetail;
  session?: SessionInfo;
  active: boolean;
  footer: HTMLElement | null;
  takeRequested: boolean;
  onTakeSent: () => void;
  onFiles: (files: File[]) => void;
  onReadFile?: ReadSessionFile;
  onReopen?: () => void;
  onSessionLive?: () => void;
}) {
  if (session?.host === "builtin")
    return (
      <div className="pc-session-view">
      {session.live && session.hostVersion && !session.hostVersion.supported && <div className="pc-session-view__notice"><ReopenToUpdate host={session.hostVersion} onReopen={onReopen} /></div>}
      <LinkedTerminal
        id={task.id}
        attempt={session.attempt ?? null}
        readFile={onReadFile}
        workspace={task.branch ?? task.repo?.label}
        agent={task.executor ? markAgent(task.executor) : undefined}
        url={session.attach.ws}
        cols={session.cols}
        rows={session.rows}
        answerRestarts={active && answerRestartsFor(task.state)} control={active && session.capabilities.control}
        resize={active && session.capabilities.resize}
        live={active && session.live}
        onLive={onSessionLive}
        controller={session.controller}
        active={sessionActive(session)}
        takeRequested={takeRequested && session.live}
        onTakeSent={onTakeSent}
        conversation
        footer={footer}
        onFiles={onFiles}
      />
      </div>
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
