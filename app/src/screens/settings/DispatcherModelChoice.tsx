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
import { containTooltipEscape, ResourceState, resourceRevision, useResource, useScoped } from "./shared";
import { difficultyLabels, tierLabels } from "../../model/executor-models";
import {
  adjustTier, applyPreset, matchingPreset, PRESETS, PRESET_LABELS,
  RATED_TIERS, DIFFICULTIES, type PresetName, type RatedTier, type Difficulty,
} from "../../model/tier-targets";
import { joinNames, overviewModel, type AgentBehavior, type HubAction, type HubAgent, type OverviewRow } from "../../model/dispatcher-hub";
import type { Rule } from "../../model/executors";
import { SaveBar } from "../../ds/SaveBar";
import { hrefFor, routes } from "../../router";
import type { DispatcherInventory } from "./Dispatcher";
import { plannerRunner } from "../../model/planner";
import type { ConfigData } from "../../model/strategy";
import { useDispatcherStyles } from "./dispatcher-styles";

const messageOf = (failure: unknown) => failure instanceof Error ? failure.message : String(failure);

type ConfigView = { strategy: string; source?: "built-in" | "strategy"; config: DispatchConfig; planner?: string; plannerAccount?: string };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const mappingError = (targets: TierTargets) => TIERS[targets.simple] > TIERS[targets.standard] || TIERS[targets.standard] > TIERS[targets.complex]
  ? "dispatch.tierTargets must not decrease from simple to complex" : null;

export async function saveTierTargets(call: BrowserApi["call"], saved: ConfigView, targets: TierTargets, profileName = "model-choices"): Promise<void> {
  const error = mappingError(targets);
  if (error) throw new Error(error);
  if (profileName === "default") throw new Error("Choose a name for the new profile; default is protected.");
  if (profileName === saved.strategy) throw new Error("Choose a new profile name; the active profile cannot be overwritten.");
  const latest = await call<ConfigView>("dispatch.config.get", {});
  if (!same(latest.config, saved.config) || latest.strategy !== saved.strategy) throw new Error("The active profile changed in another client. Discard to load it.");
  const draft = { from: saved.strategy, set: { "dispatch.tierTargets": targets } };
  const preview = await call<{ ok: boolean; errors: string[] }>("strategy.preview", { draft });
  if (!preview.ok) throw new Error(preview.errors?.join(" ") || "Model choices could not be validated.");
  await call("strategy.save", { name: profileName, draft, reason: "Update model choices by task difficulty" });
  try { await call("strategy.use", { name: profileName }); }
  catch (error) { throw new Error(`Saved model choices, but the profile could not be switched to: ${error instanceof Error ? error.message : String(error)}`); }
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
  const [refreshing, setRefreshing] = useState(false), [refreshedAt, setRefreshedAt] = useState<number | null>(null), [refreshFailed, setRefreshFailed] = useState("");
  // The default list decides who the engine ranks. Right now waits for it rather than counting every agent as listed;
  // only a service without routing.get (which has no list to read) counts every agent, and says so.
  const hasRouting = state.features.ops.has("routing.get");
  const [routing, setRouting] = useState<{ rules: Rule[] }>(), [routingError, setRoutingError] = useState<unknown>(), [routingTry, retryRouting] = useState(0);
  const routingRevision = resourceRevision("routing.get", state.invalidations);
  useEffect(() => {
    if (!hasRouting) return;
    let live = true;
    setRoutingError(undefined);
    api.call<{ rules: Rule[] }>("routing.get", {}).then(value => { if (live) setRouting(value); }, failure => { if (live) setRoutingError(failure); });
    return () => { live = false; };
  }, [api, hasRouting, routingTry, routingRevision, state.connected]);
  const listState: "known" | "loading" | "failed" | "unsupported" = !hasRouting ? "unsupported" : routing ? "known" : routingError ? "failed" : "loading";
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
        flashNotice("The active profile changed elsewhere. Discard to load it, or save as a new profile.");
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
      flashNotice("Saved as a new profile and switched to it."); config.reload(); inventory.reload(); onSaved?.();
    } catch (failure) { setError(failure); }
    finally { pending.current = false; setBusy(false); }
  };
  const refreshAll = async () => {
    const runnerIds = [...new Set((inventory.data?.models ?? []).map(m => m.runner))];
    setRefreshing(true); setRefreshFailed("");
    try {
      // Every failure is named, and the reading only counts as fresh when something did refresh.
      const results = await Promise.all([
        ...runnerIds.map(runner => api.call("executor.models.available", { runner, refresh: true }).then(() => null, (failure: unknown) => ({ who: `${executorLabel(runner)} models`, failure }))),
        state.features.ops.has("limits.refresh") ? api.call("limits.refresh", {}).then(() => null, (failure: unknown) => ({ who: "usage", failure })) : Promise.resolve(null),
      ]);
      const failed = results.filter((item): item is { who: string; failure: unknown } => !!item);
      if (failed.length) setRefreshFailed(`Couldn't refresh ${joinNames(failed.map(item => item.who))}: ${messageOf(failed[0]!.failure)}`);
      if (failed.length < results.length) setRefreshedAt(Date.now() / 1000);
      inventory.reload(); config.reload();
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
  const defaultList = routing ? routing.rules.find(rule => !rule.kinds)?.executors ?? [] : undefined;
  const model = targets ? overviewModel({ records, targets, agents, plannerRunner: planner, fallbackOn, defaults, defaultList }) : null;
  const preset = targets ? matchingPreset(targets) : "custom";
  const agentHref = (runner: string) => scoped(hrefFor(routes.agents(runner)));
  const actionLink = (action: HubAction, variant: "secondary" | "quiet") => action.addAgent
    ? <ButtonLink size="sm" variant={variant} href={scoped(hrefFor(routes.addExecutor()))}>{action.label}</ButtonLink>
    : action.rules ? <ButtonLink size="sm" variant={variant} href={scoped("#/settings/rules")}>{action.label}</ButtonLink>
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
              {!row.listed && <Pill tone="neutral">Not in the default list</Pill>}
            </span>
          </span>
        </span>
      </th>
      <td className="pc-hub-table__models"><span className="pc-hub-models">
        {row.models.length ? row.models.map(item => <ModelChip key={item.id} id={item.id} tier={item.tier} />) : <span className="u3-muted">No models set · uses its own default</span>}
      </span></td>
      {row.cells.map((cell, index) => <td key={cell.difficulty} className="pc-hub-table__cell">
        <span className="pc-hub-cell__label">{difficultyLabels[cell.difficulty]}</span>
        {index === 0 && row.flat && <Pill tone={row.flat.tone}>{row.flat.pill}</Pill>}
        <code className={cell.muted ? "pc-hub-cell__model pc-hub-cell__model--muted" : "pc-hub-cell__model"}>{cell.model}</code>
        {cell.note && <span className="pc-hub-cell__note">{cell.note}</span>}
        {index === 0 && row.canRate && <TextAction size="caption" href={agentHref(row.runner)}>Set its size<span className="sr-only"> for {row.name}</span></TextAction>}
      </td>)}
      <td className="pc-hub-table__open"><ButtonLink size="sm" variant="quiet" href={agentHref(row.runner)} aria-label={`Open ${row.name}`}>Open<Icon name="chevron-right" /></ButtonLink></td>
    </tr>;
  };

  // #model-choice keeps the save dock's scroll padding (settings.css); the inner .pc-hub is the layout container.
  return <div id="model-choice"><div className="pc-hub pc-stack pc-stack--section">
    <ResourceState resource={config}>
      {config.data && targets && base && model && <>
        <Card tone="sunken" className="pc-hub-now" aria-labelledby="hub-now-h">
          {listState === "loading" || listState === "failed" ? <div className="pc-hub-now__text">
            <SectionHeading id="hub-now-h">Right now</SectionHeading>
            {listState === "loading" ? <p className="u3-muted" role="status">Reading the default list…</p> : <>
              <p className="pc-hub-now__headline">The default list could not be read, so Pacer can't say where work goes.</p>
              <ErrorMessage error={routingError} />
              <div className="pc-hub-now__actions"><Button size="sm" variant="secondary" onClick={() => retryRouting(n => n + 1)}>Try again</Button></div>
            </>}
          </div> : <><div className="pc-hub-now__text">
            <SectionHeading id="hub-now-h">Right now</SectionHeading>
            <p className="pc-hub-now__headline">{model.summary.headline}</p>
            <p className="pc-hub-now__consequence">{model.summary.consequence}</p>
            {(model.summary.action || model.summary.secondary) && <div className="pc-hub-now__actions">
              {model.summary.action && actionLink(model.summary.action, "secondary")}
              {model.summary.secondary && actionLink(model.summary.secondary, "quiet")}
            </div>}
            {listState === "unsupported" && <p className="u3-muted">This service doesn't report the default list, so every agent counts as listed.</p>}
          </div>
          <ul className="pc-hub-tiles" aria-label="Who gets each difficulty">
            {model.tiles.map(tile => <li key={tile.difficulty} className="pc-hub-tile">
              <span className="pc-hub-tile__head"><strong>{difficultyLabels[tile.difficulty]}</strong><span className="u3-muted">needs {tierLabels[tile.target].toLowerCase()}</span></span>
              <span className="pc-hub-tile__count">{tile.agents.length > 0 && <AgentStack agents={tile.agents.map(runner => markAgent(runner))} size={20} />}<strong>{tile.count}</strong></span>
              <span className="pc-hub-tile__who">{tile.who}</span>
            </li>)}
          </ul></>}
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
              <span className="pc-hub-sizes__who">{listState === "loading" || listState === "failed" ? "" : model.coverage[d]}</span>
            </div>)}
          </div>
          {(changeCount > 0 || !!notice || !!error) && <div className="pc-model-choice__savedock">
            <SaveBar count={changeCount} busy={busy} onDiscard={discard} onSave={() => directSave ? void saveInPlace() : openName()}
              saveLabel={directSave ? "Save" : "Save as a new profile…"} scope={changeCount ? `active profile ${base.strategy}` : undefined} notice={notice || undefined}>
              {changeCount > 0 || error ? <>
                {changeCount > 0 && <div className="pc-hub-save-note"><span>New tasks use the change at once.</span>
                  {directSave && <Button size="sm" variant="quiet" disabled={busy} onClick={openName}>Save as a new profile…</Button>}</div>}
                <ErrorMessage error={error} />
              </> : undefined}
            </SaveBar>
          </div>}
        </section>

        <section className="pc-stack pc-stack--normal" aria-labelledby="hub-agents-h">
          <div className="pc-hub-section-head">
            <div className="pc-hub-section-head__text">
              <SectionHeading id="hub-agents-h">Agents and models</SectionHeading>
              <p className="u3-muted">What each agent runs for each difficulty, from the model inventory read {checkedAt && now - checkedAt >= 60 ? ago(checkedAt, now) : "a moment ago"}. Pacer checks again when it dispatches.</p>
            </div>
            <div className="pc-hub-chips">
              <span className="pc-hub-chips" role="group" aria-label="Show agents">
                {FILTERS.map(item => <FilterChip key={item.value} selected={filter === item.value} disabled={item.value !== "all" && !model.counts[item.value]} onClick={() => setFilter(item.value)}>{item.label} <span className="pc-hub-chip-count">{model.counts[item.value]}</span></FilterChip>)}
              </span>
              <Button variant="ghost" size="sm" busy={refreshing} disabled={!state.connected} aria-label="Refresh all accounts: models, sign-in and usage" onClick={() => void refreshAll()}><Icon name="refresh" />Refresh all</Button>
            </div>
          </div>
          {refreshFailed && <p className="pc-field__error" role="alert">{refreshFailed}</p>}
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

        {dialog && <Dialog title="Save as a new profile" close={() => setDialog(false)}>
          <form className="pc-stack pc-stack--normal" onSubmit={event => { event.preventDefault(); void saveAsNew(); }}>
            <p className="u3-muted">Name the new profile so you can switch back later. The active profile keeps its current choices.</p>
            <Field label="Profile name"><TextInput value={profileName} autoFocus required disabled={busy} onInput={event => setProfileName(event.currentTarget.value)} /></Field>
            <div className="u3-actions">
              <Button variant="ghost" disabled={busy} onClick={() => setDialog(false)}>Cancel</Button>
              <Button type="submit" variant="primary" busy={busy} disabled={!profileName.trim() || busy}>Save and switch to it</Button>
            </div>
          </form>
        </Dialog>}
      </>}
    </ResourceState>
  </div></div>;
}
