import { useEffect, useState } from "preact/hooks";
import type { TaskDetail } from "../../../../src/core/task-detail";
import type { SessionInfo } from "../../../../src/session/service";
import { Button } from "../../ds/Button";
import { Alert } from "../../ds/Alert";
import { DisclosurePanel } from "../../ds/Page";
import { useAttachments } from "../../model/attachments";
import { changeConversation } from "../../model/conversation";
import { ErrorMessage, useQuery, useTaskContext } from "../task-shared";
import { SessionAttachments } from "./Attachments";
import { SessionView } from "./SessionView";

export function TerminalOpenFallback({ command }: { command: string }) {
  return (
    <Alert tone="error" title="Terminal did not open">
      <p>Run this command in your preferred terminal:</p>
      <code className="pc-code-scroll" tabIndex={0}>{command}</code>
    </Alert>
  );
}

/** Conversation actions. The task workspace header already shows title, executor and status. */
export function ConversationActions({
  active,
  busy,
  canOpen,
  canResume,
  filesOpen,
  onFiles,
  onOpen,
  onResume,
  onEnd,
}: {
  active: boolean;
  busy: boolean;
  canOpen: boolean;
  canResume: boolean;
  filesOpen: boolean;
  onFiles?: () => void;
  onOpen: () => void;
  onResume: () => void;
  onEnd: () => void;
}) {
  return (
    <div className="pc-conversation-actions" role="group" aria-label="Session actions">
      {onFiles && (
        <Button size="sm" variant="quiet" aria-expanded={filesOpen} aria-controls="conversation-files" onClick={onFiles}>
          Files
        </Button>
      )}
      {canOpen && (
        <Button size="sm" onClick={onOpen}>
          Open in terminal
        </Button>
      )}
      {canResume && (
        <Button size="sm" disabled={busy} onClick={onResume}>
          Resume conversation
        </Button>
      )}
      {active && (
        <Button size="sm" variant="danger" disabled={busy} onClick={onEnd}>
          {busy ? "Ending…" : "End session"}
        </Button>
      )}
    </div>
  );
}
export function Conversation({
  task,
  session,
  onReload,
}: {
  task: TaskDetail;
  session?: SessionInfo;
  onReload: () => void;
}) {
  const { api } = useTaskContext(),
    context = useQuery<{
      draftId: string;
      attachments: unknown[];
      rev: number;
    }>("session.context", { id: task.id });
  const [footer, setFooter] = useState<HTMLElement | null>(null),
    [filesOpen, setFilesOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(),
    [notice, setNotice] = useState("");
  const [take, setTake] = useState(
    () =>
      new URLSearchParams(location.hash.split("?")[1]).get("control") ===
      "start",
  );
  const uploads = useAttachments(api, context.data?.draftId ?? "", () => {});
  const active = ["queued", "running"].includes(task.state);
  useEffect(() => {
    if (!take) return;
    const url = new URL(location.href);
    const [path, query] = url.hash.split("?");
    const params = new URLSearchParams(query);
    params.delete("control");
    url.hash = path! + (params.size ? `?${params}` : "");
    history.replaceState(null, "", url);
  }, []);
  const end = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await changeConversation(api, task.id, "end");
      onReload();
    } catch (e) {
      setError(e);
      onReload();
    } finally {
      setBusy(false);
    }
  };
  const resume = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await changeConversation(api, task.id, "resume");
      setTake(true);
      onReload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const open = async () => {
    try {
      const result = await api.call<{ opened: boolean; command?: string }>(
        "task.attach",
        { id: task.id, target: "terminal" },
      );
      setNotice(result.opened ? "" : result.command ?? `pacer attach ${task.id}`);
    } catch (e) {
      setError(e);
    }
  };
  const repairTarget = task.executor && task.summary?.includes(`Integration ${task.executor} is not ready`)
    ? task.executor : null;
  const draftId = context.data?.draftId;
  return (
    <article className="pc-conversation" aria-label="Interactive conversation">
      <ConversationActions
        active={active}
        busy={busy}
        canOpen={!!session?.targets.includes("terminal")}
        canResume={!active && !!task.conversation?.agentSessionId}
        filesOpen={filesOpen}
        onFiles={draftId ? () => setFilesOpen((open) => !open) : undefined}
        onOpen={() => void open()}
        onResume={() => void resume()}
        onEnd={() => void end()}
      />
      <div className="pc-conversation-body">
        {task.state === "failed" && task.summary && (
          <Alert tone="error" title="Session failed">
            {repairTarget ? (
              <p>The agent integration needs repair. Preserve your customizations, then reconnect it with <code>pacer install {repairTarget}</code>.</p>
            ) : /ENOSPC|no space left on device/i.test(task.summary) ? (
              <p>Free space on this machine, then resume if available or start a new session. Your recorded output and workspace are retained.</p>
            ) : <p>The agent stopped. Open technical details for the recorded error.</p>}
            <DisclosurePanel summary="Technical details">
              <code className="pc-conversation-detail">{task.summary}</code>
            </DisclosurePanel>
          </Alert>
        )}
        {task.queue && (
          <p className="pc-session-notice muted">
            {task.queue.detail ?? "Waiting for an available execution slot."}
          </p>
        )}
        <ErrorMessage error={error ?? context.error} />
        {notice && <TerminalOpenFallback command={notice} />}
        {draftId && (
          <div id="conversation-files" className="pc-conversation-files" hidden={!filesOpen}>
            <SessionAttachments
              id={task.id}
              draftId={draftId}
              active={active}
              uploads={uploads}
            />
          </div>
        )}
        <div className="pc-conversation-session">
          <SessionView
            task={task}
            session={session}
            active={active}
            footer={footer}
            takeRequested={take}
            onTakeSent={() => setTake(false)}
            onFiles={(files) => {
              uploads.uploadFiles(files);
              setFilesOpen(true);
            }}
            onReadFile={request => api.call("session.file.read", request)}
          />
        </div>
      </div>
      <footer
        ref={setFooter}
        className="pc-conversation-footer"
        role="group"
        aria-label="Session control"
      />
    </article>
  );
}
