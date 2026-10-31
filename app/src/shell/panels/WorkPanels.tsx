import { StatusDot } from "../../ds/StatusDot";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import type { TaskDetail } from "../../../../src/core/task-detail";
import type { ClientSnapshot } from "../../../../src/view-model/snapshot";
import type { SurfaceInfo } from "../../../../src/plugins/registry";
import type { ViewDocument as PluginDocument } from "../../../../src/plugins/ui-schema";
import { reasonCopy } from "../../../../src/view-model/copy";
import { agentInfo, markAgent } from "../../../../src/view-model/agents";
import { executorReadiness } from "../../../../src/view-model/capacity";
import { compactCount } from "../../../../src/view-model/task-tree";
import {
  attentionStatus,
  executorLabel,
  taskStatus,
} from "../../../../src/view-model/words";
import { Icon } from "../../ds/icons";
import { AgentMark } from "../../ds/AgentMark";
import { Button, ButtonLink, IconButton, TextAction } from "../../ds/Button";
import { DensityContext } from "../../ds/Density";
import { PanelTabs } from "../../ds/PanelTabs";
import { StatusPill } from "../../ds/StatusPill";
import { UsageMeter } from "../../ds/UsageMeter";
import { useDialogs } from "../../ds/useDialogs";
import { useNavigation } from "../../navigation";
import { PluginContext } from "../../plugins/catalog";
import { confirmPluginAction, PluginError } from "../../plugins/Activity";
import { ViewDocument, type ViewAction } from "../../plugins/ViewDocument";
import {
  ErrorMessage,
  useQuery,
  useTaskContext,
} from "../../screens/task-shared";
import { withQuery, type RouteQuery } from "../../router";
import { FrameSlot, useFrame } from "../slots";
import styles from "./work-panels.css" with { type: "text" };

const styled = new WeakSet<Document>();
const panelButtonStyle = {
  width: "var(--size-24)",
  height: "var(--size-24)",
  minHeight: "var(--size-24)",
  padding: 0,
  borderRadius: "var(--radius-sm)",
};
export const panelSurfaces = (surfaces: SurfaceInfo[], task?: string) =>
  surfaces.filter(
    (surface) =>
      surface.surface === "panelTabs" &&
      (surface.context === "global" || !!task),
  );

function Agents({
  snapshot,
  query,
}: {
  snapshot: ClientSnapshot;
  query: RouteQuery;
}) {
  const executors =
    snapshot.executors?.filter((executor) => executor.rank !== "planner") ?? [];
  return (
    <div className="pc-scope-list">
      {executors.map((executor) => {
        const status = executorReadiness(executor, snapshot);
        return (
          <TextAction
            key={executor.id}
            className="pc-work-panel-row"
            href={withQuery(
              `#/settings/executors?agent=${encodeURIComponent(executor.id)}`,
              query,
            )}
            title={`${executorLabel(executor.id)} · ${status.label}`}
          >
            <AgentMark agent={executor.agent} size={18} labelled={false} />
            <span className="pc-work-panel-row__name">
              {agentInfo(executor.agent).name}
            </span>
            <StatusDot tone={status.tone} label={status.label} paired="glyph"/>
          </TextAction>
        );
      })}
      {!executors.length && (
        <p className="pc-work-panel-caption">No agents configured.</p>
      )}
    </div>
  );
}

function TaskInspector({ id, query }: { id: string; query: RouteQuery }) {
  const { state } = useTaskContext();
  const { data: task, error } = useQuery<TaskDetail>("task.get", { id });
  if (!task)
    return (
      <>
        <ErrorMessage error={state.connected ? error : undefined} />
        {!error && <p role="status">Loading task…</p>}
      </>
    );
  const attention = state.snapshot?.attention?.find(
    (item) => item.taskId === id,
  );
  const status = attention
    ? attentionStatus(attention, state.snapshot!.tasks)
    : taskStatus(state.snapshot?.tasks.find((row) => row.id === id) ?? task);
  const chosen = task.routing?.chosen ?? task.executor;
  const executor = state.snapshot?.executors?.find((row) => row.id === chosen);
  const step = task.routing?.policy?.executors.indexOf(chosen ?? "") ?? -1;
  return (
    <>
      <ErrorMessage error={state.connected ? error : undefined} />
      <section className="pc-work-panel-section">
        <strong className="pc-work-panel-title">
          {task.title || task.fullTitle || task.goal}
        </strong>
        <div className="pc-work-panel-facts">
          <StatusPill status={status} />
          <span className="pc-work-panel-caption mono">{task.repo.label}</span>
        </div>
      </section>
      <section className="pc-work-panel-card">
        <span className="pc-work-panel-label">Routed to</span>
        {chosen ? (
          <>
            <div className="pc-work-panel-facts">
              <AgentMark agent={markAgent(chosen)} size={24} labelled={false} />
              <span className="pc-work-panel-section">
                <strong>{executorLabel(chosen)}</strong>
                <span className="pc-work-panel-caption">
                  {step >= 0 && `Step ${step + 1} · `}
                  {task.routing?.why
                    ? reasonCopy(task.routing.why)
                    : "Routing reason not reported."}
                </span>
              </span>
            </div>
            {!!task.routing?.skipped.length && (
              <span className="pc-work-panel-caption">
                Skipped:{" "}
                {task.routing.skipped
                  .map(
                    (row) =>
                      `${executorLabel(row.executor)} (${reasonCopy(row.reason)})`,
                  )
                  .join(" · ")}
              </span>
            )}
          </>
        ) : (
          <span className="pc-work-panel-caption">Waiting to be routed.</span>
        )}
      </section>
      <section className="pc-work-panel-section">
        <span className="pc-work-panel-label">Tokens so far</span>
        <strong className="pc-work-panel-tokens">
          {task.tokens &&
          task.tokens.measuredAttempts + task.tokens.partialAttempts > 0
            ? `${task.tokens.lowerBound ? "≥ " : ""}${compactCount(task.tokens.total)}`
            : "—"}
        </strong>
        {executor && (
          <>
            <UsageMeter
              label={`${executorLabel(chosen)} weekly usage`}
              used={executor.usedPct}
              pace={executor.pacePct}
              tone="neutral"
              size="slim"
              text="none"
            />
            <span className="pc-work-panel-caption">
              {executor.usedPct == null
                ? "Weekly usage unknown"
                : `${Math.round(executor.usedPct)}% of week used`}
              {executor.pacePct != null && ` · pace ${Math.round(executor.pacePct)}%`}
            </span>
          </>
        )}
      </section>
      <div className="pc-work-panel-facts">
        <ButtonLink
          size="sm"
          style={{ minHeight: "var(--size-32)" }}
          href={withQuery(`#/tasks/${encodeURIComponent(id)}`, query)}
        >
          Open session
        </ButtonLink>
        {task.routing && (
          <ButtonLink
            size="sm"
            style={{ minHeight: "var(--size-32)" }}
            href={withQuery(`#/tasks/${encodeURIComponent(id)}/trace`, query)}
          >
            Dispatch trace
          </ButtonLink>
        )}
      </div>
    </>
  );
}

function PluginPanel({
  surface,
  task,
}: {
  surface: SurfaceInfo;
  task?: string;
}) {
  const { api } = useTaskContext(),
    { revision } = useContext(PluginContext),
    dialogs = useDialogs();
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () =>
      setTheme(
        document.documentElement.dataset.theme === "dark" ||
          (!document.documentElement.dataset.theme && media.matches)
          ? "dark"
          : "light",
      );
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    media.addEventListener("change", update);
    update();
    return () => {
      observer.disconnect();
      media.removeEventListener("change", update);
    };
  }, []);
  const { current: route } = useNavigation();
  const context = {
    route: route.name === "dispatch" ? "start" : "sessions",
    ...(task ? { taskId: task } : {}),
    theme,
  };
  const params = {
    plugin: surface.plugin,
    surface: "panelTab",
    id: surface.id,
    context,
  };
  const result = useQuery<{ document: PluginDocument; stale?: boolean }>(
    "plugin.ui.render",
    params,
    String(revision),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(),
    [message, setMessage] = useState("");
  const pending = useRef(false);
  const action = async (value: ViewAction) => {
    if (
      pending.current ||
      busy ||
      result.loading ||
      result.error ||
      result.data?.stale
    )
      return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      if (!(await confirmPluginAction(surface.plugin, value, dialogs.confirm)))
        return;
      const response = await api.call<{ message?: string }>(
        "plugin.ui.action",
        {
          ...params,
          action: value.action,
          requestId: crypto.randomUUID(),
          ...(value.values ? { values: value.values } : {}),
        },
      );
      setMessage(response.message ?? "Done.");
      result.reload();
    } catch (failure) {
      setError(failure);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      {dialogs.dialog}
      <ErrorMessage error={error} />
      {result.data?.stale && (
        <p role="status">
          This plugin panel is out of date.{" "}
          <Button size="sm" onClick={result.reload}>
            Retry
          </Button>
        </p>
      )}
      {result.error ? (
        <PluginError error={result.error} retry={result.reload} />
      ) : result.data ? (
        <ViewDocument
          document={result.data.document}
          onAction={action}
          busy={busy}
          disabled={result.loading || !!result.data.stale}
        />
      ) : (
        <p role="status">Loading plugin panel…</p>
      )}
      {message && <p role="status">{message}</p>}
    </>
  );
}

export function WorkPanels({
  query,
  selected,
}: {
  query: RouteQuery;
  selected?: string | null;
}) {
  const { state, api } = useTaskContext(),
    frame = useFrame(),
    { surfaces, reload } = useContext(PluginContext);
  const snapshot = state.snapshot;
  const [tab, setTab] = useState("task"),
    [adding, setAdding] = useState(false),
    [error, setError] = useState<unknown>(),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (styled.has(document)) return;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(styles);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    styled.add(document);
  }, []);
  if (!snapshot) return null;
  const scoped = snapshot.tasks.filter(
    (task) => !query.repo || task.repo?.key === query.repo,
  );
  const id =
    selected === null
      ? undefined
      : (selected ??
        scoped.find((task) => task.state === "running")?.id ??
        scoped[0]?.id);
  const recentRunning = scoped.filter(task => task.state === "running")
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
  const plugins = panelSurfaces(surfaces, id),
    visible = plugins.filter((surface) => surface.visible);
  // The current API exposes the visibility revision through a plugin's settings
  // page. A panel-only plugin has no revision read, so do not offer that write.
  const addable = plugins.filter(
    (surface) =>
      !surface.visible &&
      surfaces.some(
        (other) =>
          other.plugin === surface.plugin && other.surface === "settings",
      ),
  );
  const tabs = [
    { id: "task", label: "Task", icon:"tasks" as const },
    { id: "agents", label: "Agents", icon:"executors" as const },
    ...visible.map((surface) => ({
      id: `${surface.plugin}/${surface.id}`,
      label: `${surface.title} ·`,
    })),
  ];
  const current = tabs.some((item) => item.id === tab) ? tab : "task";
  const plugin = visible.find(
    (surface) => `${surface.plugin}/${surface.id}` === current,
  );
  const add = async (surface: SurfaceInfo) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const data = await api.call<{ rev: number }>("plugin.settings.get", {
        plugin: surface.plugin,
      });
      await api.call("plugin.ui.visibility", {
        plugin: surface.plugin,
        surface: "panelTab",
        id: surface.id,
        visible: true,
        expect_rev: data.rev,
      });
      reload();
      setAdding(false);
      setTab(`${surface.plugin}/${surface.id}`);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  return (
    <DensityContext.Provider value="settings">
      <FrameSlot name="left">
        <div className="pc-work-panel-bar">
          <span className="pc-work-panel-label">Scope</span>
          <IconButton
            id="pc-side-panel-left-toggle"
            size="sm"
            variant="quiet"
            icon="panel-left"
            style={panelButtonStyle}
            aria-label="Hide Scope"
            onClick={() => {
              frame?.sessions?.toggle();
              requestAnimationFrame(() =>
                document
                  .querySelector<HTMLElement>(
                    '[aria-label="Toggle left panel"]',
                  )
                  ?.focus(),
              );
            }}
          />
        </div>
        <h2 className="pc-scope-heading">Repositories</h2>
        <div className="pc-scope-list">
          <TextAction
            className="pc-work-panel-row"
            href={withQuery(location.hash.split("?")[0]!, {
              ...query,
              repo: null,
            })}
            aria-current={!query.repo ? "true" : undefined}
          >
            All repositories
          </TextAction>
          {snapshot.repos?.map((repo) => (
            <TextAction
              key={repo.key}
              className="pc-work-panel-row"
              href={withQuery(location.hash.split("?")[0]!, {
                ...query,
                repo: repo.key,
              })}
              aria-current={query.repo === repo.key ? "true" : undefined}
              title={repo.label}
            >
              <Icon name="repo" />
              <span className="pc-work-panel-row__name mono">{repo.label}</span>
              <span className="pc-work-panel-caption">
                {
                  snapshot.tasks.filter((task) => task.repo?.key === repo.key)
                    .length
                }
              </span>
            </TextAction>
          ))}
        </div>
        <h2 className="pc-scope-heading">Agents</h2>
        <Agents snapshot={snapshot} query={query} />
        <section className="pc-scope-plugins">
          <h2 className="pc-work-panel-label">Plugin views</h2>
          {surfaces
            .filter(
              (surface) => surface.surface === "activity" && surface.visible,
            )
            .map((surface) => (
              <TextAction
                key={`${surface.plugin}/${surface.id}`}
                href={withQuery(
                  `#/plugins/${encodeURIComponent(surface.plugin)}/${encodeURIComponent(surface.id)}`,
                  query,
                )}
              >
                {surface.title}
              </TextAction>
            ))}
          {!surfaces.some(
            (surface) => surface.surface === "activity" && surface.visible,
          ) && (
            <span className="pc-work-panel-caption">
              Plugins can add sections here, for example a repository's release
              checklist.
            </span>
          )}
        </section>
      </FrameSlot>
      <FrameSlot name="right">
        <div className="pc-work-panel-bar pc-work-panel-bar--tabs">
          <PanelTabs
            id="work-inspector"
            label="Inspector"
            tabs={tabs}
            value={current}
            onChange={setTab}
            maxVisible={3}
          />
          {addable.length > 0 &&
            state.features.ops.has("plugin.settings.get") &&
            state.features.ops.has("plugin.ui.visibility") && (
              <IconButton
                size="sm"
                variant="quiet"
                icon="plus"
                style={panelButtonStyle}
                aria-label="Add a panel from a plugin"
                aria-expanded={adding}
                onClick={() => setAdding(!adding)}
              />
            )}
          <IconButton
            size="sm"
            variant="quiet"
            icon="panel-right"
            style={panelButtonStyle}
            aria-label="Hide Inspector"
            onClick={() => {
              frame?.details?.toggle();
              requestAnimationFrame(() =>
                document
                  .querySelector<HTMLElement>('[aria-label="Toggle right panel"]')
                  ?.focus(),
              );
            }}
          />
        </div>
        {adding && (
          <div className="pc-work-panel-body">
            <span className="pc-work-panel-label">
              Add a panel from a plugin
            </span>
            {addable.map((surface) => (
              <Button
                key={`${surface.plugin}/${surface.id}`}
                size="sm"
                variant="quiet"
                busy={busy}
                onClick={() => void add(surface)}
              >
                {surface.title}
              </Button>
            ))}
          </div>
        )}
        <div
          className="pc-work-panel-body"
          role="tabpanel"
          id={`work-inspector-${current}-panel`}
          aria-labelledby={`work-inspector-${current}-tab`}
          tabIndex={0}
        >
          <ErrorMessage error={error} />
          {current === "agents" ? (
            <Agents snapshot={snapshot} query={query} />
          ) : plugin ? (
            <PluginPanel
              key={`${plugin.plugin}/${plugin.id}/${id ?? ""}`}
              surface={plugin}
              task={id}
            />
          ) : id ? (
            <TaskInspector key={id} id={id} query={query} />
          ) : (
            <section className="pc-work-panel-section">
              <p className="pc-work-panel-caption">Select a task to see its details.</p>
              {recentRunning && <ButtonLink size="sm" variant="quiet" href={withQuery(`#/tasks/${encodeURIComponent(recentRunning.id)}`, query)}>
                {recentRunning.title || recentRunning.goal}
              </ButtonLink>}
            </section>
          )}
        </div>
      </FrameSlot>
    </DensityContext.Provider>
  );
}
