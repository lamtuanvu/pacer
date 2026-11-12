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
  const [drafts, setDrafts] = useState<MatrixDraft[]>([]);
  const [baseDrafts, setBaseDrafts] = useState<MatrixDraft[]>([]);
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [addingByRunner, setAddingByRunner] = useState<Record<string, string>>({});
  const [suggestPhase, setSuggestPhase] = useState(false);
  const pending = useRef(false);

  useEffect(() => {
    if (!inventory.data) return;
    const ids = [...new Set(inventory.data.models.map(m => m.runner))];
    setRunnerIds(ids);
  }, [inventory.data]);

  useEffect(() => {
    if (!runnerIds.length) return;
    let active = true;
    void Promise.all(runnerIds.map(async id => {
      const [available, declared] = await Promise.all([
        api.call<AvailableModels>("executor.models.available", { runner: id }).catch(() => ({ runner: id, source: "none", models: null, fetchedAt: Date.now() } as AvailableModels)),
        api.call<RunnerModels>("runner.models.get", { id }).catch(() => null),
      ]);
      return { id, available, declared };
    })).then(results => {
      if (!active) return;
      const avail: Record<string, AvailableModels> = {};
      const decl: Record<string, RunnerModels> = {};
      const nextDrafts: MatrixDraft[] = [];
      for (const result of results as any[]) {
        avail[result.id] = result.available;
        if (result.declared) {
          decl[result.id] = result.declared;
          const listing = result.available.models ? result.available.models.map((m: AvailableModel) => ({ id: m.id, context: m.context, tools: m.tools, costOut: m.costOut })) : null;
          const draft = createDraft(result.id, result.declared.revision, result.declared.default, result.declared.models, listing, targets);
          nextDrafts.push(draft);
        }
      }
      setAvailableById(avail);
      setDeclaredById(decl);
      setDrafts(nextDrafts);
      setBaseDrafts(nextDrafts.map(d => ({ ...d, rows: d.rows.map(r => ({ ...r })), baseRows: d.baseRows.map(r => ({ ...r })) })));
    });
    return () => { active = false; };
  }, [runnerIds, targets]);

  const isPlanner = (runner: string) => {
    return config.data?.plannerAccount === runner || config.data?.planner === runner;
  };

  const runners = runnerIds.map(id => {
    const draft = drafts.find(d => d.runner === id);
    const available = availableById[id];
    const declared = declaredById[id];
    return { id, draft, available, declared };
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

  const handleAcceptAll = (runner: string) => {
    updateDraft(runner, d => ({ ...d, rows: acceptAllSuggestions(d.rows) }));
  };

  const handleDismiss = (runner: string) => {
    updateDraft(runner, d => ({ ...d, rows: dismissSuggestions(d.rows) }));
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

  const handleAdd = (runner: string) => {
    const value = addingByRunner[runner] ?? "";
    updateDraft(runner, d => ({ ...d, rows: addModel(d.rows, value) }));
    setAddingByRunner(prev => ({ ...prev, [runner]: "" }));
  };

  const dirty = drafts.some((d, i) => isDirty(d.rows, baseDrafts[i]?.rows ?? d.rows));

  const handleDiscard = () => {
    setDrafts(baseDrafts.map(d => ({ ...d, rows: d.rows.map(r => ({ ...r })), baseRows: d.baseRows.map(r => ({ ...r })) })));
    setConflict(false);
    setNotice("");
    setError(undefined);
    setSuggestPhase(false);
  };

  const handleSave = async () => {
    if (pending.current || !dirty) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    setNotice("");
    setConflict(false);
    try {
      // freshest revision
      const revisions = await Promise.all(drafts.map(d => api.call<RunnerModels>("runner.models.get", { id: d.runner }).catch(() => null)));
      const baseRevision = revisions.find(r => r)?.revision ?? drafts[0]?.revision ?? "";
      // conflict check: compare declared rows? We trust server revision check.
      const plan = buildSavePlan(drafts.map((d, i) => ({
        runner: d.runner,
        revision: d.revision,
        baseRows: baseDrafts[i]?.rows ?? d.rows,
        rows: d.rows,
        default: d.default,
      })), targets, baseRevision);
      if (!plan.changed) {
        setNotice("No changes.");
        return;
      }
      const result = await api.call<{ revision: string; runners: RunnerModels[]; warnings?: string[] }>("runner.models.set_many", {
        expectedRevision: baseRevision,
        runners: plan.runners,
      });
      // update drafts
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

  const filters = [
    { key: "all", label: "All agents" },
    ...runnerIds.map(id => ({ key: id, label: id })),
  ];

  const visibleRunners = filter === "all" ? runners : runners.filter(r => r.id === filter);

  return (
    <Section id="model-matrix" title="Model matrix" detail="Every model each agent can run.">
      <ResourceState resource={config}>
        {config.data && (
          <ResourceState resource={inventory}>
            {inventory.data && (
              <>
                <div className="pc-model-matrix__filters">
                  {filters.map(f => (
                    <FilterChip key={f.key} selected={filter === f.key} onClick={() => setFilter(f.key)}>{f.label}</FilterChip>
                  ))}
                </div>

                {visibleRunners.map(({ id, draft, available }) => {
                  if (!draft) return null;
                  const planner = isPlanner(id);
                  const listingModels = available?.models ?? null;
                  const unknownListing = available?.source === "none" || listingModels === null;
                  const noModels = (listingModels?.length ?? 0) === 0 && draft.rows.length === 0;
                  return (
                    <div key={id} className="pc-model-matrix__group">
                      <div className="pc-model-matrix__group-head">
                        <strong>{executorLabel(id)}</strong>
                        <span className="u3-muted">› {available?.provider ?? id}</span>
                        <span className="mono u3-muted">{id}</span>
                        <span className="cap u3-muted">{draft.rows.length} model{draft.rows.length === 1 ? "" : "s"} · {draft.rows.filter(r => r.on).length} on</span>
                      </div>
                      {planner && <p className="u3-muted">Planner runner is read-only.</p>}
                      {noModels && <p className="u3-muted">Uses its default and can take any difficulty</p>}
                      {unknownListing && (
                        <div className="u3-actions">
                          <Field label="Add model"><TextInput value={addingByRunner[id] ?? ""} onInput={e => setAddingByRunner(prev => ({ ...prev, [id]: e.currentTarget.value }))} /></Field>
                          <Button size="sm" onClick={() => handleAdd(id)}>Add</Button>
                        </div>
                      )}
                      <div className="pc-model-matrix__table-wrap">
                        <div className="pc-model-matrix__table">
                          <div className="pc-model-matrix__head">
                            <span className="lbl">On</span>
                            <span className="lbl">Model</span>
                            <span className="lbl">Context</span>
                            <span className="lbl">Tools</span>
                            <span className="lbl">Price</span>
                            <span className="lbl">Size</span>
                            <span className="lbl">Takes</span>
                          </div>
                          {draft.rows.map(row => {
                            const pendingRow = suggestPhase && row.pending;
                            const listing = listingModels?.find(m => m.id === row.id);
                            return (
                              <div key={row.id} className={`pc-model-matrix__row ${pendingRow ? "pending" : ""}`}>
                                <Switch checked={row.on} aria-label={`Use ${row.id}`} disabled={planner} onChange={(e: any) => { if (!planner) handleToggle(id, row.id, !!e.currentTarget.checked); }} />
                                <div>
                                  <span className="mono">{row.id}</span>
                                  {row.isDefault && <span className="tag">Default</span>}
                                  <div className="cap u3-muted">{pendingRow ? `Suggested: ${row.suggestedOn ? "turn on" : "leave off"}${row.suggestedTier ? ", " + row.suggestedTier : ""}. ${row.suggestionReason ?? ""}` : ""}</div>
                                </div>
                                <span className="mono">{row.context ?? "—"}</span>
                                <span>{row.tools === true ? "Yes" : row.tools === false ? "No" : row.tools === null ? "?" : "—"}</span>
                                <span>{row.costOut == null ? "Local" : `$${row.costOut}`}</span>
                                <RadioGroup label={`Size of ${row.id}`}>
                                  {(["small", "medium", "frontier"] as MatrixTier[]).map(tier => (
                                    <RadioChip
                                      key={tier}
                                      checked={row.tier === tier}
                                      disabled={planner}
                                      onSelect={() => { if (!planner) handleTier(id, row.id, tier); }}
                                    >{tier.charAt(0).toUpperCase() + tier.slice(1)}</RadioChip>
                                  ))}
                                </RadioGroup>
                                <div>
                                  <span className="u3-muted">{row.on ? (row.tier === "unknown" ? "Any, unrated" : row.takes.map(t => t.charAt(0).toUpperCase() + t.slice(1)).join(", ") || "—") : "Off"}</span>
                                  {pendingRow && <Button size="sm" aria-label={`Accept suggestion for ${row.id}`} onClick={() => handleAccept(id, row.id)}>Accept</Button>}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                      {suggestPhase && (
                        <div className="u3-actions">
                          <Button size="sm" variant="ghost" onClick={() => handleDismiss(id)}>Dismiss</Button>
                          <Button size="sm" variant="primary" onClick={() => handleAcceptAll(id)}>Accept all</Button>
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Coverage cards */}
                <div className="pc-model-matrix__coverage">
                  {(["simple", "standard", "complex"] as const).map(diff => {
                    const count = drafts.flatMap(d => d.rows).filter(r => r.on && r.tier !== "unknown" && TIERS[r.tier as keyof typeof TIERS] >= TIERS[targets[diff]]).length;
                    const defaultAgents = runners.length; // placeholder
                    return (
                      <div key={diff} className="pc-card">
                        <span className="lbl">{diff.charAt(0).toUpperCase() + diff.slice(1)} · needs {targets[diff]}</span>
                        <span>{count} models</span>
                        <span className="cap u3-muted">Plus {defaultAgents} agents that use their default model.</span>
                      </div>
                    );
                  })}
                </div>

                {/* Suggest banner */}
                <Card className="pc-model-matrix__suggest">
                  {!suggestPhase ? (
                    <>
                      <strong>Let an agent fill in the matrix</strong>
                      <span className="u3-muted">It reads each provider's listing and proposes which to turn on and what size each is. Nothing changes until you accept.</span>
                      <div className="u3-actions">
                        <Button size="sm" variant="primary" onClick={handleSuggest}>Suggest</Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <strong>Suggestions applied</strong>
                      <span className="u3-muted">Highlighted rows. Accept them one by one, or all at once.</span>
                      <div className="u3-actions">
                        <Button size="sm" variant="ghost" onClick={() => setSuggestPhase(false)}>Dismiss</Button>
                        <Button size="sm" variant="primary" onClick={() => { drafts.forEach(d => handleAcceptAll(d.runner)); setSuggestPhase(false); }}>Accept all</Button>
                      </div>
                    </>
                  )}
                </Card>

                {conflict && <p role="status">{notice}</p>}
                {!conflict && notice && <p role="status">{notice}</p>}
                <ErrorMessage error={error} />

                {dirty && (
                  <div className="pc-model-matrix__savebar" role="region" aria-label="Unsaved changes">
                    <span>{drafts.flatMap((d, i) => d.rows.filter((r, idx) => JSON.stringify(r) !== JSON.stringify(baseDrafts[i]?.rows?.[idx]))).length} model changed</span>
                    <div className="u3-actions">
                      <Button variant="ghost" disabled={busy} onClick={handleDiscard}>Discard</Button>
                      <Button variant="primary" busy={busy} onClick={() => void handleSave()}>Save matrix</Button>
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
