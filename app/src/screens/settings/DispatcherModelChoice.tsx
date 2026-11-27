import { useEffect, useRef, useState } from "preact/hooks";
import type { DispatchConfig, TierTargets } from "../../../../src/dispatch/types";
import type { RunnerModels } from "../../../../src/core/runner-models";
import { TIERS } from "../../../../src/dispatch/candidates";
import { markAgent } from "../../../../src/view-model/agents";
import { executorReadiness } from "../../../../src/view-model/capacity";
import { ago } from "../../../../src/view-model/time";
import type { BrowserApi } from "../../data/api";
import { ApiError } from "../../data/api";
import { executorLabel } from "../../../../src/view-model/words";
import { AgentMark } from "../../ds/AgentMark";
import { AgentStack } from "../../ds/AgentStack";
import { Button, ButtonLink, TextAction } from "../../ds/Button";
import { Dialog } from "../../ds/Dialog";
import { Field, TextInput } from "../../ds/Controls";
import { Icon } from "../../ds/icons";
import { Card, FilterChip } from "../../ds/Patterns";
import { Pill } from "../../ds/Pill";
import { RadioGroup, RadioChip } from "../../ds/Composer";
import { SectionHeading } from "../../ds/SectionHeading";
import { StatusPill } from "../../ds/StatusPill";
import { Tooltip } from "../../ds/Tooltip";
import { ErrorMessage, useTaskContext } from "../task-shared";
import { containTooltipEscape, ResourceState, useResource, useScoped } from "./shared";
import { difficultyLabels, tierLabels } from "../../model/executor-models";
import {
  adjustTier, applyPreset, matchingPreset, PRESETS, PRESET_LABELS,
  RATED_TIERS, DIFFICULTIES, type PresetName, type RatedTier, type Difficulty,
} from "../../model/tier-targets";
import { overviewModel, type AgentBehavior, type HubAction, type HubAgent, type OverviewRow } from "../../model/dispatcher-hub";
import { hrefFor, routes } from "../../router";
import type { DispatcherInventory } from "./Dispatcher";
import { plannerRunner } from "../../model/planner";
import type { ConfigData } from "../../model/strategy";
import { useDispatcherStyles } from "./dispatcher-styles";

type ConfigView = { strategy: string; source?: "built-in" | "strategy"; config: DispatchConfig; planner?: string; plannerAccount?: string };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const mappingError = (targets: TierTargets) => TIERS[targets.simple] > TIERS[targets.standard] || TIERS[targets.standard] > TIERS[targets.complex]
  ? "dispatch.tierTargets must not decrease from simple to complex" : null;

export async function saveTierTargets(call: BrowserApi["call"], saved: ConfigView, targets: TierTargets, profileName = "model-choices"): Promise<void> {
  const error = mappingError(targets);
  if (error) throw new Error(error);
  if (profileName === "default") throw new Error("Choose a name for the saved setup; default is protected.");
  if (profileName === saved.strategy) throw new Error("Choose a new saved setup name; the active setup cannot be overwritten.");
  const latest = await call<ConfigView>("dispatch.config.get", {});
  if (!same(latest.config, saved.config) || latest.strategy !== saved.strategy) throw new Error("The active saved setup changed in another client. Discard to load it.");
  const draft = { from: saved.strategy, set: { "dispatch.tierTargets": targets } };
  const preview = await call<{ ok: boolean; errors: string[] }>("strategy.preview", { draft });
  if (!preview.ok) throw new Error(preview.errors?.join(" ") || "Model choices could not be validated.");
  await call("strategy.save", { name: profileName, draft, reason: "Update model choices by task difficulty" });
  try { await call("strategy.use", { name: profileName }); }
  catch (error) { throw new Error(`Saved model choices, but the setup could not be activated: ${error instanceof Error ? error.message : String(error)}`); }
}

/** In-place save of the active setup through the revision-checked tier-targets operations. */
export async function saveTierTargetsInPlace(call: BrowserApi["call"], saved: ConfigView, targets: TierTargets): Promise<{ ok: true } | { ok: false; conflict: boolean }> {
  const current = await call<{ revision: string; targets: TierTargets }>("dispatch.tierTargets.get", {});
  // The draft has diverged from what the setup started with, so the active setup changed elsewhere.
  if (!same(current.targets, saved.config.tierTargets)) return { ok: false, conflict: true };
  try {
    await call("dispatch.tierTargets.set", { expectedRevision: current.revision, targets });
    return { ok: true };
  } catch (failure) {
    if (failure instanceof ApiError && failure.code === "conflict") return { ok: false, conflict: true };
    throw failure;
  }
}

const DIFF_HINT: Record<Difficulty, string> = {
  simple: "Docs, renames, small fixes", standard: "Features, tests, ordinary bugs", complex: "Cross-cutting changes, hard debugging",
};
const SIZE_MARK: Record<RatedTier | "unknown", string> = { small: "S", medium: "M", frontier: "F", unknown: "?" };
const FILTERS: { value: "all" | AgentBehavior; label: string }[] = [
  { value: "all", label: "All" }, { value: "follow", label: "Follow the size" }, { value: "unrated", label: "Unrated" }, { value: "fixed", label: "Pick their own" },
];

/** A model id with its declared size as a one-letter badge (the full size is its accessible name). */
function ModelChip({ id, tier }: { id: string; tier: RatedTier | "unknown" }) {
  return <span className="pc-hub-model"><code>{id}</code><span className={`pc-hub-size pc-hub-size--${tier}`} title={tierLabels[tier]} aria-label={tierLabels[tier]} role="img">{SIZE_MARK[tier]}</span></span>;
}

/**
 * Dispatcher › Overview: where work goes right now, the model size for each difficulty (the revision-checked
 * tier targets, with presets and the monotonic rule) and what each agent runs for each difficulty.
 */
export function DispatcherModelChoice({ initialConfig, initialInventory, initialTargets, onSaved }: {
  initialConfig?: ConfigView; initialInventory?: DispatcherInventory; initialTargets?: TierTargets; onSaved?: () => void;
}) {
  useDispatcherStyles();
  const { api, state } = useTaskContext();
  const config = useResource<ConfigView>("dispatch.config.get", {}, initialConfig);
  const inventory = useResource<DispatcherInventory>("dispatch.models", {}, initialInventory);
  const settings = useResource<ConfigData>("config.get");
  const [base, setBase] = useState(initialConfig);
  const [targets, setTargets] = useState(initialTargets ?? initialConfig?.config.tierTargets);
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(), [notice, setNotice] = useState("");
  const pending = useRef(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>();
  /** Show a status in the save-bar region, then keep it for a few seconds or until the next edit. */
  const flashNotice = (text: string) => {
    setNotice(text);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 4000);
  };
  const [dialog, setDialog] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<"all" | AgentBehavior>("all");
  const [refreshing, setRefreshing] = useState(false), [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const dirty = !!targets && !!base && !same(targets, base.config.tierTargets);
  useEffect(() => {
    if (config.data && !dirty) { setBase(config.data); setTargets(config.data.config.tierTargets); }
  }, [config.data]);
  // A runner's configured default is not part of the dispatch.models inventory, so read it the same way the
  // Agents tab does (runner.models.get): an executor that picks its own model names it.
  useEffect(() => {
    let active = true;
    const runnerIds = [...new Set((inventory.data?.models ?? []).map(m => m.runner))].sort();
    if (!runnerIds.length) return;
    void Promise.all(runnerIds.map(id =>
      api.call<RunnerModels>("runner.models.get", { id })
        .then(m => ({ id, default: m.default }))
        .catch(() => ({ id, default: null })),
    )).then(rows => {
      if (!active) return;
      const next: Record<string, string> = {};
      for (const row of rows) if (row.default) next[row.id] = row.default;
      setDefaults(next);
    });
    return () => { active = false; };
  }, [inventory.data, api]);
  const changeCount = targets && base ? DIFFICULTIES.filter(d => targets[d] !== base.config.tierTargets[d]).length : 0;
  const canSet = state.features?.ops.has("dispatch.tierTargets.set") ?? false;
  const directSave = canSet && !!base;

  const pickTier = (difficulty: Difficulty, tier: RatedTier) => {
    if (!targets) return;
    setTargets(adjustTier(targets, difficulty, tier)); clearTimeout(noticeTimer.current); setNotice(""); setError(undefined);
  };
  const pickPreset = (name: PresetName) => {
    if (!targets) return;
    setTargets(applyPreset(targets, name)); clearTimeout(noticeTimer.current); setNotice(""); setError(undefined);
  };
  const discard = () => {
    if (config.data) { setBase(config.data); setTargets(config.data.config.tierTargets); }
    clearTimeout(noticeTimer.current); setError(undefined); setNotice(""); setDialog(false);
  };

  const saveInPlace = async () => {
    if (!base || !targets || pending.current) return;
    pending.current = true; setBusy(true); setError(undefined); setNotice("");
    try {
      const result = await saveTierTargetsInPlace(api.call.bind(api), base, targets);
      if (result.ok) {
        setBase({ ...base, config: { ...base.config, tierTargets: targets } });
        flashNotice("Saved. New tasks use these choices now."); config.reload(); inventory.reload(); onSaved?.();
      } else {
        // Conflict: the setup changed elsewhere since this draft began. Keep the draft so it can be
        // saved as a new setup; do not reload or overwrite the active setup with it.
        flashNotice("The active setup changed elsewhere. Discard to load it, or save as a new setup.");
      }
    } catch (failure) { setError(failure); }
    finally { pending.current = false; setBusy(false); }
  };
  const openName = () => { clearTimeout(noticeTimer.current); setProfileName(""); setError(undefined); setNotice(""); setDialog(true); };
  const saveAsNew = async () => {
    if (!base || !targets || !profileName.trim() || pending.current) return;
    pending.current = true; setBusy(true); setError(undefined); clearTimeout(noticeTimer.current); setNotice("");
    try {
      await saveTierTargets(api.call.bind(api), base, targets, profileName.trim());
      setDialog(false);
      setBase({ ...base, strategy: profileName.trim(), config: { ...base.config, tierTargets: targets } });
      flashNotice("Saved as a new setup and made it active."); config.reload(); inventory.reload(); onSaved?.();
    } catch (failure) { setError(failure); }
    finally { pending.current = false; setBusy(false); }
  };
  const refreshAll = async () => {
    const runnerIds = [...new Set((inventory.data?.models ?? []).map(m => m.runner))];
    setRefreshing(true);
    try {
      await Promise.all([
        ...runnerIds.map(runner => api.call("executor.models.available", { runner, refresh: true }).catch(() => null)),
        state.features.ops.has("limits.refresh") ? api.call("limits.refresh", {}).catch(() => null) : Promise.resolve(null),
      ]);
      inventory.reload(); config.reload(); setRefreshedAt(Date.now() / 1000);
    } finally { setRefreshing(false); }
  };

  const scoped = useScoped();
  const snapshot = state.snapshot;
  const records = inventory.data?.models ?? [];
  const planner = plannerRunner(records, config.data?.planner, config.data?.plannerAccount)
    ?? snapshot?.executors?.find(row => row.rank === "planner")?.id ?? null;
  // Agents the snapshot knows carry their readiness; an inventory runner it does not list yet still gets its name.
  const agents: HubAgent[] = [
    ...(snapshot?.executors ?? []).map(row => ({ runner: row.id, name: executorLabel(row.id), readiness: executorReadiness(row, snapshot!) })),
    ...[...new Set(records.map(record => record.runner))].filter(runner => !snapshot?.executors?.some(row => row.id === runner)).map(runner => ({ runner, name: executorLabel(runner) })),
  ];
  const fallbackOn = settings.data?.keys?.["pacing.planner_tier_fallback"]?.value !== "off";
  const model = targets ? overviewModel({ records, targets, agents, plannerRunner: planner, fallbackOn, defaults }) : null;
  const preset = targets ? matchingPreset(targets) : "custom";
  const agentHref = (runner: string) => scoped(hrefFor(routes.agents(runner)));
  const actionLink = (action: HubAction, variant: "secondary" | "quiet") => action.addAgent
    ? <ButtonLink size="sm" variant={variant} href={scoped(hrefFor(routes.addExecutor()))}>{action.label}</ButtonLink>
    : <ButtonLink size="sm" variant={variant} href={action.agent ? agentHref(action.agent) : scoped(hrefFor(routes.agents()))}>{action.label}</ButtonLink>;
  const readinessOf = (runner: string) => {
    const row = snapshot?.executors?.find(item => item.id === runner);
    return row && snapshot ? executorReadiness(row, snapshot) : undefined;
  };
  const shown = model?.rows.filter(row => filter === "all" || row.behavior === filter) ?? [];
  const checkedAt = refreshedAt ?? inventory.data?.observedAt ?? null;
  const now = snapshot?.at ?? Date.now() / 1000;

  const agentRow = (row: OverviewRow) => {
    const status = readinessOf(row.runner);
    return <tr key={row.runner}>
      <th scope="row" className="pc-hub-table__agent">
        <span className="pc-hub-agent">
          <AgentMark agent={markAgent(row.runner)} size={28} />
          <span className="pc-hub-agent__text">
            <strong>{row.name}</strong>
            <span className="pc-hub-agent__meta"><code>{row.runner}</code>
              {row.planner ? <Pill tone="info">Planner</Pill> : status ? <span onKeyDown={containTooltipEscape}><Tooltip text={`${status.reason}. ${status.tooltip}`}><span tabIndex={0}><StatusPill status={status} /></span></Tooltip></span> : null}
            </span>
          </span>
        </span>
      </th>
      <td className="pc-hub-table__models"><span className="pc-hub-models">
        {row.models.length ? row.models.map(item => <ModelChip key={item.id} id={item.id} tier={item.tier} />) : <span className="u3-muted">No models set · uses its own default</span>}
      </span></td>
      {row.cells ? row.cells.map(cell => <td key={cell.difficulty} className="pc-hub-table__cell">
        <span className="pc-hub-cell__label">{difficultyLabels[cell.difficulty]}</span>
        <code className={cell.muted ? "pc-hub-cell__model pc-hub-cell__model--muted" : "pc-hub-cell__model"}>{cell.model}</code>
        <span className="pc-hub-cell__note">{cell.note}</span>
      </td>) : <td colSpan={3} className="pc-hub-table__cell">
        <span className={`pc-hub-flat pc-hub-flat--${row.flat!.tone}`}>
          <Pill tone={row.flat!.tone}>{row.flat!.pill}</Pill><span>{row.flat!.text}</span>
          {row.canRate && <TextAction size="caption" href={agentHref(row.runner)}>Set its size<span className="sr-only"> for {row.name}</span></TextAction>}
        </span>
      </td>}
      <td className="pc-hub-table__open"><ButtonLink size="sm" variant="quiet" href={agentHref(row.runner)} aria-label={`Open ${row.name}`}>Open<Icon name="chevron-right" /></ButtonLink></td>
    </tr>;
  };

  // #model-choice keeps the save dock's scroll padding (settings.css); the inner .pc-hub is the layout container.
  return <div id="model-choice"><div className="pc-hub pc-stack pc-stack--section">
    <ResourceState resource={config}>
      {config.data && targets && base && model && <>
        <Card tone="sunken" className="pc-hub-now" aria-labelledby="hub-now-h">
          <div className="pc-hub-now__text">
            <SectionHeading id="hub-now-h">Right now</SectionHeading>
            <p className="pc-hub-now__headline">{model.summary.headline}</p>
            <p className="pc-hub-now__consequence">{model.summary.consequence}</p>
            {(model.summary.action || model.summary.secondary) && <div className="pc-hub-now__actions">
              {model.summary.action && actionLink(model.summary.action, "secondary")}
              {model.summary.secondary && actionLink(model.summary.secondary, "quiet")}
            </div>}
          </div>
          <ul className="pc-hub-tiles" aria-label="Who gets each difficulty">
            {model.tiles.map(tile => <li key={tile.difficulty} className="pc-hub-tile">
              <span className="pc-hub-tile__head"><strong>{difficultyLabels[tile.difficulty]}</strong><span className="u3-muted">needs {tierLabels[tile.target].toLowerCase()}</span></span>
              <span className="pc-hub-tile__count">{tile.agents.length > 0 && <AgentStack agents={tile.agents.map(runner => markAgent(runner))} size={20} />}<strong>{tile.count}</strong></span>
              <span className="pc-hub-tile__who">{tile.who}</span>
            </li>)}
          </ul>
        </Card>

        <section className="pc-stack pc-stack--normal" aria-labelledby="hub-sizes-h">
          <div className="pc-hub-section-head">
            <div className="pc-hub-section-head__text">
              <SectionHeading id="hub-sizes-h">Model size for each difficulty</SectionHeading>
              <p className="u3-muted">Harder tasks never get a smaller model. Picking one row moves the others to keep that order.</p>
            </div>
            <div className="pc-hub-chips" role="group" aria-label="Presets">
              {(Object.keys(PRESETS) as PresetName[]).map(name =>
                <FilterChip key={name} selected={preset === name} disabled={busy} onClick={() => pickPreset(name)}>{PRESET_LABELS[name]}</FilterChip>)}
              {preset === "custom" && <span className="pc-model-choice__preset-note">Custom</span>}
            </div>
          </div>
          <div className="pc-hub-sizes">
            {DIFFICULTIES.map(d => <div className="pc-hub-sizes__row" key={d}>
              <span className="pc-hub-sizes__label"><strong>{difficultyLabels[d]}</strong><span className="u3-muted">{DIFF_HINT[d]}</span></span>
              <RadioGroup label={`${difficultyLabels[d]} tasks`} className="pc-hub-sizes__radios">
                {RATED_TIERS.map(t => <RadioChip key={t} checked={targets[d] === t} disabled={busy} onSelect={() => pickTier(d, t)}>{tierLabels[t]}</RadioChip>)}
              </RadioGroup>
              <span className="pc-hub-sizes__who">{model.coverage[d]}</span>
            </div>)}
          </div>
          {(dirty || notice) && <div className="pc-model-choice__savedock">
            {dirty && <div className="u3-save-bar">
              <div className="pc-model-choice__savecopy">
                <span role="status" aria-live="polite">{busy ? "Saving…" : `${changeCount} unsaved change${changeCount === 1 ? "" : "s"}`}</span>
                <span className="u3-muted">Saving updates the active profile “{base?.strategy}”. New tasks use it at once.</span>
              </div>
              <div className="u3-actions">
                <Button variant="ghost" disabled={busy} onClick={discard}>Discard</Button>
                <Button variant={directSave ? "secondary" : "primary"} disabled={busy} onClick={openName}>Save as new setup…</Button>
                {directSave && <Button variant="primary" busy={busy} onClick={() => void saveInPlace()}>Save</Button>}
              </div>
            </div>}
            {notice && <div className="pc-model-choice__notice" role="status" aria-live="polite">{notice}</div>}
          </div>}
          <ErrorMessage error={error} />
        </section>

        <section className="pc-stack pc-stack--normal" aria-labelledby="hub-agents-h">
          <div className="pc-hub-section-head">
            <div className="pc-hub-section-head__text">
              <SectionHeading id="hub-agents-h">Agents and models</SectionHeading>
              <p className="u3-muted">What each agent runs for each difficulty, from the model inventory read {checkedAt && now - checkedAt >= 60 ? ago(checkedAt, now) : "a moment ago"}. Pacer checks again when it dispatches.</p>
            </div>
            <div className="pc-hub-chips">
              <span className="pc-hub-chips" role="group" aria-label="Show agents">
                {FILTERS.map(item => <FilterChip key={item.value} selected={filter === item.value} onClick={() => setFilter(item.value)}>{item.label} <span className="pc-hub-chip-count">{model.counts[item.value]}</span></FilterChip>)}
              </span>
              <Button variant="ghost" size="sm" busy={refreshing} disabled={!state.connected} aria-label="Refresh all accounts: models, sign-in and usage" onClick={() => void refreshAll()}><Icon name="refresh" />Refresh all</Button>
            </div>
          </div>
          <ResourceState resource={inventory}>
            {!model.rows.length ? <p className="u3-muted">No agents in the model inventory yet. <TextAction href={scoped(hrefFor(routes.addExecutor()))}>Add an agent</TextAction></p>
              : <div className="pc-hub-table-wrap">
                <table className="pc-hub-table">
                  <thead><tr>
                    <th scope="col">Agent</th><th scope="col">Models</th>
                    {DIFFICULTIES.map(d => <th scope="col" key={d}>{difficultyLabels[d]} <span className="u3-muted">· {tierLabels[targets[d]].toLowerCase()}</span></th>)}
                    <th scope="col"><span className="sr-only">Actions</span></th>
                  </tr></thead>
                  <tbody>{shown.map(agentRow)}</tbody>
                </table>
                {!shown.length && <p className="u3-muted pc-hub-table__empty">No agent matches this filter.</p>}
              </div>}
          </ResourceState>
          <p className="u3-muted">Sizes are what you declared. Pacer never guesses a model's size; an unrated model runs for every difficulty until you set one.</p>
        </section>

        {dialog && <Dialog title="Save as a new setup" close={() => setDialog(false)}>
          <form className="pc-stack pc-stack--normal" onSubmit={event => { event.preventDefault(); void saveAsNew(); }}>
            <p className="u3-muted">Name the saved setup so you can switch back later. The active setup keeps its current choices until you save.</p>
            <Field label="Saved setup name"><TextInput value={profileName} autoFocus required disabled={busy} onInput={event => setProfileName(event.currentTarget.value)} /></Field>
            <div className="u3-actions">
              <Button variant="ghost" disabled={busy} onClick={() => setDialog(false)}>Cancel</Button>
              <Button type="submit" variant="primary" busy={busy} disabled={!profileName.trim() || busy}>Save and use setup</Button>
            </div>
          </form>
        </Dialog>}
      </>}
    </ResourceState>
  </div></div>;
}
