import { useEffect, useState } from "preact/hooks";
import type { TaskDetail } from "../../../../src/core/task-detail";
import type { SessionInfo } from "../../../../src/session/service";
import { taskStatus } from "../../../../src/view-model/words";
import { agentInfo } from "../../../../src/view-model/agents";
import { Button, ButtonLink } from "../../ds/Button";
import { Tabs } from "../../ds/Patterns";
import { StatusPill } from "../../ds/StatusPill";
import { SectionHeading } from "../../ds/SectionHeading";
import { LazyTerminal } from "../../term/LazyTerminal";
import { useAttachments } from "../../model/attachments";
import { changeConversation } from "../../model/conversation";
import { ErrorMessage, useQuery, useTaskContext } from "../task-shared";
import { SessionAttachments } from "./Attachments";

export function ConversationHeader({
  title,
  repo,
  branch,
  executor,
  active,
  busy,
  onEnd,
}: {
  title: string;
  repo: string;
  branch: string | null;
  executor: string;
  active: boolean;
  busy: boolean;
  onEnd: () => void;
}) {
  return (
    <header className="pc-conversation-header">
      <div className="pc-conversation-heading">
        <strong title={title}>{title}</strong>
        <span className="muted">
          {repo} · {executor}
        </span>
        {branch && (
          <code className="pc-code-scroll" tabIndex={0}>
            {branch}
          </code>
        )}
      </div>
      <ButtonLink href="#/">New session</ButtonLink>
      {active && (
        <Button disabled={busy} onClick={onEnd}>
          {busy ? "Ending…" : "End session"}
        </Button>
      )}
    </header>
  );
}
export function Conversation({
  task,
  session,
  diff,
  onReload,
}: {
  task: TaskDetail;
  session?: SessionInfo;
  diff?: { diff: string; untracked: string[] };
  onReload: () => void;
}) {
  const { api, state } = useTaskContext(),
    context = useQuery<{
      draftId: string;
      attachments: unknown[];
      rev: number;
    }>("session.context", { id: task.id });
  const [tab, setTab] = useState("terminal"),
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
      if (!result.opened)
        setNotice(result.command ?? "Open the session with pacer attach.");
    } catch (e) {
      setError(e);
    }
  };
  const executor = state.snapshot?.executors?.find(
    (e) => e.id === task.executor,
  );
  const label = executor
    ? `${agentInfo(executor.agent).name} · ${executor.account}`
    : (task.executor ?? "Executor");
  return (
    <article className="pc-conversation" aria-label="Interactive conversation">
      <ConversationHeader
        title={task.fullTitle ?? task.goal}
        repo={task.repo.label}
        branch={task.branch}
        executor={label}
        active={active}
        busy={busy}
        onEnd={() => void end()}
      />
      <div className="pc-conversation-toolbar">
        <StatusPill status={taskStatus(task)} />
        {task.queue && (
          <span className="muted">
            {task.queue.detail ?? "Waiting for an available execution slot."}
          </span>
        )}
        <span className="grow" />
        {session?.targets.includes("terminal") && (
          <Button size="sm" onClick={() => void open()}>
            Open in terminal
          </Button>
        )}
        {!active && task.conversation?.agentSessionId && (
          <Button size="sm" disabled={busy} onClick={() => void resume()}>
            Resume conversation
          </Button>
        )}
      </div>
      <Tabs
        id="conversation"
        label="Conversation views"
        value={tab}
        onChange={setTab}
        options={[
          { value: "terminal", label: "Terminal" },
          { value: "changes", label: "Changes" },
          { value: "request", label: "Request & files" },
        ]}
      />
      <ErrorMessage error={error ?? context.error} />
      <p role="status">{notice}</p>
      <div
        id="conversation-terminal-panel"
        role="tabpanel"
        aria-labelledby="conversation-terminal-tab"
        hidden={tab !== "terminal"}
        className="pc-conversation-terminal"
      >
        {session?.host === "builtin" ? (
          <LazyTerminal
            id={task.id}
            url={session.attach.ws}
            cols={session.cols}
            rows={session.rows}
            control={active && session.capabilities.control}
            resize={active && session.capabilities.resize}
            live={active && session.live}
            controller={session.controller}
            takeRequested={take && session.live}
            onTakeSent={() => setTake(false)}
            conversation
            onFiles={(files) => {
              uploads.uploadFiles(files);
              setTab("request");
            }}
          />
        ) : (
          <div className="pc-session-empty" role="status">
            {task.state === "queued"
              ? "Your session is queued. The terminal opens when your executor is ready."
              : active
                ? "Starting the agent terminal…"
                : "The agent process ended. Your output and changes are retained."}
          </div>
        )}
      </div>
      {tab === "changes" && (
        <section
          id="conversation-changes-panel"
          role="tabpanel"
          aria-labelledby="conversation-changes-tab"
        >
          <SectionHeading>Workspace changes</SectionHeading>
          <pre className="pc-code-scroll" tabIndex={0}>
            {diff ? diff.diff || "No tracked changes." : "Loading changes…"}
            {diff?.untracked.length
              ? `\nUntracked files:\n${diff.untracked.join("\n")}`
              : ""}
          </pre>
        </section>
      )}
      {tab === "request" && (
        <section
          id="conversation-request-panel"
          role="tabpanel"
          aria-labelledby="conversation-request-tab"
        >
          <SectionHeading>Original request</SectionHeading>
          <p className="pc-conversation-request">{task.brief.goal}</p>
          {context.data?.draftId && (
            <SessionAttachments
              id={task.id}
              draftId={context.data.draftId}
              active={active}
              uploads={uploads}
            />
          )}
        </section>
      )}
    </article>
  );
}
