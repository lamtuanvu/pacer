import { useEffect, useMemo, useState } from "preact/hooks";
import { Button, ButtonLink } from "../ds/Button";
import { Disclosure, Field, Select, TextArea, TextInput } from "../ds/Controls";
import {
  AttachmentPicker,
  AttachmentTray,
  type AttachmentItem,
} from "../ds/AttachmentTray";
import { SectionHeading } from "../ds/SectionHeading";
import { agentInfo } from "../../../src/view-model/agents";
import type { RepoRef } from "../../../src/api/read-model/types";
import type { SessionPreparation } from "../../../src/session/capabilities";
import {
  blankSession,
  sessionCreateParams,
  type SessionDraft,
} from "../model/start-session";
import {
  filesFromPaste,
  insertPastedText,
  useAttachments,
} from "../model/attachments";
import {
  ErrorMessage,
  useDraft,
  useQuery,
  useTaskContext,
} from "./task-shared";
import { handleDelegateKey } from "./Delegate";

interface FormProps {
  request: string;
  repo: string;
  repos: RepoRef[];
  preparation?: SessionPreparation;
  mode: string;
  base: string;
  checkout: string;
  executor: string;
  items: AttachmentItem[];
  busy: boolean;
  onField: (key: keyof SessionDraft, value: string) => void;
  onFiles: (files: File[]) => void;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  onSubmit: () => void;
}
export function StartSessionForm(p: FormProps) {
  const selected = p.preparation?.executors.find((e) => e.id === p.executor);
  const blocked =
    p.busy ||
    !p.request.trim() ||
    !selected?.available ||
    p.items.some((item) => item.status !== "ready");
  return (
    <form
      className="pc-start-composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (!blocked) p.onSubmit();
      }}
      onKeyDown={(event) =>
        handleDelegateKey(
          event,
          () => event.currentTarget.requestSubmit(),
          blocked,
        )
      }
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        p.onFiles(Array.from(event.dataTransfer?.files ?? []));
      }}
    >
      <Field
        label="What would you like to work on?"
        help="Start a conversation with your agent. Paste a screenshot or drop files for context."
      >
        <TextArea
          rows={7}
          required
          value={p.request}
          placeholder="Describe what you want to build, fix, or explore…"
          onInput={(event) => p.onField("request", event.currentTarget.value)}
          onPaste={(event) => {
            const files = filesFromPaste(event);
            if (files.length) {
              event.preventDefault();
              const input = event.currentTarget;
              p.onField(
                "request",
                insertPastedText(
                  input.value,
                  event.clipboardData?.getData("text/plain") ?? "",
                  input.selectionStart,
                  input.selectionEnd,
                ),
              );
              p.onFiles(files);
            }
          }}
        />
      </Field>
      <AttachmentTray
        items={p.items}
        onRemove={p.onRemove}
        onRetry={p.onRetry}
      />
      <AttachmentPicker onFiles={p.onFiles} disabled={p.busy} />
      <div className="form-row">
        <Field label="Repository">
          <Select
            required
            value={p.repo}
            onChange={(e) => p.onField("repo", e.currentTarget.value)}
          >
            <option value="">Choose a repository…</option>
            {p.repos.map((repo) => (
              <option value={repo.key} key={repo.key}>
                {repo.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Agent and account">
          <Select
            required
            value={p.executor}
            onChange={(e) => p.onField("executor", e.currentTarget.value)}
          >
            <option value="">Choose an executor…</option>
            {p.preparation?.executors.map((e) => (
              <option key={e.id} value={e.id} disabled={!e.available}>
                {agentInfo(e.agent).name} · {e.account}
                {e.available ? "" : ` · ${e.reason}`}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="form-row">
        <Field label="Workspace">
          <Select
            value={p.mode}
            onChange={(e) => p.onField("mode", e.currentTarget.value)}
          >
            <option value="new">New worktree</option>
            <option value="current">Use existing checkout</option>
          </Select>
        </Field>
        {p.mode === "new" ? (
          <Field
            label="Base branch"
            help="Your uncommitted changes stay in the original checkout."
          >
            <Select
              required
              value={p.base}
              onChange={(e) => p.onField("base", e.currentTarget.value)}
            >
              {p.preparation?.branches.map((branch) => (
                <option key={branch} value={branch}>
                  {branch}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field
            label="Existing checkout"
            help="The agent can change the files in this checkout."
          >
            <Select
              required
              value={p.checkout}
              onChange={(e) => p.onField("checkout", e.currentTarget.value)}
            >
              {p.preparation?.checkouts.map((tree) => (
                <option key={tree.path} value={tree.path}>
                  {tree.branch} · {tree.path}
                  {tree.dirty ? " · Uncommitted changes" : ""}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
      {selected && (
        <p className="muted">
          {selected.available
            ? `${agentInfo(selected.agent).name} will open in an interactive terminal. Files use the agent’s supported attachment mechanism or a labelled path reference.`
            : selected.reason}
        </p>
      )}
      <div className="row">
        <span className="muted">⌘Enter / Ctrl+Enter to start</span>
        <span className="grow" />
        <Button type="submit" variant="primary" disabled={blocked}>
          {p.busy ? "Starting…" : "Start session"}
        </Button>
      </div>
      {blocked && !p.busy && (
        <small className="muted">
          {p.items.some((i) => i.status !== "ready")
            ? "Finish or remove pending attachments to start."
            : !p.request.trim()
              ? "Enter a request to start."
              : "Choose a ready interactive executor."}
        </small>
      )}
    </form>
  );
}

export function StartSession() {
  const { api, state } = useTaskContext(),
    supported = state.features.ops.has("session.create");
  const [draft, setDraft, clearDraft] = useDraft(
      "pacer.session.draft",
      blankSession,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>();
  const [repoPath, setRepoPath] = useState("");
  const repos = useQuery<RepoRef[]>("repo.list", {});
  const preparation = useQuery<SessionPreparation>(
    supported && draft.repo ? "session.prepare" : "version.get",
    supported && draft.repo ? { repo: draft.repo } : {},
  );
  const uploads = useAttachments(api, draft.draftId, (id) =>
    setDraft((previous) => ({ ...previous, draftId: id })),
  );
  const requestId = useMemo(
    () => globalThis.crypto?.randomUUID?.() ?? "request",
    [],
  );
  useEffect(() => {
    if (!draft.repo && repos.data?.[0])
      setDraft((previous) => ({ ...previous, repo: repos.data![0]!.key }));
  }, [repos.data]);
  useEffect(() => {
    const data = preparation.data;
    if (!data?.executors) return;
    setDraft((previous) => ({
      ...previous,
      base: previous.base || data.base,
      checkout: previous.checkout || data.checkouts[0]?.path || "",
      executor: data.executors.some(
        (e) => e.id === previous.executor && e.available,
      )
        ? previous.executor
        : (data.executors.find((e) => e.available)?.id ?? ""),
    }));
  }, [preparation.data]);
  if (!supported)
    return (
      <section className="pc-notice">
        <SectionHeading>
          Interactive sessions need a newer service
        </SectionHeading>
        <p>
          Update the Pacer service to start an interactive conversation here.
        </p>
        <ButtonLink href="#/overview">Open overview</ButtonLink>
      </section>
    );
  const field = (key: keyof SessionDraft, value: string) =>
    setDraft((previous) => ({
      ...previous,
      [key]: value,
      ...(key === "repo" ? { executor: "", base: "", checkout: "" } : {}),
    }));
  const start = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const draftId = await uploads.ensureDraft();
      const params = sessionCreateParams(
        { ...draft, draftId },
        requestId,
        uploads.items.map((item) => item.id),
      );
      const result = await api.call<{ task_id: string }>(
        "session.create",
        params,
      );
      clearDraft();
      location.hash = `#/tasks/${encodeURIComponent(result.task_id)}?control=start`;
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const recent = state.snapshot?.tasks.slice(0, 6) ?? [];
  return (
    <div className="pc-start">
      <p className="pc-start-intro">
        Your agent. Your workspace. Ready when you are.
      </p>
      <StartSessionForm
        {...draft}
        repos={repos.data ?? []}
        preparation={draft.repo ? preparation.data : undefined}
        items={uploads.items}
        busy={busy}
        onField={field}
        onFiles={uploads.uploadFiles}
        onRemove={(id) => void uploads.remove(id)}
        onRetry={uploads.retry}
        onSubmit={() => void start()}
      />
      <ErrorMessage
        error={error ?? repos.error ?? preparation.error ?? uploads.error}
      />
      <Disclosure summary="Add a repository">
        <Field
          label="Repository folder"
          help="Enter the full path to an existing local Git checkout."
        >
          <TextInput
            value={repoPath}
            placeholder="/path/to/project"
            onInput={(e) => setRepoPath(e.currentTarget.value)}
          />
        </Field>
        <Button
          disabled={!repoPath.trim()}
          onClick={() => {
            void api.call<RepoRef>("repo.add", { path: repoPath }).then(
              (repo) => {
                field("repo", repo.key);
                setRepoPath("");
                repos.reload();
              },
              (e) => setError(e),
            );
          }}
        >
          Add repository
        </Button>
      </Disclosure>
      {!!recent.length && (
        <section>
          <SectionHeading>Recent work</SectionHeading>
          <div className="pc-start-recent">
            {recent.map((task) => (
              <ButtonLink
                key={task.id}
                variant="quiet"
                href={`#/tasks/${encodeURIComponent(task.id)}`}
              >
                {task.fullTitle ?? task.title ?? task.goal}
              </ButtonLink>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
