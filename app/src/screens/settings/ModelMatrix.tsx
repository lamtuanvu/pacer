import { useEffect, useRef, useState } from "preact/hooks";
import type { AvailableModel, AvailableModels } from "../../../../src/models/available";
import type { ModelDeclaration, RunnerModels } from "../../../../src/core/runner-models";
import type { DispatchConfig, TierTargets } from "../../../../src/dispatch/types";
import type { DispatcherInventory } from "./Dispatcher";
import { TIERS } from "../../../../src/dispatch/candidates";
import { Button, ButtonLink, TextAction } from "../../ds/Button";
import { Field, TextInput, Switch } from "../../ds/Controls";
import { Card, FilterChip } from "../../ds/Patterns";
import { RadioGroup, RadioChip } from "../../ds/Composer";
import { Section, useResource, ResourceState } from "./shared";
import { ErrorMessage, useTaskContext } from "../task-shared";
import { executorLabel } from "../../../../src/view-model/words";
import { suggestTier } from "../../model/executor-models";
import {
  createDraft, mergeRows, applyTakes, suggestRows, acceptSuggestion, acceptAllSuggestions,
  dismissSuggestions, toggleModel, setTier, addModel, isDirty, buildSavePlan, takesFor,
  formatPrice, formatContext, formatTools,
  type MatrixRow, type MatrixDraft, type MatrixTier,
} from "../../model/model-matrix";

interface ConfigView { strategy: string; planner: string; plannerAccount: string; source: "built-in" | "strategy"; config: DispatchConfig }

export function ModelMatrix({ initialConfig, initialInventory }: { initialConfig?: ConfigView; initialInventory?: DispatcherInventory }) {
  const { api, state } = useTaskContext();
  const config = useResource<ConfigView>("dispatch.config.get", {}, initialConfig);
  const inventory = useResource<DispatcherInventory>("dispatch.models", {}, initialInventory);
  const targets: TierTargets = config.data?.config?.tierTargets ?? { simple: "small", standard: "medium", complex: "frontier" };

  const [runnerIds, setRunnerIds] = useState<string[]>([]);
  const [availableById, setAvailableById] = useState<Record<string, AvailableModels>>({});
  const [declaredById, setDeclaredById] = useState<Record<string, RunnerModels>>({});
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

  useEffect(() => {
    if (!inventory.data) return;
    const ids = [...new Set(inventory.data.models.map(m => m.runner))];
    setRunnerIds(ids);
  }, [inventory.data]);

  useEffect(() => {
    if (!runnerIds.length) return;
    let active = true;
    void Promise.all(runnerIds.map(async id => {
      const [available, declaredResult] = await Promise.all([
        api.call<AvailableModels>("executor.models.available", { runner: id }).catch(() => ({ runner: id, source: "none", models: null, fetchedAt: Date.now() } as AvailableModels)),
        api.call<RunnerModels>("runner.models.get", { id }).then(r => ({ ok: true as const, value: r })).catch((e: any) => ({ ok: false as const, error: e })),
      ]);
      return { id, available, declaredResult };
    })).then(results => {
      if (!active) return;
      const avail: Record<string, AvailableModels> = {};
      const decl: Record<string, RunnerModels> = {};
      const errs: Record<string, string> = {};
      const nextDrafts: MatrixDraft[] = [];
      const t = targetsRef.current;
      for (const result of results as any[]) {
        avail[result.id] = result.available;
        if (result.declaredResult.ok) {
          const declared = result.declaredResult.value;
          decl[result.id] = declared;
          const listing = result.available.models ? result.available.models.map((m: AvailableModel) => ({ id: m.id, context: m.context, tools: m.tools, costOut: m.costOut })) : null;
          const draft = createDraft(result.id, declared.revision, declared.default, declared.models, listing, t);
          nextDrafts.push(draft);
        } else {
          const e = result.declaredResult.error;
          errs[result.id] = (e && (e.message || e.code)) ? String(e.message || e.code) : "Could not load this runner's models.";
        }
      }
      setAvailableById(avail);
      setDeclaredById(decl);
      setLoadErrors(errs);
      setDrafts(nextDrafts);
      setBaseDrafts(nextDrafts.map(d => ({ ...d, rows: d.rows.map(r => ({ ...r })), baseRows: d.baseRows.map(r => ({ ...r })) })));
      setLoadedRevision(nextDrafts[0]?.revision ?? "");
    });
    return () => { active = false; };
  }, [runnerIds, JSON.stringify(targets)]);

  const isPlanner = (runnerId: string) => {
    const records = inventory.data?.models?.filter(m => m.runner === runnerId) ?? [];
    const agentPart = runnerId.split(/[#@]/)[0];
    const noHost = !runnerId.includes("@");
    if (agentPart !== config.data?.planner || !noHost) return false;
    if (records.length > 0) return records.some(m => m.account === config.data?.plannerAccount);
    return true;
  };

  const runners = runnerIds.map(id => {
    const draft = drafts.find(d => d.runner === id);
    const available = availableById[id];
    const declared = declaredById[id];
    const loadError = loadErrors[id];
    return { id, draft, available, declared, loadError };
  });

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
      const available = availableById[d.runner];
      const listingById = new Map((available?.models ?? []).map((m: AvailableModel) => [m.id, { id: m.id, context: m.context, tools: m.tools, costOut: m.costOut }]));
      const suggested = suggestRows(d.rows, listingById);
      return { ...d, rows: suggested };
    }));
  };

  const handleAcceptAllAll = () => {
    setDrafts(prev => prev.map(d => ({ ...d, rows: acceptAllSuggestions(d.rows) })));
    setSuggestPhase(false);
  };

  const handleDismissAll = () => {
    setDrafts(prev => prev.map(d => ({ ...d, rows: dismissSuggestions(d.rows) })));
    setSuggestPhase(false);
  };

  const handleAdd = (runner: string) => {
    const value = addingByRunner[runner] ?? "";
    updateDraft(runner, d => ({ ...d, rows: addModel(d.rows, value) }));
    setAddingByRunner(prev => ({ ...prev, [runner]: "" }));
  };

  const dirty = drafts.some((d, i) => isDirty(d.rows, baseDrafts[i]?.rows ?? d.rows) || d.default !== (baseDrafts[i]?.default ?? null));

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
    // also all off with no rows? if no rows, default unchanged maybe not blocked
    return noDefault && allOff;
  });

  const handleDiscard = () => {
    // reload from service
    void (async () => {
      setBusy(true);
      setError(undefined);
      setNotice("");
      setConflict(false);
      setSuggestPhase(false);
      try {
        const ids = runnerIds;
        const results = await Promise.all(ids.map(async id => {
          const [available, declared] = await Promise.all([
            api.call<AvailableModels>("executor.models.available", { runner: id }).catch(() => ({ runner: id, source: "none", models: null, fetchedAt: Date.now() } as AvailableModels)),
            api.call<RunnerModels>("runner.models.get", { id }).catch(() => null),
          ]);
          return { id, available, declared };
        }));
        const avail: Record<string, AvailableModels> = {};
        const decl: Record<string, RunnerModels> = {};
        const errs: Record<string, string> = {};
        const nextDrafts: MatrixDraft[] = [];
        for (const result of results as any[]) {
          avail[result.id] = result.available;
          if (result.declared) {
            decl[result.id] = result.declared;
            const listing = result.available.models ? result.available.models.map((m: AvailableModel) => ({ id: m.id, context: m.context, tools: m.tools, costOut: m.costOut })) : null;
            const draft = createDraft(result.id, result.declared.revision, result.declared.default, result.declared.models, listing, targets);
            nextDrafts.push(draft);
          } else {
            errs[result.id] = loadErrors[result.id] ?? "Could not load this runner's models.";
          }
        }
        setAvailableById(avail);
        setDeclaredById(decl);
        setLoadErrors(errs);
        setDrafts(nextDrafts);
        setBaseDrafts(nextDrafts.map(d => ({ ...d, rows: d.rows.map(r => ({ ...r })), baseRows: d.baseRows.map(r => ({ ...r })) })));
        setLoadedRevision(nextDrafts[0]?.revision ?? "");
      } catch (e) {
        setError(e);
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
      const plan = buildSavePlan(drafts.map((d, i) => ({
        runner: d.runner,
        revision: d.revision,
        baseRows: baseDrafts[i]?.rows ?? d.rows,
        rows: d.rows,
        default: d.default,
      })), targets, drafts[0]?.revision ?? "");
      if (!plan.changed) {
        setNotice("No changes.");
        return;
      }
      const result = await api.call<{ revision: string; runners: RunnerModels[]; warnings?: string[] }>("runner.models.set_many", {
        expectedRevision: loadedRevision || drafts[0]?.revision || "",
        runners: plan.runners,
      });
      // use loaded revision? plan uses d.revision already; expectedRevision should be loaded revision common.
      const newRevision = result.revision;
      setDrafts(prev => prev.map(d => ({ ...d, revision: newRevision, baseRows: d.rows.map(r => ({ ...r })) })));
      setBaseDrafts(prev => prev.map(d => ({ ...d, rows: d.rows.map(r => ({ ...r })), baseRows: d.baseRows.map(r => ({ ...r })) })));
      const warnings = result.warnings ?? [];
      if (warnings.length) setNotice(warnings.join(" "));
      else setNotice("Saved.");
    } catch (e: any) {
      if (e && (e.code === "conflict" || /changed elsewhere/i.test(String(e.message)))) {
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

  // Conflict safety: Save must send revision drafts were LOADED with (all runner.models.get at load return same strategy revision; keep one loadedRevision)
  // We store loaded revision per draft; but expectedRevision should be the common loaded revision. Use drafts[0].revision (loaded).
  // However handleSave currently uses drafts[0]?.revision. Good. But we fetch no fresh revision. Good.

  const filters = [
    { key: "all", label: "All agents" },
    ...runners.map(r => ({ key: r.id, label: `${executorLabel(r.id)} › ${r.available?.provider ?? r.id}` })),
  ];

  const visibleRunners = filter === "all" ? runners : runners.filter(r => r.id === filter);

  // Keep one loadedRevision? drafts all share revision from load. Fine.

  return (
    <Section id="model-matrix" title="Model matrix" detail="Every model each agent can run.">
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
                        <Button size="sm" variant="primary" onClick={handleSuggest}>Suggest</Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <strong>Suggestions applied</strong>
                      <span className="u3-muted">Highlighted rows. Accept them one by one, or all at once.</span>
                      <div className="u3-actions">
                        <Button size="sm" variant="ghost" onClick={handleDismissAll}>Dismiss</Button>
                        <Button size="sm" variant="primary" onClick={handleAcceptAllAll}>Accept all</Button>
                      </div>
                    </>
                  )}
                </Card>

                <div className="pc-model-matrix__filters">
                  {filters.map(f => (
                    <FilterChip key={f.key} selected={filter === f.key} onClick={() => setFilter(f.key)}>{f.label}</FilterChip>
                  ))}
                </div>

                {visibleRunners.map(({ id, draft, available, loadError }) => {
                  const planner = isPlanner(id);
                  const listingModels = available?.models ?? null;
                  const unknownListing = available?.source === "none" || listingModels === null;
                  const noModels = (listingModels?.length ?? 0) === 0 && (draft?.rows.length ?? 0) === 0;
                  const readOnly = planner || !!loadError;
                  return (
                    <div key={id} className="pc-model-matrix__group">
                      <div className="pc-model-matrix__group-head">
                        <strong>{executorLabel(id)}</strong>
                        <span className="u3-muted">› {available?.provider ?? id}</span>
                        <span className="mono u3-muted">{id}</span>
                        {draft && <span className="u3-muted">{draft.rows.length} model{draft.rows.length === 1 ? "" : "s"} · {draft.rows.filter(r => r.on).length} on</span>}
                      </div>
                      {planner && <p className="u3-muted">Planner. Pacer does not dispatch tasks to it, so its models are not edited here.</p>}
                      {loadError && <p className="u3-muted">{loadError}</p>}
                      {!readOnly && noModels && <p className="u3-muted">Uses its default and can take any difficulty</p>}
                      {!readOnly && !noModels && unknownListing && (
                        <div className="u3-actions">
                          <Field label="Add model"><TextInput value={addingByRunner[id] ?? ""} onInput={e => setAddingByRunner(prev => ({ ...prev, [id]: e.currentTarget.value }))} /></Field>
                          <Button size="sm" onClick={() => handleAdd(id)}>Add</Button>
                        </div>
                      )}
                      {draft && !noModels && (
                        <div className="pc-model-matrix__table-wrap">
                          <div className="pc-model-matrix__table">
                            <div className="pc-model-matrix__head">
                              <span>On</span>
                              <span>Model</span>
                              <span>Context</span>
                              <span>Tools</span>
                              <span>Price</span>
                              <span>Size</span>
                              <span>Takes</span>
                            </div>
                            {draft.rows.map(row => {
                              const pendingRow = suggestPhase && row.pending;
                              const listing = listingModels?.find(m => m.id === row.id);
                              return (
                                <div key={row.id} className={`pc-model-matrix__row ${pendingRow ? "pc-model-matrix__row--pending" : ""}`}>
                                  <Switch checked={row.on} aria-label={`Use ${row.id}`} disabled={readOnly} onChange={(e: any) => { if (!readOnly) handleToggle(id, row.id, !!e.currentTarget.checked); }} />
                                  <div>
                                    <span className="pc-model-matrix__mono">{row.id}</span>
                                    {row.isDefault && <span className="pc-model-matrix__tag">Default</span>}
                                    <div className="u3-muted">{pendingRow ? `Suggested: ${row.suggestedOn ? "turn on" : "leave off"}${row.suggestedTier ? ", " + row.suggestedTier : ""}. ${row.suggestionReason ?? ""}` : ""}</div>
                                  </div>
                                  <span className="pc-model-matrix__mono">{formatContext(row.context)}</span>
                                  <span>{formatTools(row.tools)}</span>
                                  <span>{formatPrice(row.costOut)}</span>
                                  <RadioGroup label={`Size of ${row.id}`}>
                                    {(["small", "medium", "frontier"] as MatrixTier[]).map(tier => (
                                      <RadioChip
                                        key={tier}
                                        checked={row.tier === tier}
                                        disabled={readOnly}
                                        onSelect={() => { if (!readOnly) handleTier(id, row.id, tier); }}
                                      >{tier.charAt(0).toUpperCase() + tier.slice(1)}</RadioChip>
                                    ))}
                                  </RadioGroup>
                                  <div>
                                    <span className="u3-muted">{row.on ? (row.tier === "unknown" ? "Any, unrated" : row.takes.map(t => t.charAt(0).toUpperCase() + t.slice(1)).join(", ") || "—") : "Off"}</span>
                                    {pendingRow && <Button size="sm" variant="ghost" aria-label={`Accept suggestion for ${row.id}`} onClick={() => handleAccept(id, row.id)}>Accept</Button>}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      {readOnly && !loadError && planner && null}
                    </div>
                  );
                })}

                {/* Coverage cards */}
                <div className="pc-model-matrix__coverage">
                  {(["simple", "standard", "complex"] as const).map(diff => {
                    const count = drafts.flatMap(d => d.rows).filter(r => r.on && r.tier !== "unknown" && TIERS[r.tier as keyof typeof TIERS] >= TIERS[targets[diff]]).length;
                    const defaultExecutors = runners.filter(({ draft }) => {
                      const rated = draft?.rows.filter(r => r.on && r.tier !== "unknown") ?? [];
                      return rated.length === 0;
                    }).length;
                    return (
                      <div key={diff} className="pc-card">
                        <span>{diff.charAt(0).toUpperCase() + diff.slice(1)} · needs {targets[diff]}</span>
                        <span>{count} models</span>
                        <span className="u3-muted">Plus {defaultExecutors} executors that use their default model.</span>
                      </div>
                    );
                  })}
                </div>

                {blockedGroups.length > 0 && (
                  <p className="u3-muted">Some runners have no default model and all models off; turn a model on or set a default before saving.</p>
                )}

                {conflict && <p role="status">{notice}</p>}
                {!conflict && notice && <p role="status">{notice}</p>}
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