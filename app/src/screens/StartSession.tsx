import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Button } from "../ds/Button";
import { Disclosure, Field, TextArea, TextInput } from "../ds/Controls";
import { ChoicePicker } from "../ds/ChoicePicker";
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
  /** Collapsed: only the request shows, until the composer gets focus or has text. */
  collapsed?: boolean;
  onExpand?: () => void;
}
export function StartSessionForm(p: FormProps) {
  const [attempted, setAttempted] = useState(false);
  const repoRef = useRef<HTMLButtonElement>(null);
  const executorRef = useRef<HTMLButtonElement>(null);
  const modeRef = useRef<HTMLButtonElement>(null);
  const baseRef = useRef<HTMLButtonElement>(null);
  const checkoutRef = useRef<HTMLButtonElement>(null);
  const selected = p.preparation?.executors.find((e) => e.id === p.executor);
  const repoInvalid = !p.repos.some((repo) => repo.key === p.repo);
  const executorInvalid = !selected?.available;
  const modeInvalid = p.mode !== "new" && p.mode !== "current";
  const baseInvalid = p.mode === "new" && !p.preparation?.branches.includes(p.base);
  const checkoutInvalid = p.mode === "current" && !p.preparation?.checkouts.some((tree) => tree.path === p.checkout);
  const pendingItems = p.items.some((item) => item.status !== "ready");
  const disabledSubmit = p.busy || !p.request.trim() || pendingItems;
  const blocked =
    disabledSubmit || repoInvalid || executorInvalid || modeInvalid || baseInvalid || checkoutInvalid;
  return (
    <form
      className="pc-start-composer"
      onFocusIn={p.onExpand}
      onSubmit={(event) => {
        event.preventDefault();
        if (disabledSubmit) return;
        if (repoInvalid || executorInvalid || modeInvalid || baseInvalid || checkoutInvalid) {
          setAttempted(true);
          (repoInvalid ? repoRef : executorInvalid ? executorRef : modeInvalid ? modeRef : baseInvalid ? baseRef : checkoutRef).current?.focus();
          return;
        }
        p.onSubmit();
      }}
      onKeyDown={(event) =>
        handleDelegateKey(
          event,
          () => event.currentTarget.requestSubmit(),
          disabledSubmit,
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
          rows={p.collapsed ? 2 : 7}
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
      {!p.collapsed && <>
      <AttachmentTray
        items={p.items}
        onRemove={p.onRemove}
        onRetry={p.onRetry}
      />
      <AttachmentPicker onFiles={p.onFiles} disabled={p.busy} />
      <div className="pc-start-fields">
        <Field label="Repository" error={attempted && repoInvalid ? "Choose a repository." : undefined}>
          <ChoicePicker
            ref={repoRef}
            required
            value={p.repo}
            searchable
            placeholder="Choose a repository…"
            options={p.repos.map((repo) => ({ value: repo.key, label: repo.label }))}
            onValueChange={(value) => p.onField("repo", value)}
          />
        </Field>
        <Field label="Agent and account" error={attempted && executorInvalid ? "Choose a ready interactive executor." : undefined}>
          <ChoicePicker
            ref={executorRef}
            required
            value={p.executor}
            searchable
            placeholder="Choose an executor…"
            options={p.preparation?.executors.map((e) => ({ value: e.id, agent: `${e.agent}#${e.account}`, label: `${agentInfo(e.agent).name} · ${e.account}`, disabled: !e.available, reason: e.reason })) ?? []}
            onValueChange={(value) => p.onField("executor", value)}
          />
        </Field>
      </div>
      <div className="pc-start-fields">
        <Field label="Workspace" error={attempted && modeInvalid ? "Choose a workspace." : undefined}>
          <ChoicePicker
            ref={modeRef}
            value={p.mode}
            options={[{ value: "new", label: "New worktree" }, { value: "current", label: "Use existing checkout" }]}
            onValueChange={(value) => p.onField("mode", value)}
          />
        </Field>
        {p.mode === "new" ? (
          <Field
            label="Base branch"
            help="Your uncommitted changes stay in the original checkout."
            error={attempted && baseInvalid ? "Choose a valid base branch." : undefined}
          >
            <ChoicePicker
              ref={baseRef}
              required
              value={p.base}
              placeholder="Choose a base branch…"
              options={p.preparation?.branches.map((branch) => ({ value: branch, label: branch })) ?? []}
              onValueChange={(value) => p.onField("base", value)}
            />
          </Field>
        ) : (
          <Field
            label="Existing checkout"
            help="The agent can change the files in this checkout."
            error={attempted && checkoutInvalid ? "Choose an existing checkout." : undefined}
          >
            <ChoicePicker
              ref={checkoutRef}
              required
              value={p.checkout}
              searchable
              placeholder="Choose a checkout…"
              options={p.preparation?.checkouts.map((tree) => ({ value: tree.path, label: `${tree.branch} · ${tree.path}${tree.dirty ? " · Uncommitted changes" : ""}` })) ?? []}
              onValueChange={(value) => p.onField("checkout", value)}
            />
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
        <Button type="submit" variant="primary" disabled={disabledSubmit}>
          {p.busy ? "Starting…" : "Start session"}
        </Button>
      </div>
      {blocked && !p.busy && (
        <small className="muted">
          {p.items.some((i) => i.status !== "ready")
            ? "Finish or remove pending attachments to start."
            : !p.request.trim()
              ? "Enter a request to start."
              : !p.repos.some((repo) => repo.key === p.repo)
                ? "Choose a repository."
                : (p.mode === "new" && !p.preparation?.branches.includes(p.base)) || (p.mode === "current" && !p.preparation?.checkouts.some((tree) => tree.path === p.checkout))
                  ? "Choose a valid workspace."
              : "Choose a ready interactive executor."}
        </small>
      )}
      </>}
    </form>
  );
}

/** Start work on the Dispatch home: the interactive session composer, one input row until it gets focus. */
export function StartWork() {
  const { api, state } = useTaskContext(),
    supported = state.features.ops.has("session.create");
  const [draft, setDraft, clearDraft] = useDraft(
      "pacer.session.draft",
      blankSession,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(),
    [open, setOpen] = useState(false);
  const [repoPath, setRepoPath] = useState("");
  const repos = useQuery<RepoRef[]>(supported ? "repo.list" : "version.get", {});
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
    if (supported && !draft.repo && Array.isArray(repos.data) && repos.data[0])
      setDraft((previous) => ({ ...previous, repo: repos.data![0]!.key }));
  }, [repos.data]);
  useEffect(() => {
    const data = preparation.data;
    if (!data?.executors) return;
    setDraft((previous) => ({
      ...previous,
      base: previous.base || data.base,
      checkout: previous.checkout || data.checkouts[0]?.path || "",
      executor: previous.executor || (data.executors.find((e) => e.available)?.id ?? ""),
    }));
  }, [preparation.data]);
  // An older service cannot start interactive sessions; the top bar's Delegate still works.
  if (!supported) return null;
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
      location.hash = `#/workspace?task=${encodeURIComponent(result.task_id)}&panel=session&takeover=1`;
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const expanded = open || !!draft.request.trim() || uploads.items.length > 0;
  return (
    <section className="pc-start" aria-labelledby="start-work">
      <SectionHeading id="start-work">Start work</SectionHeading>
      <StartSessionForm
        {...draft}
        repos={Array.isArray(repos.data) ? repos.data : []}
        preparation={draft.repo ? preparation.data : undefined}
        items={uploads.items}
        busy={busy}
        collapsed={!expanded}
        onExpand={() => setOpen(true)}
        onField={field}
        onFiles={uploads.uploadFiles}
        onRemove={(id) => void uploads.remove(id)}
        onRetry={uploads.retry}
        onSubmit={() => void start()}
      />
      <ErrorMessage
        error={error ?? repos.error ?? preparation.error ?? uploads.error}
      />
      {expanded && <Disclosure summary="Add a repository">
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
      </Disclosure>}
    </section>
  );
}
