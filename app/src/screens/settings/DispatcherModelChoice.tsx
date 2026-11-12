import { useEffect, useRef, useState } from "preact/hooks";
import type { DispatchConfig, TierTargets } from "../../../../src/dispatch/types";
import type { RunnerModels } from "../../../../src/core/runner-models";
import { TIERS } from "../../../../src/dispatch/candidates";
import type { BrowserApi } from "../../data/api";
import { ApiError } from "../../data/api";
import { executorLabel } from "../../../../src/view-model/words";
import { Button, ButtonLink } from "../../ds/Button";
import { Dialog } from "../../ds/Dialog";
import { Field, TextInput } from "../../ds/Controls";
import { Card, FilterChip } from "../../ds/Patterns";
import { RadioGroup, RadioCard } from "../../ds/Composer";
import { SectionHeading } from "../../ds/SectionHeading";
import { ErrorMessage, useTaskContext } from "../task-shared";
import { ResourceState, Section, useResource, useScoped } from "./shared";
import { difficultyLabels, tierLabels } from "../../model/executor-models";
import {
  adjustTier, applyPreset, matchingPreset, PRESETS, PRESET_LABELS, groupPreview,
  unsteeredCopy, RATED_TIERS, DIFFICULTIES, type PresetName, type RatedTier, type Difficulty,
} from "../../model/tier-targets";
import { hrefFor, routes, SETTINGS_SECTIONS } from "../../router";
import type { DispatcherInventory } from "./Dispatcher";
import { withoutPlanner } from "../../model/planner";

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

const TIER_HINT: Record<RatedTier, string> = {
  small: "Cheapest and fastest", medium: "Everyday coding", frontier: "Most capable",
};
const DIFF_HINT: Record<"simple" | "standard" | "complex", string> = {
  simple: "Docs, renames, small fixes", standard: "Features, tests, ordinary bugs", complex: "Cross-cutting changes, hard debugging",
};

export function DispatcherModelChoice({ initialConfig, initialInventory, initialTargets, onSaved }: {
  initialConfig?: ConfigView; initialInventory?: DispatcherInventory; initialTargets?: TierTargets; onSaved?: () => void;
}) {
  const { api, state } = useTaskContext();
  const config = useResource<ConfigView>("dispatch.config.get", {}, initialConfig);
  const inventory = useResource<DispatcherInventory>("dispatch.models", {}, initialInventory);
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
  const dirty = !!targets && !!base && !same(targets, base.config.tierTargets);
  useEffect(() => {
    if (config.data && !dirty) { setBase(config.data); setTargets(config.data.config.tierTargets); }
  }, [config.data]);
  // A runner's configured default is not part of the dispatch.models inventory,
  // so read it the same way the matrix does (runner.models.get) and pass it to
  // the preview. Below-target follow executors are shown as skipped by
  // automatic dispatch and run their default only if picked directly (plain
  // delegation), so the default is not chosen in the preview itself.
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

  // The planner's models are not dispatch targets; exclude them so every count on
  // this screen covers only executors Pacer actually delegates to.
  const records = withoutPlanner(inventory.data?.models ?? [], config.data?.planner, config.data?.plannerAccount);
  const grouping = targets ? groupPreview(records, targets, defaults) : null;
  const preset = targets ? matchingPreset(targets) : "custom";
  const hasMatrix = (SETTINGS_SECTIONS as readonly string[]).includes("models");
  const scoped = useScoped();

  const count = grouping?.total ?? 0;
  const steered = grouping?.steered ?? 0;
  let headline = "Model choice";
  let detail = "Choose the model tier for each task difficulty; harder tasks never get a smaller model.";
  if (count === 0) {
    headline = "No executors in the model inventory yet";
    detail = "When executors are added, rate their models in the model matrix so task difficulty steers which model runs.";
  } else if (steered === 0) {
    headline = "Task difficulty does not change any model yet";
    detail = `${unsteeredCopy(grouping!.unrated.length, grouping!.fixed.length)} Rate models in the model matrix to make these choices count.`;
  } else {
    headline = `Task difficulty now steers ${steered} of ${count} executors`;
    detail = `Simple work goes to ${tierLabels[targets!.simple].toLowerCase()} models and complex work to ${tierLabels[targets!.complex].toLowerCase()} models.`
      + (grouping!.unrated.length ? ` ${grouping!.unrated.length} ${grouping!.unrated.length === 1 ? "executor runs" : "executors run"} an unrated model for every difficulty.` : "")
      + (grouping!.fixed.length ? ` ${grouping!.fixed.length} ${grouping!.fixed.length === 1 ? "executor picks" : "executors pick"} their own model.` : "");
  }

  return <Section id="model-choice" title="Model choice" detail="Choose the model tier for each task difficulty. Harder tasks never get a smaller model; picking one row moves the others to keep that order. Preview uses the current model inventory; availability can change at dispatch time.">
    <ResourceState resource={config}>
      {config.data && targets && base && <>
        <Card className="pc-model-choice__answer">
          <div className="pc-model-choice__count"><strong>{steered}<span> of {count}</span></strong><span className="u3-muted">executors follow it</span></div>
          <div className="pc-model-choice__copy"><strong>{headline}</strong><span className="u3-muted">{detail}</span></div>
          {hasMatrix && steered === 0 && count > 0 && <div className="u3-actions"><ButtonLink href={scoped(hrefFor(routes.settings("models")))} variant="secondary" size="sm">Open model matrix</ButtonLink></div>}
        </Card>

        <div className="pc-model-choice__presets" role="group" aria-label="Presets">
          <span className="u3-muted">Presets</span>
          {(Object.keys(PRESETS) as PresetName[]).map(name =>
            <FilterChip key={name} selected={preset === name} disabled={busy} onClick={() => pickPreset(name)}>{PRESET_LABELS[name]}</FilterChip>)}
          {preset === "custom" && <span className="pc-model-choice__preset-note">Custom</span>}
        </div>

        <div className="pc-tier-grid">
          <div className="pc-tier-grid__head">
            <span className="u3-muted">Task difficulty</span>
            {RATED_TIERS.map(t => <div className="pc-tier-grid__colhead" key={t}>{tierLabels[t]}<span className="u3-muted">{TIER_HINT[t]}</span></div>)}
          </div>
          {DIFFICULTIES.map(d => (
            <div className="pc-tier-grid__row" key={d}>
              <div className="pc-tier-grid__label">{difficultyLabels[d]}<span className="u3-muted">{DIFF_HINT[d]}</span></div>
              <RadioGroup label={`${difficultyLabels[d]} tasks`} className="pc-tier-grid__radios">
                {RATED_TIERS.map(t => (
                  <RadioCard key={t} checked={targets[d] === t} disabled={busy} onSelect={() => pickTier(d, t)} title={tierLabels[t]} sub="" />
                ))}
              </RadioGroup>
            </div>
          ))}
        </div>

        <div className="pc-model-choice__preview">
          <SectionHeading>What each executor would run</SectionHeading>
          <p className="u3-muted">From the model inventory read a moment ago. Pacer checks availability again when it dispatches.</p>
          <ResourceState resource={inventory}>
            {grouping && <div className="pc-model-preview">
              <div className="pc-model-preview__head">
                <span className="u3-muted">Executor</span>
                {grouping.cols.map(col => (
                  <div className="pc-model-preview__colhead" key={col.difficulty}>{difficultyLabels[col.difficulty]}<span className="u3-muted">Target {tierLabels[col.target].toLowerCase()} · {col.eligible} of {grouping.total} can take it</span></div>
                ))}
              </div>
              {!grouping.follow.length && !grouping.unrated.length && !grouping.fixed.length &&
                <div className="pc-model-preview__empty u3-muted">No executors in the model inventory.</div>}

              {grouping.follow.length > 0 && <>
                <div className="pc-model-preview__group"><strong>Follow the tier · {grouping.follow.length}</strong><span className="u3-muted">A larger model steps in when the target tier has nothing free.</span></div>
                {grouping.follow.map(row => (
                  <div className="pc-model-preview__row" key={row.runner}>
                    <div className="pc-model-preview__label">{executorLabel(row.runner)}<span className="u3-muted">{row.runner} · {row.model} · rated {tierLabels[row.tier ?? "unknown"].toLowerCase()}</span></div>
                    {row.cells.map(cell => (
                      <div className="pc-model-preview__cell" key={cell.difficulty}>
                        {cell.skipped
                          ? <span className="pc-model-preview__chosen">{cell.chosen}<span className="u3-muted pc-model-preview__note"> · {cell.note}</span></span>
                          : <span className="pc-model-preview__chosen">{cell.chosen}<span className="u3-muted pc-model-preview__note"> · {cell.note}</span></span>}
                      </div>
                    ))}
                  </div>
                ))}
              </>}

              {grouping.unrated.length > 0 && <>
                <div className="pc-model-preview__group"><strong>Unrated · tier ignored · {grouping.unrated.length}</strong><span className="u3-muted">Each runs its one model for every difficulty until you rate it in the model matrix.</span></div>
                {grouping.unrated.map(row => (
                  <div className="pc-model-preview__row" key={row.runner}>
                    <div className="pc-model-preview__label">{executorLabel(row.runner)}<span className="u3-muted">{row.runner}</span></div>
                    <div className="pc-model-preview__cell pc-model-preview__cell--span u3-muted">{row.model} for every difficulty</div>
                  </div>
                ))}
              </>}

              {grouping.fixed.length > 0 && <>
                <div className="pc-model-preview__group"><strong>Choose their own model · {grouping.fixed.length}</strong><span className="u3-muted">These executors pick a model themselves, so they can take any difficulty.</span></div>
                <div className="pc-model-preview__chips">
                  {grouping.fixed.map(row => <span className="u3-chip" key={row.runner}><strong>{executorLabel(row.runner)}</strong><span className="u3-muted">{row.runner}</span></span>)}
                </div>
              </>}
            </div>}
          </ResourceState>
        </div>

        {(dirty || notice) && <div className="pc-model-choice__savedock">
          {dirty && <div className="u3-save-bar">
            <div className="pc-model-choice__savecopy">
              <span role="status" aria-live="polite">{busy ? "Saving…" : `${changeCount} unsaved change${changeCount === 1 ? "" : "s"}`}</span>
              <span className="u3-muted">Saving updates the active setup “{base?.strategy}”. New tasks use it at once.</span>
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
  </Section>;
}
