import { useEffect, useRef, useState } from "preact/hooks";
import type { AvailableModel, AvailableModels } from "../../../../src/models/available";
import type { RunnerModels } from "../../../../src/core/runner-models";
import type { DispatchConfig, TierTargets } from "../../../../src/dispatch/types";
import type { DispatcherInventory } from "./Dispatcher";
import { TIERS } from "../../../../src/dispatch/candidates";
import { Button } from "../../ds/Button";
import { Field, TextInput, Switch } from "../../ds/Controls";
import { Card, FilterChip } from "../../ds/Patterns";
import { RadioGroup, RadioChip } from "../../ds/Composer";
import { Section, useResource, ResourceState } from "./shared";
import { ErrorMessage, useTaskContext } from "../task-shared";
import { executorLabel } from "../../../../src/view-model/words";
import {
  createDraft, suggestRows, acceptSuggestion, acceptAllSuggestions,
  dismissSuggestions, toggleModel, setTier, addModel, isDirty, buildSavePlan,
  takesFor, formatPrice, formatContext, formatTools,
  type MatrixRow, type MatrixDraft, type MatrixTier,
} from "../../model/model-matrix";
import { plannerRunner } from "../../model/planner";

interface ConfigView { strategy: string; planner: string; plannerAccount: string; source: "built-in" | "strategy"; config: DispatchConfig }

type DeclaredResult = { ok: true; value: RunnerModels } | { ok: false; error: unknown };

interface LoadedRow {
  id: string;
  available: AvailableModels;
  declared: DeclaredResult;
}

interface LoadResult {
  avail: Record<string, AvailableModels>;
  drafts: MatrixDraft[];
  errors: Record<string, string>;
}

/** Routine warnings the matrix already reflects; the interesting ones stay on screen. */
const ROUTINE_WARNINGS = /^runners\..+: (?:model ".*" is unrated \(tier unknown\)|default model ".*" is not in models)$/;

function messageOf(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as { message?: unknown; code?: unknown };
    if (typeof record.message === "string" && record.message) return record.message;
    if (typeof record.code === "string" && record.code) return record.code;
  }
  return "Could not load this runner's models.";
}

function isConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; message?: unknown };
  return record.code === "conflict" || /changed elsewhere/i.test(String(record.message ?? ""));
}

/** Stable signature of the runner-model decisions a load would apply: each runner's
 * default and each model's on/tier. Used to tell a genuinely different load
 * ("settings changed elsewhere") from an unrelated refresh with identical models. */
function modelSignature(drafts: MatrixDraft[]): string {
  return JSON.stringify(
    [...drafts]
      .sort((a, b) => (a.runner < b.runner ? -1 : a.runner > b.runner ? 1 : 0))
      .map(d => ({
        runner: d.runner,
        default: d.default,
        rows: [...d.rows]
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .map(r => ({ id: r.id, on: r.on, tier: r.tier })),
      })),
  );
}

export function ModelMatrix({ initialConfig, initialInventory }: { initialConfig?: ConfigView; initialInventory?: DispatcherInventory }) {
  const { api } = useTaskContext();
  const config = useResource<ConfigView>("dispatch.config.get", {}, initialConfig);
  const inventory = useResource<DispatcherInventory>("dispatch.models", {}, initialInventory);
  const targets: TierTargets = config.data?.config?.tierTargets ?? { simple: "small", standard: "medium", complex: "frontier" };

  const [runnerIds, setRunnerIds] = useState<string[]>([]);
  const [availableById, setAvailableById] = useState<Record<string, AvailableModels>>({});
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<MatrixDraft[]>([]);
  const [baseDrafts, setBaseDrafts] = useState<MatrixDraft[]>([]);
  const [loadedRevision, setLoadedRevision] = useState<string>("");
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [addingByRunner, setAddingByRunner] = useState<Record<string, string>>({});
  const [suggestPhase, setSuggestPhase] = useState(false);
  const pending = useRef(false);
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const runnerIdsRef = useRef(runnerIds);
  runnerIdsRef.current = runnerIds;
  const dirty = drafts.some((d, i) => isDirty(d.rows, baseDrafts[i]?.rows ?? d.rows) || d.default !== (baseDrafts[i]?.default ?? null));
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  // The base the current unsaved edits build on, read fresh when a load resolves
  // so we can tell a real external change from an unrelated refresh.
  const baseDraftsRef = useRef(baseDrafts);
  baseDraftsRef.current = baseDrafts;

  useEffect(() => {
    if (!inventory.data) return;
    const ids = [...new Set(inventory.data.models.map(m => m.runner))].sort();
    const current = [...runnerIdsRef.current].sort();
    // Only change when the set of runners genuinely changes, so a config event
    // does not re-send the whole matrix while the page is dirty.
    if (ids.length !== current.length || ids.some((v, i) => v !== current[i])) setRunnerIds(ids);
  }, [inventory.data]);

  const fetchAll = async (ids: string[]): Promise<LoadResult> => {
    const t = targetsRef.current;
    const rows: LoadedRow[] = await Promise.all(ids.map(async (id): Promise<LoadedRow> => {
      const available = await api.call<AvailableModels>("executor.models.available", { runner: id })
        .catch(() => ({ runner: id, source: "none", models: null, fetchedAt: Date.now() } as AvailableModels));
      const declared = await api.call<RunnerModels>("runner.models.get", { id })
        .then((value): DeclaredResult => ({ ok: true, value }))
        .catch((source: unknown): DeclaredResult => ({ ok: false, error: source }));
      return { id, available, declared };
    }));
    const avail: Record<string, AvailableModels> = {};
    const errors: Record<string, string> = {};
    const nextDrafts: MatrixDraft[] = [];
    for (const row of rows) {
      avail[row.id] = row.available;
      if (row.declared.ok) {
        const declared = row.declared.value;
        const listing = row.available.models
          ? row.available.models.map((m: AvailableModel) => ({ id: m.id, context: m.context, tools: m.tools, costOut: m.costOut }))
          : null;
        nextDrafts.push(createDraft(row.id, declared.revision, declared.default, declared.models, listing, t));
      } else {
        errors[row.id] = messageOf(row.declared.error);
      }
    }
    return { avail, drafts: nextDrafts, errors };
  };

  const applyLoaded = (loaded: LoadResult) => {
    setAvailableById(loaded.avail);
    setLoadErrors(loaded.errors);
    setDrafts(loaded.drafts);
    setBaseDrafts(loaded.drafts.map(d => ({ ...d, rows: d.rows.map(r => ({ ...r })), baseRows: d.baseRows.map(r => ({ ...r })) })));
    setLoadedRevision(loaded.drafts[0]?.revision ?? "");
  };

  useEffect(() => {
    if (!runnerIds.length) return;
    let active = true;
    // Never silently discard unsaved edits: a load that finishes after the user
    // edited keeps their drafts. It surfaces the "settings changed elsewhere"
    // prompt only when the freshly loaded runner models (default + per-model
    // on/tier) genuinely differ from what the drafts build on; an unrelated
    // refresh with identical models stays silent.
    void fetchAll(runnerIds).then(loaded => {
      if (!active) return;
      if (dirtyRef.current) {
        if (modelSignature(loaded.drafts) !== modelSignature(baseDraftsRef.current)) {
          // Real external change: keep the drafts, fold in the loaded revision
          // baseline so a later save runs against the newest revision, and ask
          // the user to Discard if they want the loaded models.
          setLoadedRevision(loaded.drafts[0]?.revision ?? "");
          setConflict(true);
          setNotice("Model settings changed elsewhere. Discard to load them.");
        }
        return;
      }
      applyLoaded(loaded);
    });
    return () => { active = false; };
  }, [runnerIds, JSON.stringify(targets), inventory.data]);

  const plannerId = plannerRunner(inventory.data?.models ?? [], config.data?.planner, config.data?.plannerAccount);
  const isPlanner = (runnerId: string) => runnerId === plannerId;
  // The planner and any runner whose models failed to load are read-only: editing
  // them is meaningless, and saving them would make runner.models.set_many fail.
  const isReadOnly = (runnerId: string) => isPlanner(runnerId) || !!loadErrors[runnerId];

  const runners = runnerIds.map(id => {
    const draft = drafts.find(d => d.runner === id);
    const available = availableById[id];
    const loadError = loadErrors[id];
    const account = inventory.data?.models.find(m => m.runner === id)?.account;
    return { id, draft, available, loadError, account };
  });

  /** Show the listing provider only when it adds information: absent or equal to the account name, do not repeat it. */
  const displayProvider = (r: { available?: AvailableModels; account?: string }): string | null => {
    const provider = r.available?.provider;
    return provider && provider !== r.account ? provider : null;
  };

  const updateDraft = (runner: string, updater: (draft: MatrixDraft) => MatrixDraft) => {
    setDrafts(prev => prev.map(d => d.runner === runner ? updater(d) : d));
  };

  const handleToggle = (runner: string, rowId: string, nextOn: boolean) => {
    updateDraft(runner, d => {
      const result = toggleModel(d.rows, rowId, nextOn, d.default);
      return { ...d, rows: result.rows, default: result.default };
    });
  };

  const handleTier = (runner: string, rowId: string, tier: MatrixTier) => {
    updateDraft(runner, d => ({ ...d, rows: setTier(d.rows, rowId, tier) }));
  };

  const handleAccept = (runner: string, rowId: string) => {
    updateDraft(runner, d => ({ ...d, rows: d.rows.map(r => r.id === rowId ? acceptSuggestion(r) : r) }));
  };

  const handleSuggest = () => {
    setSuggestPhase(true);
    setDrafts(prev => prev.map(d => {
      if (isReadOnly(d.runner)) return d;
      const available = availableById[d.runner];
      const listingById = new Map((available?.models ?? []).map((m: AvailableModel) => [m.id, { id: m.id, context: m.context, tools: m.tools, costOut: m.costOut }]));
      const suggested = suggestRows(d.rows, listingById);
      return { ...d, rows: suggested };
    }));
  };

  const handleAcceptAll = () => {
    setDrafts(prev => prev.map(d => isReadOnly(d.runner) ? d : ({ ...d, rows: acceptAllSuggestions(d.rows) })));
    setSuggestPhase(false);
  };

  const handleDismissAll = () => {
    setDrafts(prev => prev.map(d => isReadOnly(d.runner) ? d : ({ ...d, rows: dismissSuggestions(d.rows) })));
    setSuggestPhase(false);
  };

  const handleAdd = (runner: string) => {
    const value = (addingByRunner[runner] ?? "").trim();
    if (!value) return;
    updateDraft(runner, d => {
      if (d.rows.some(row => row.id === value)) return d;
      const rows = addModel(d.rows, value);
      const nextDefault = d.default ?? (rows.length === 1 ? value : null);
      return { ...d, rows, default: nextDefault };
    });
    setAddingByRunner(prev => ({ ...prev, [runner]: "" }));
  };

  const changedModelCount = drafts.reduce((total, d, i) => {
    const baseRows = baseDrafts[i]?.rows ?? [];
    const ids = new Set([...d.rows.map(r => r.id), ...baseRows.map(r => r.id)]);
    let n = 0;
    for (const id of ids) {
      const a = d.rows.find(r => r.id === id);
      const b = baseRows.find(r => r.id === id);
      if (!a || !b) { n++; continue; }
      if (a.on !== b.on || a.tier !== b.tier) n++;
    }
    return total + n;
  }, 0);

  const blockedGroups = runners.filter(({ id, draft }) => {
    if (!draft) return false;
    if (isPlanner(id)) return false;
    const noDefault = draft.default == null;
    const allOff = draft.rows.length > 0 && draft.rows.every(r => !r.on);
    return noDefault && allOff;
  });

  const handleDiscard = () => {
    void (async () => {
      setBusy(true);
      setError(undefined);
      setNotice("");
      setConflict(false);
      setSuggestPhase(false);
      try {
        applyLoaded(await fetchAll(runnerIds));
      } catch (loadError) {
        setError(loadError);
      } finally {
        setBusy(false);
      }
    })();
  };

  const handleSave = async () => {
    if (pending.current || !dirty || blockedGroups.length > 0) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    setNotice("");
    setConflict(false);
    try {
      const editable = drafts.filter(d => !isReadOnly(d.runner));
      const plan = buildSavePlan(editable.map(d => {
        const base = baseDrafts.find(b => b.runner === d.runner);
        return {
          runner: d.runner,
          revision: d.revision,
          baseRows: base?.rows ?? d.rows,
          rows: d.rows,
          default: d.default,
          baseDefault: base?.default ?? null,
        };
      }), targets, drafts[0]?.revision ?? "");
      if (!plan.changed) {
        setNotice("No changes.");
        return;
      }
      const result = await api.call<{ revision: string; runners: RunnerModels[]; warnings?: string[] }>("runner.models.set_many", {
        expectedRevision: loadedRevision || drafts[0]?.revision || "",
        runners: plan.runners,
      });
      const newRevision = result.revision;
      const returned = new Map<string, RunnerModels>(result.runners.map(r => [r.runner, r]));
      // Fold the service's returned revision, defaults and declared models into
      // each draft so the page is clean, a second save sends the new revision,
      // and saved strengths/tools/context stay in the draft.
      const saved = drafts.map(d => {
        const r = returned.get(d.runner);
        const declaredById = new Map((r?.models ?? []).map(m => [m.id, m]));
        const rows = d.rows.map(row => {
          const declaration = declaredById.get(row.id);
          return declaration ? { ...row, declared: declaration } : row;
        });
        return {
          runner: d.runner,
          revision: newRevision,
          default: r?.default ?? d.default,
          rows: rows.map(row => ({ ...row })),
          baseRows: rows.map(row => ({ ...row })),
          addedIds: [],
        };
      });
      setDrafts(saved);
      setBaseDrafts(saved);
      setLoadedRevision(newRevision);
      inventory.reload();
      const warnings = (result.warnings ?? []).filter(w => !ROUTINE_WARNINGS.test(w));
      setNotice(warnings.length ? `Saved. ${warnings.join(" ")}` : "Saved.");
    } catch (e) {
      if (isConflict(e)) {
        setConflict(true);
        setNotice("Model settings changed elsewhere. Discard to load them.");
      } else {
        setError(e);
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const filters = [
    { key: "all", label: "All agents" },
    ...runners.map(r => {
      const provider = displayProvider(r);
      return { key: r.id, label: provider ? `${executorLabel(r.id)} › ${provider}` : executorLabel(r.id) };
    }),
  ];

  const visibleRunners = filter === "all" ? runners : runners.filter(r => r.id === filter);

  return (
    <Section id="models" title="Model matrix" detail="Every model each agent can run.">
      <ResourceState resource={config}>
        {config.data && (
          <ResourceState resource={inventory}>
            {inventory.data && (
              <>
                {/* Suggestion card at top */}
                <Card className="pc-model-matrix__suggest">
                  {!suggestPhase ? (
                    <>
                      <strong>Suggest from listings</strong>
                      <span className="u3-muted">Proposes which models to turn on and what size each is, from each provider's price and tool support. Nothing changes until you save.</span>
                      <div className="u3-actions">
                        <Button size="sm" variant="secondary" onClick={handleSuggest}>Suggest</Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <strong>Suggestions applied</strong>
                      <span className="u3-muted">Highlighted rows. Accept them one by one, or all at once.</span>
                      <div className="u3-actions">
                        <Button size="sm" variant="ghost" onClick={handleDismissAll}>Dismiss</Button>
                        <Button size="sm" variant={dirty ? "secondary" : "primary"} onClick={handleAcceptAll}>Accept all</Button>
                      </div>
                    </>
                  )}
                </Card>

                <div className="pc-model-matrix__filters">
                  {filters.map(f => (
                    <FilterChip key={f.key} selected={filter === f.key} onClick={() => setFilter(f.key)}>{f.label}</FilterChip>
                  ))}
                </div>

                {visibleRunners.map(({ id, draft, available, loadError, account }) => {
                  const planner = isPlanner(id);
                  const shownProvider = displayProvider({ available, account });
                  const listingModels = available?.models ?? null;
                  const unknownListing = available?.source === "none" || listingModels === null;
                  const noModels = (listingModels?.length ?? 0) === 0 && (draft?.rows.length ?? 0) === 0;
                  const readOnly = planner || !!loadError;
                  return (
                    <div key={id} className="pc-model-matrix__group">
                      <div className="pc-model-matrix__group-head">
                        <strong>{executorLabel(id)}</strong>
                        {shownProvider && <span className="u3-muted">› {shownProvider}</span>}
                        <span className="mono u3-muted">{id}</span>
                        {draft && <span className="u3-muted">{draft.rows.length} model{draft.rows.length === 1 ? "" : "s"} · {draft.rows.filter(r => r.on).length} on</span>}
                      </div>
                      {planner && <p className="u3-muted">Planner. Pacer does not dispatch tasks to it, so its models are not edited here.</p>}
                      {loadError && <p className="u3-muted">{loadError}</p>}
                      {!readOnly && noModels && <p className="u3-muted">Uses its default and can take any difficulty</p>}
                      {!readOnly && unknownListing && (
                        <form className="pc-model-matrix__add" onSubmit={event => { event.preventDefault(); handleAdd(id); }}>
                          <Field label="Add model"><TextInput value={addingByRunner[id] ?? ""} onInput={e => setAddingByRunner(prev => ({ ...prev, [id]: e.currentTarget.value }))} /></Field>
                          <Button size="sm" type="submit">Add</Button>
                        </form>
                      )}
                      {draft && !noModels && (
                        <div className="pc-model-matrix__table-wrap">
                          <div className="pc-model-matrix__table" role="table">
                            <div className="pc-model-matrix__head" role="row">
                              <span role="columnheader">On</span>
                              <span role="columnheader">Model</span>
                              <span role="columnheader">Context</span>
                              <span role="columnheader">Tools</span>
                              <span role="columnheader">Price</span>
                              <span role="columnheader">Size</span>
                              <span role="columnheader">Takes</span>
                            </div>
                            {draft.rows.map(row => {
                              const pendingRow = suggestPhase && row.pending;
                              const listing = listingModels?.find(m => m.id === row.id);
                              const takes = takesFor(row.tier, targets);
                              return (
                                <div key={row.id} role="row" className={`pc-model-matrix__row ${pendingRow ? "pc-model-matrix__row--pending" : ""}`}>
                                  <span role="cell"><Switch checked={row.on} aria-label={`Use ${row.id}`} disabled={readOnly} onChange={e => { if (!readOnly) handleToggle(id, row.id, !!e.currentTarget.checked); }} /></span>
                                  <div role="cell">
                                    <span className="pc-model-matrix__mono">{row.id}</span>
                                    {draft.default === row.id && <span className="pc-model-matrix__tag">Default</span>}
                                    <div className="u3-muted">{pendingRow ? `Suggested: ${row.suggestedOn ? "turn on" : "leave off"}${row.suggestedTier ? ", " + row.suggestedTier : ""}. ${row.suggestionReason ?? ""}` : ""}</div>
                                  </div>
                                  <span role="cell" className="pc-model-matrix__mono">{formatContext(row.context)}</span>
                                  <span role="cell">{formatTools(row.tools)}</span>
                                  <span role="cell">{formatPrice(row.costOut)}</span>
                                  <span role="cell"><RadioGroup label={`Size of ${row.id}`}>
                                    {(["small", "medium", "frontier"] as MatrixTier[]).map(tier => (
                                      <RadioChip
                                        key={tier}
                                        checked={row.tier === tier}
                                        disabled={readOnly}
                                        onSelect={() => { if (!readOnly) handleTier(id, row.id, tier); }}
                                      >{tier.charAt(0).toUpperCase() + tier.slice(1)}</RadioChip>
                                    ))}
                                    <RadioChip
                                      checked={row.tier === "unknown"}
                                      disabled={readOnly}
                                      onSelect={() => { if (!readOnly) handleTier(id, row.id, "unknown"); }}
                                    >Unrated</RadioChip>
                                  </RadioGroup></span>
                                  <div role="cell">
                                    <span className="u3-muted">{row.on ? (row.tier === "unknown" ? "Any, unrated" : takes.map(t => t.charAt(0).toUpperCase() + t.slice(1)).join(", ") || "—") : "Off"}</span>
                                    {pendingRow && !readOnly && <Button size="sm" variant="ghost" aria-label={`Accept suggestion for ${row.id}`} onClick={() => handleAccept(id, row.id)}>Accept</Button>}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Coverage cards: count only dispatch targets; the planner is not one. */}
                <div className="pc-model-matrix__coverage">
                  {(["simple", "standard", "complex"] as const).map(diff => {
                    const count = drafts
                      .filter(d => !isPlanner(d.runner))
                      .flatMap(d => d.rows)
                      .filter(r => r.on && r.tier !== "unknown" && TIERS[r.tier as keyof typeof TIERS] >= TIERS[targets[diff]]).length;
                    const defaultExecutors = runners.filter(({ id, draft }) => {
                      if (isPlanner(id)) return false;
                      const rated = draft?.rows.filter(r => r.on && r.tier !== "unknown") ?? [];
                      return rated.length === 0;
                    }).length;
                    return (
                      <div key={diff} className="pc-card">
                        <span>{diff.charAt(0).toUpperCase() + diff.slice(1)} · needs {targets[diff]}</span>
                        <span>{count} {count === 1 ? "model" : "models"}</span>
                        <span className="u3-muted">Plus {defaultExecutors} {defaultExecutors === 1 ? "executor that uses its default model" : "executors that use their default model"}.</span>
                      </div>
                    );
                  })}
                </div>

                {blockedGroups.length > 0 && (
                  <p className="u3-muted">Some runners have no default model and all models off; turn a model on or set a default before saving.</p>
                )}

                {notice && <p role="status">{notice}</p>}
                <ErrorMessage error={error} />

                {dirty && (
                  <div className="pc-model-matrix__savebar" role="region" aria-label="Unsaved changes">
                    <span>{changedModelCount === 1 ? "1 model changed" : `${changedModelCount} models changed`}</span>
                    <div className="u3-actions">
                      <Button variant="ghost" disabled={busy} onClick={handleDiscard}>Discard</Button>
                      <Button variant="primary" busy={busy} disabled={blockedGroups.length > 0} onClick={() => void handleSave()}>Save matrix</Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </ResourceState>
        )}
      </ResourceState>
    </Section>
  );
}