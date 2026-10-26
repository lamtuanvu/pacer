import { HostsSection } from "./HostsSection";
export { HostsSection } from "./HostsSection";
import { ExecutorsSection } from "./Executors";
export { ExecutorsSection } from "./Executors";
import { UpdatesSection } from "./Updates";
import { LazyDispatcher } from "./LazyDispatcher";

import { withQuery, type RouteQuery } from "../../router";
import { DensityContext } from "../../ds/Density";
import { SETTINGS_PAGES } from "../../settings-pages";
import { Page } from "../../ds/Page";
import { Icon } from "../../ds/icons";
import { DiagnosticsSection } from "./Diagnostics";
import { ProjectStrategies } from "./ProjectStrategies";
import {
  Checkbox,
  Disclosure,
  Range,
  TextArea,
  TextInput,
} from "../../ds/Controls";
import { ChoicePicker } from "../../ds/ChoicePicker";
import { clock } from "../../../../src/view-model/time";
import { spendCopy } from "../../../../src/view-model/copy";
import { useDialogs } from "../../ds/useDialogs";
import {
  accountNeedsSignIn,
  accountStatus,
  executorLabel,
} from "../../../../src/view-model/words";
import { StatusPill } from "../../ds/StatusPill";
import {
  accountUsageFreshness,
  capacityNote,
  executorEligibility,
} from "../../../../src/view-model/capacity";
import { applyTheme, THEME_KEY, type ThemeChoice } from "../../theme";
import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { ExecutorRow } from "../../../../src/api/read-model/types";
import { Pill } from "../../ds/Pill";
import { AgentMark } from "../../ds/AgentMark";
import { Button, ButtonLink, TextAction } from "../../ds/Button";
import type { Account } from "../../model/accounts";
import type { ConfigData, StrategyRow } from "../../model/strategy";
import type { RoutingRules, Rule } from "../../model/executors";
import type { AgentPreview } from "../../model/settings";
import { consentAction, plannerAgent } from "../../model/settings";
import { Dialog, useTaskContext } from "../task-shared";
import {
  Feedback,
  Field,
  ResourceState,
  Section,
  Segment,
  time,
  useOperation,
  useResource,
  words,
  SettingsPageContext,
} from "./shared";
export interface SettingsData {
  config?: ConfigData;
  accounts?: Account[];
  routing?: RoutingRules;
  strategies?: StrategyRow[];
  notifications?: { level: string };
  updates?: {
    current: string;
    latest: string | null;
    available: boolean;
    error?: string;
    disabled?: boolean;
  };
}
/** Mount only the selected editor: inactive pages must not fetch or run effects. */
export function SettingsGeneral({
  section,
  initialData = {},
  query = { repo: null, scope: null },
}: {
  section?: string;
  initialData?: SettingsData;
  query?: RouteQuery;
}) {
  let content: ComponentChildren;
  switch (section) {
    case "planner":
      content = <PlannerPacing initialData={initialData.config} />;
      break;
    case "accounts":
      content = <AccountsSection initialData={initialData.accounts} />;
      break;
    case "executors":
      content = <ExecutorsSection />;
      break;
    case "machine":
      content = <MachineSection initialData={initialData.config} />;
      break;
    case "routing":
      content = <RoutingSection initialData={initialData.routing} />;
      break;
    case "strategies":
      content = <StrategiesSection initialData={initialData.strategies} />;
      break;
    case "dispatcher":
      content = <LazyDispatcher query={query} />;
      break;
    case "updates":
      content = <UpdatesSection initialData={initialData.updates} />;
      break;
    case "notifications":
      content = (
        <NotificationsSection initialData={initialData.notifications} />
      );
      break;
    case "appearance":
      content = <AppearanceSection />;
      break;
    case "diagnostics":
      content = <DiagnosticsSection />;
      break;
    default:
      content = <GeneralOverview query={query} />;
  }
  return (
    <DensityContext.Provider value="settings">
      <SettingsPageContext.Provider
        value={section === "planner" ? "pacing" : (section ?? null)}
      >
        <Page width="full" className="u3-settings u3-settings-page">
          <div className="u3-general-sections">{content}</div>
          {section !== "executors" && (
            <p className="u3-settings-note">
              Changes apply on the next routing decision.
            </p>
          )}
        </Page>
      </SettingsPageContext.Provider>
    </DensityContext.Provider>
  );
}

function GeneralOverview({ query }: { query: RouteQuery }) {
  return (
    <Section
      id="general"
      title="Preferences"
      detail="Manage how pacer plans, delegates, and keeps you informed."
    >
      <div className="u3-settings-links">
        {SETTINGS_PAGES.filter(
          (page) => page.id && page.id !== "add-executor",
        ).map((page) => (
          <TextAction
            key={page.id}
            href={withQuery(`#/settings/${page.id}`, query)}
            className="u3-settings-link"
          >
            <Icon name={page.icon} />
            {page.label}
          </TextAction>
        ))}
      </div>
    </Section>
  );
}

function Setting({
  label,
  help,
  children,
}: {
  label: string;
  help: string;
  children: ComponentChildren;
}) {
  return (
    <div className="u3-setting">
      <div>
        <strong>{label}</strong>
        <div className="u3-muted">{help}</div>
      </div>
      <div>{children}</div>
    </div>
  );
}
export function PlannerPacing({ initialData }: { initialData?: ConfigData }) {
  const query = useResource("config.get", {}, initialData),
    action = useOperation(query.reload),
    { state } = useTaskContext();
  const [chosen, setChosen] = useState("");
  const config = query.data,
    value = (key: string) => String(config?.keys[key]?.value ?? "");
  const save = (key: string, value: string | number) =>
    void action.run("config.set", { key, value });
  return (
    <Section id="pacing" title="Planner & pacing">
      <ResourceState resource={query}>
        {config && (
          <>
            <Setting label="Planner" help="Plans and reviews; paced weekly">
              <div className="u3-agent">
                <AgentMark
                  agent={
                    state.snapshot?.planner?.agent ??
                    plannerAgent(value("planner"))
                  }
                />
                <ChoicePicker
                  aria-label="Planner"
                  value={value("planner")}
                  placeholder="Choose a planner"
                  options={config.planners.map((planner) => ({ value: planner, label: planner }))}
                  onValueChange={setChosen}
                />
              </div>
              <p className="u3-muted">{state.snapshot?.planner?.advice}</p>
              <Button
                disabled={!value("planner")}
                onClick={() => setChosen(value("planner"))}
              >
                Review integration changes
              </Button>
            </Setting>
            <Setting label="Policy" help="How work spreads across executors">
              <Segment
                label="Pacing policy"
                value={value("pacing.policy")}
                disabled={action.busy}
                onChange={(v) => save("pacing.policy", v)}
                options={[
                  { value: "priority", label: "Priority" },
                  { value: "even", label: "Even" },
                  { value: "burn-before-reset", label: "Burn before reset" },
                  { value: "cheapest-first", label: "Cheapest first" },
                ]}
              />
              <p className="u3-muted">
                {value("pacing.policy") === "priority"
                  ? "Use the order on the Executors page; skip one only when it’s out of quota or ahead of pace."
                  : "pacer applies this policy on the next routing decision."}
              </p>
            </Setting>
            <Setting
              label="Planner reserve"
              help="Kept back for planning and review"
            >
              <div className="u3-reserve">
                <Range
                  aria-label="Planner reserve (%)"
                  min="0"
                  max="50"
                  step="5"
                  value={value("pacing.planner_reserve")}
                  disabled={action.busy}
                  onChange={(e) => {
                    if (e.currentTarget.validity.valid)
                      save(
                        "pacing.planner_reserve",
                        Number(e.currentTarget.value),
                      );
                  }}
                />
                <output>{value("pacing.planner_reserve")}%</output>
                <span className="u3-muted">0–50%</span>
              </div>
            </Setting>
            <Setting
              label="Multiple accounts"
              help="When one agent has several"
            >
              <div className="u3-accounts-mode">
                <Segment
                  label="Account mode"
                  value={value("pacing.accounts")}
                  disabled={action.busy}
                  onChange={(v) => save("pacing.accounts", v)}
                  options={[
                    { value: "spread", label: "Spread" },
                    { value: "fill", label: "Fill" },
                  ]}
                />
                <label className="u3-fill">
                  Move to the next account at{" "}
                  <TextInput
                    type="number"
                    min="50"
                    max="100"
                    disabled={
                      action.busy || value("pacing.accounts") !== "fill"
                    }
                    value={value("pacing.fill_threshold") || "80"}
                    onChange={(e) => {
                      if (e.currentTarget.validity.valid)
                        save(
                          "pacing.fill_threshold",
                          Number(e.currentTarget.value),
                        );
                    }}
                  />
                  <span>% used</span>
                </label>
              </div>
            </Setting>
          </>
        )}
      </ResourceState>
      <Feedback action={action} />
      {chosen && (
        <PlannerConsent
          planner={chosen}
          close={() => setChosen("")}
          done={query.reload}
        />
      )}
    </Section>
  );
}
function PlannerConsent({
  planner,
  close,
  done,
}: {
  planner: string;
  close: () => void;
  done: () => void;
}) {
  const agent = plannerAgent(planner),
    query = useResource<AgentPreview>("agent.preview", { agent }),
    action = useOperation(done);
  const save = (integrations: "install" | "skip") => {
    const op = consentAction(query.data, planner, integrations);
    void action.run(op.op, op.params, close);
  };
  return (
    <Dialog title="Planner integration changes" close={close}>
      <div className="u3-settings">
        <p>
          Review the files pacer will change before connecting this planner.
        </p>
        <ResourceState resource={query}>
          {query.data && (
            <>
              <ul>
                {query.data.files.map((file) => (
                  <li key={file}>
                    <code>{file}</code>
                  </li>
                ))}
              </ul>
              <p>
                Undo: <code>{query.data.undo}</code>
              </p>
              <p>
                Change and connect removes the previous planner’s integration.
                Change only keeps its existing hooks.
              </p>
              <div className="u3-actions">
                <Button disabled={action.busy} onClick={() => save("install")}>
                  Change and connect
                </Button>
                <Button disabled={action.busy} onClick={() => save("skip")}>
                  Change only
                </Button>
                <Button
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(
                      "agent.connect",
                      { agent, consent: true },
                      done,
                    )
                  }
                >
                  Connect {agent}
                </Button>
              </div>
            </>
          )}
        </ResourceState>
        <Feedback action={action} />
      </div>
    </Dialog>
  );
}
export function AccountsSection({ initialData }: { initialData?: Account[] }) {
  const query = useResource<Account[]>("account.list", {}, initialData),
    action = useOperation(query.reload),
    { state } = useTaskContext();
  const [adding, setAdding] = useState(false),
    [name, setName] = useState(""),
    [kind, setKind] = useState("codex");
  return (
    <Section
      id="accounts"
      title="Accounts"
      detail="Where quota comes from. An executor uses one account."
      actions={
        <>
          <Button
            onClick={() =>
              void action.run("account.signin", {
                interactive: "account-add-orca",
              })
            }
          >
            Link Orca account
          </Button>
          <Button onClick={() => setAdding((v) => !v)}>Add account</Button>
        </>
      }
    >
      <ResourceState
        resource={query}
        empty="No accounts yet. Add an account to get started."
      >
        <div className="u3-table-wrap">
          <table>
            <thead>
              <tr>
                {[
                  "Account",
                  "Kind",
                  "Source",
                  "Usage",
                  "Status",
                  "Used by",
                  "",
                ].map((v) => (
                  <th key={v}>{v}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {query.data?.map((account) => {
                const summary = state.snapshot?.accounts?.find(
                    (a) => a.name === account.name,
                  ),
                  readiness = {
                    ...account,
                    signedIn: summary?.signedIn ?? account.signedIn,
                  };
                return (
                  <tr key={account.name}>
                    <td data-label="Account">
                      <div className="u3-agent">
                        <AgentMark
                          agent={
                            summary?.agent ??
                            (account.kind === "claude"
                              ? "claude-code"
                              : account.kind === "endpoint"
                                ? "opencode"
                                : account.kind)
                          }
                        />
                        <strong>{account.name}</strong>
                      </div>
                    </td>
                    <td data-label="Kind">
                      {account.kind === "endpoint"
                        ? "Model endpoint"
                        : executorLabel(
                            account.kind === "claude"
                              ? "claude-code"
                              : account.kind,
                          )}
                    </td>
                    <td data-label="Source">
                      {summary?.source ?? account.source ?? "Unknown source"}
                    </td>
                    <td data-label="Usage">
                      {spendCopy(summary?.spendUsdWeek, summary?.capUsdWeek) ??
                        (summary?.usedPct != null
                          ? `${Math.round(summary.usedPct)}% of ${summary.window === "weekly" || summary.window === "week" ? "week" : (summary.window ?? "window")}${summary.resetsAt ? ` · resets ${clock(summary.resetsAt, Date.now() / 1000)}` : ""}`
                          : "Usage unknown")}
                      {summary && accountUsageFreshness(summary) && (
                        <small className="u3-muted">
                          {" "}
                          · {accountUsageFreshness(summary)}
                        </small>
                      )}
                    </td>
                    <td data-label="Status">
                      <StatusPill status={accountStatus(readiness)} />
                    </td>
                    <td data-label="Used by">
                      <code>
                        {(summary?.executors ?? account.runners ?? []).join(
                          ", ",
                        ) || "Not used"}
                      </code>
                    </td>
                    <td data-label="Actions">
                      {accountNeedsSignIn(readiness) && (
                        <Disclosure
                          className="pc-disclosure"
                          summary={
                            <>
                              Fix sign-in
                              <span className="sr-only">
                                {" "}
                                for {account.name}
                              </span>
                            </>
                          }
                        >
                          {account.signin_command && (
                            <code>{account.signin_command}</code>
                          )}
                          <Button
                            size="sm"
                            disabled={action.busy}
                            onClick={() =>
                              void action.run("account.signin", {
                                name: account.name,
                              })
                            }
                          >
                            Sign in
                          </Button>
                        </Disclosure>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </ResourceState>
      {adding && (
        <form
          className="pc-card"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run("account.add", { name, kind }, () => {
              setAdding(false);
              setName("");
            });
          }}
        >
          <div className="u3-settings-grid">
            <Field label="Account name">
              <TextInput
                value={name}
                required
                pattern="[a-z0-9][a-z0-9-]*"
                onInput={(e) => setName(e.currentTarget.value)}
              />
            </Field>
            <Field label="Agent">
              <ChoicePicker
                value={kind}
                options={[{ value: "codex", label: "Codex" }, { value: "claude", label: "Claude Code" }]}
                onValueChange={setKind}
              />
            </Field>
          </div>
          <Button type="submit" disabled={action.busy}>
            Create account
          </Button>
          <p>
            <TextAction
              className="pc-text-action"
              href="#/settings/add-executor"
            >
              Connect an API endpoint through Add executor
            </TextAction>
          </p>
        </form>
      )}
      <Feedback action={action} />
    </Section>
  );
}
export function MachineSection({ initialData }: { initialData?: ConfigData }) {
  const query = useResource("config.get", {}, initialData),
    action = useOperation(query.reload);
  const value = query.data?.keys["execution.local_max_tasks"]?.value;
  return (
    <Section id="machine" title="This machine">
      <ResourceState resource={query}>
        <Field
          label="Parallel tasks on this machine"
          help="Shared by all executors that run on this machine."
        >
          <TextInput
            type="number"
            min="1"
            max="16"
            step="1"
            required
            value={String(value ?? 2)}
            disabled={action.busy}
            onChange={(e) => {
              if (e.currentTarget.validity.valid)
                void action.run("config.set", {
                  key: "execution.local_max_tasks",
                  value: Number(e.currentTarget.value),
                });
            }}
          />
        </Field>
      </ResourceState>
      <Feedback action={action} />
    </Section>
  );
}
export function canAddRoutingRule(executor: string, available: readonly string[]): boolean {
  return !!executor && available.includes(executor);
}
function RoutingSection({ initialData }: { initialData?: RoutingRules }) {
  const query = useResource("routing.get", {}, initialData),
    strategiesQuery = useResource<StrategyRow[]>("strategy.list", {}),
    action = useOperation(query.reload);
  const [adding, setAdding] = useState(false),
    [kind, setKind] = useState("tests"),
    [executor, setExecutor] = useState("");
  const save = (index: number, patch: Partial<Rule>) =>
    void action.run("routing.set", {
      rules: query.data!.rules.map((r, i) =>
        i === index ? { ...r, ...patch } : r,
      ),
    });

  // Show active strategy in detail
  const activeStrategy = strategiesQuery.data?.find((s) => s.active);
  const strategyLabel = activeStrategy
    ? `Global routing rules from strategy: ${activeStrategy.name}${activeStrategy.summary ? ` · ${activeStrategy.summary}` : ""}`
    : "Which executors a kind of task may use, in order. First match wins.";

  return (
    <Section
      id="routing"
      title="Routing"
      detail={strategyLabel}
      actions={
        <>
          {activeStrategy && (
            <TextAction href="#/settings/strategies">View strategies</TextAction>
          )}
          {activeStrategy && " "}
          <Button onClick={() => setAdding((v) => !v)}>Add rule</Button>
        </>
      }
    >
      <p>These rules choose executors by task kind when a repository has no project strategy. A project strategy supplies its own executor list. The <TextAction href="#/settings/dispatcher">dispatcher</TextAction> then ranks eligible account and model choices from that list.</p>
      <ResourceState resource={query}>
        {query.data?.rules.length === 0 ? (
          <p>No routing rules yet.</p>
        ) : (
          query.data?.rules.map((rule, index) => (
            <div className="u3-setting" key={index}>
              <Field label={`Rule ${index + 1} task kinds`}>
                <TextInput
                  aria-label={`Rule ${index + 1} task kinds`}
                  value={rule.kinds?.join(", ") ?? ""}
                  placeholder="Everything else"
                  disabled={action.busy}
                  onChange={(e) =>
                    save(index, {
                      kinds: e.currentTarget.value
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </Field>
              <Field label="Executor order (comma separated)">
                <TextInput
                  value={rule.executors.join(", ")}
                  disabled={action.busy}
                  onChange={(e) =>
                    save(index, {
                      executors: e.currentTarget.value
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </Field>
            </div>
          ))
        )}
      </ResourceState>
      {adding && query.data && (
        <form
          className="pc-card"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canAddRoutingRule(executor, query.data!.available)) return;
            const rules = [...query.data!.rules],
              at = rules.findIndex((r) => !r.kinds?.length);
            rules.splice(at < 0 ? rules.length : at, 0, {
              kinds: kind
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
              executors: [executor],
            });
            void action.run("routing.set", { rules }, () => setAdding(false));
          }}
        >
          <Field label="Task kinds">
            <TextInput
              required
              value={kind}
              onInput={(e) => setKind(e.currentTarget.value)}
            />
          </Field>
          <Field label="Executor">
            <ChoicePicker
              required
              value={executor}
              placeholder="Choose executor"
              searchable
              options={query.data.available.map((id) => ({ value: id, label: id }))}
              onValueChange={setExecutor}
            />
          </Field>
          <Button type="submit" disabled={action.busy || !canAddRoutingRule(executor, query.data.available)}>
            Add rule
          </Button>
        </form>
      )}
      <Feedback action={action} />
      <ProjectStrategies />
    </Section>
  );
}
function StrategiesSection({ initialData }: { initialData?: StrategyRow[] }) {
  const query = useResource("strategy.list", {}, initialData),
    action = useOperation(query.reload);
  const [building, setBuilding] = useState(false),
    [brief, setBrief] = useState("");
  return (
    <Section
      id="strategies"
      title="Strategies"
      detail="Saved routing, pacing and dispatcher settings. Switch anytime."
      actions={
        <>
          <TextAction href="#/settings/dispatcher">View dispatcher</TextAction>{" "}
          <TextAction href="#/settings/routing">Edit routing rules</TextAction>{" "}
          <Button onClick={() => setBuilding((v) => !v)}>New from a brief</Button>
        </>
      }
    >
      <ResourceState resource={query} empty="No strategies yet.">
        {query.data?.map((strategy) => (
          <div className="u3-setting" key={strategy.name}>
            <strong>{strategy.name}</strong>
            <div className="u3-row">
              <span>{strategy.summary}</span>
              {strategy.active ? (
                <span>Active</span>
              ) : (
                <Button
                  disabled={action.busy}
                  onClick={() =>
                    void action.run("strategy.use", { name: strategy.name })
                  }
                >
                  Use
                </Button>
              )}
            </div>
          </div>
        ))}
      </ResourceState>
      <p className="u3-muted">The dispatcher chooses an executor and model for each work attempt. <TextAction href="#/settings/dispatcher">View its planner, ladder and preview</TextAction></p>
      {building && (
        <form
          className="pc-card"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run("strategy.build", { brief });
          }}
        >
          <Field label="What should this strategy do?">
            <TextArea
              value={brief}
              maxLength={2000}
              required
              onInput={(e) => setBrief(e.currentTarget.value)}
            />
          </Field>
          <Button type="submit" disabled={action.busy}>
            Build strategy
          </Button>
          <p className="u3-muted">
            Opens a planning session or returns a command to run.
          </p>
        </form>
      )}
      <Feedback action={action} />
    </Section>
  );
}
function NotificationsSection({
  initialData,
}: {
  initialData?: { level: string };
}) {
  const query = useResource("notifications.get", {}, initialData),
    action = useOperation(query.reload);
  return (
    <Section id="notifications" title="Notifications">
      <ResourceState resource={query}>
        <Segment
          label="Notifications"
          value={query.data?.level ?? ""}
          disabled={action.busy}
          options={[
            { value: "off", label: "Off" },
            { value: "important", label: "Important" },
            { value: "all", label: "All" },
          ]}
          onChange={(level) => void action.run("notifications.set", { level })}
        />
        <p className="u3-muted">Failures, stuck tasks and reviews</p>
      </ResourceState>
      <Feedback action={action} />
    </Section>
  );
}
function AppearanceSection() {
  const [theme, setTheme] = useState(() => {
      try {
        const saved = localStorage.getItem("pacer.theme");
        return saved && ["system", "light", "dark"].includes(saved)
          ? saved
          : "system";
      } catch {
        return "system";
      }
    }),
    [message, setMessage] = useState("");
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    const sync = () => { try { setTheme(localStorage.getItem(THEME_KEY) ?? "system"); } catch { /* device storage unavailable */ } };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  return (
    <Section id="appearance" title="Appearance" detail="Stored on this device.">
      <Segment
        label="Appearance"
        value={theme}
        options={["system", "light", "dark"].map((value) => ({
          value,
          label: value[0]!.toUpperCase() + value.slice(1),
        }))}
        onChange={(value) => {
          setTheme(value);
          applyTheme(value as ThemeChoice);
          try {
            localStorage.setItem(THEME_KEY, value);
            setMessage("Saved on this device.");
          } catch {
            setMessage(
              "Applied for this session. Device storage is unavailable.",
            );
          }
        }}
      />
      <p role="status">{message}</p>
    </Section>
  );
}
