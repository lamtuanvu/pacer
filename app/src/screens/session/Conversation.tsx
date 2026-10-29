import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { TaskDetail } from "../../../../src/core/task-detail";
import type { SessionInfo } from "../../../../src/session/service";
import { Button, IconButton } from "../../ds/Button";
import { SectionHeading } from "../../ds/SectionHeading";
import { useDialogs } from "../../ds/useDialogs";
import { useMedia } from "../../shell/narrow";
import { FrameSlot } from "../../shell/slots";
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

export interface SessionSlots {
  /** Title-bar facts plus the given actions. */
  title: (actions: ComponentChildren) => ComponentChildren;
  /** Right-panel tabs with session-specific details and, for conversations, the files strip in Changes. */
  panel: (details: ComponentChildren, files?: ComponentChildren, access?: ComponentChildren) => ComponentChildren;
  /** Brings the Changes tab forward, opening the panel when it is closed. */
  showChanges: () => void;
}
export function Conversation({
  task,
  session,
  onReload,
  slots,
}: {
  task: TaskDetail;
  session?: SessionInfo;
  onReload: () => void;
  slots?: SessionSlots;
}) {
  const { api } = useTaskContext(),
    context = useQuery<{
      draftId: string;
      attachments: unknown[];
      rev: number;
    }>("session.context", { id: task.id });
  const dialogs = useDialogs();
  const [footer, setFooter] = useState<HTMLElement | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(),
    [notice, setNotice] = useState("");
  const [take, setTake] = useState(
    () =>
      new URLSearchParams(location.hash.split("?")[1]).get("control") ===
      "start",
  );
  const uploads = useAttachments(api, context.data?.draftId ?? "", () => {});
  const narrowTitle = useMedia("(width < 1000px)");
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
    if (busy || !await dialogs.confirm("End this session? The agent stops. Its output and changes are kept.", "End session", "End session")) return;
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
  return (<>
    <article className="pc-conversation" aria-label="Interactive conversation">
      {dialogs.dialog}
      <div className="pc-session-resume">{slots?.title(!active && !!task.conversation?.agentSessionId && (narrowTitle
        ? <IconButton size="sm" icon="retry" aria-label="Resume conversation" title="Resume conversation" disabled={busy} onClick={() => void resume()} />
        : <Button size="sm" disabled={busy} onClick={() => void resume()}>Resume conversation</Button>))}</div>
      <FrameSlot name="actions">{!slots && active && <IconButton size="sm" variant="quiet" tone="bad" icon="end-session" aria-label="End session" title="End session (asks to confirm)"
        busy={busy} disabled={busy} onClick={() => void end()} />}</FrameSlot>
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
              slots?.showChanges();
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
    <FrameSlot name="right">{slots?.panel(null, draftId && <section className="pc-stack pc-stack--compact"><SectionHeading as="h3">Files</SectionHeading>
      <SessionAttachments id={task.id} draftId={draftId} active={active} uploads={uploads} /></section>, session?.targets.includes("terminal") && <section className="pc-stack pc-stack--compact">
      <SectionHeading as="h3">Open elsewhere</SectionHeading>
      <div><Button size="sm" onClick={() => void open()}>Open in terminal</Button></div>
      {notice ? <TerminalOpenFallback command={notice} /> : <p className="muted">The session keeps running here, and both windows stay in sync.</p>}
    </section>)}</FrameSlot>
  </>);
}
