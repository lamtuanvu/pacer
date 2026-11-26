import { useEffect, useRef, useState } from "preact/hooks";
import type { AvailableModels } from "../../../../src/models/available";
import type { RunnerModels } from "../../../../src/core/runner-models";
import type { TierTargets } from "../../../../src/dispatch/types";
import { addModel, buildSavePlan, createDraft, isDirty, rebaseSavedDrafts, setTier, toggleModel, removeModel, type MatrixDraft, type MatrixTier } from "../../model/model-matrix";
import { useTaskContext } from "../task-shared";

/** Routine warnings the Agents tab already shows (unrated sizes, a default outside the list); others stay on screen. */
export const ROUTINE_WARNINGS = /^runners\..+: (?:model ".*" is unrated \(tier unknown\)|default model ".*" is not in models)$/;
const NO_LISTING = (runner: string): AvailableModels => ({ runner, source: "none", models: null, fetchedAt: Date.now() / 1000 });

function messageOf(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as { message?: unknown; code?: unknown };
    if (typeof record.message === "string" && record.message) return record.message;
    if (typeof record.code === "string" && record.code) return record.code;
  }
  return "Could not load this agent's models.";
}
export function isConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; message?: unknown };
  return record.code === "conflict" || /changed elsewhere/i.test(String(record.message ?? ""));
}

/**
 * Stable signature of the decisions a load would apply: each runner's default and each declared model's tier and
 * metadata. It tells a real change elsewhere from an unrelated refresh with identical models.
 */
export function modelSignature(drafts: readonly MatrixDraft[]): string {
  return JSON.stringify([...drafts].sort((a, b) => a.runner < b.runner ? -1 : a.runner > b.runner ? 1 : 0).map(d => ({
    runner: d.runner, default: d.default,
    rows: [...d.rows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(r => ({ id: r.id, on: r.on, tier: r.tier, declared: r.declared ? { id: r.declared.id, tier: r.declared.tier, strengths: r.declared.strengths, tools: r.declared.tools, context: r.declared.context } : null })),
  })));
}

const copyDraft = (d: MatrixDraft): MatrixDraft => ({ ...d, rows: d.rows.map(r => ({ ...r })), baseRows: d.baseRows.map(r => ({ ...r })) });
/** The table lists the models the agent declares; the listing only describes them and feeds Add a model. */
const draftFrom = (runner: string, saved: RunnerModels, targets: TierTargets) => createDraft(runner, saved.revision, saved.default, saved.models ?? [], null, targets);

interface Loaded { available: Record<string, AvailableModels>; drafts: MatrixDraft[]; errors: Record<string, string> }
export interface SaveOutcome { ok: boolean; revision?: string; warnings?: string[] }

/**
 * Every agent's declared models as one page draft, saved through the revision-checked `runner.models.set_many`.
 * A load that lands while the draft is dirty never discards edits: identical models quietly adopt the newer
 * revision, different ones raise a conflict that only Discard resolves.
 */
export function useModelDrafts(runners: readonly string[], targets: TierTargets) {
  const { api } = useTaskContext();
  const key = [...runners].sort().join("\n");
  const [available, setAvailable] = useState<Record<string, AvailableModels>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<MatrixDraft[]>([]), [bases, setBases] = useState<MatrixDraft[]>([]);
  const [revision, setRevision] = useState(""), [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(), [conflict, setConflict] = useState(false), [notice, setNotice] = useState("");
  const [refreshing, setRefreshing] = useState<Record<string, boolean>>({});
  const [token, reload] = useState(0);
  const pending = useRef(false), targetsRef = useRef(targets), basesRef = useRef(bases), draftsRef = useRef(drafts);
  targetsRef.current = targets; basesRef.current = bases; draftsRef.current = drafts;
  // Per-runner edit generation: a save folds its result back only into runners not edited while it ran.
  const versions = useRef<Record<string, number>>({});
  const bump = (runner: string) => { versions.current = { ...versions.current, [runner]: (versions.current[runner] ?? 0) + 1 }; };
  const dirtyOf = (list: readonly MatrixDraft[], base: readonly MatrixDraft[]) => list.some(d => {
    const b = base.find(x => x.runner === d.runner);
    return !b || isDirty(d.rows, b.rows) || d.default !== b.default;
  });
  const dirty = dirtyOf(drafts, bases);
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;

  const fetchAll = async (ids: readonly string[]): Promise<Loaded> => {
    const rows = await Promise.all(ids.map(async id => {
      const listing = await api.call<AvailableModels>("executor.models.available", { runner: id }).catch(() => NO_LISTING(id));
      const declared = await api.call<RunnerModels>("runner.models.get", { id }).then(value => ({ ok: true as const, value }), (failure: unknown) => ({ ok: false as const, failure }));
      return { id, listing, declared };
    }));
    const out: Loaded = { available: {}, drafts: [], errors: {} };
    for (const row of rows) {
      out.available[row.id] = row.listing;
      if (row.declared.ok) out.drafts.push(draftFrom(row.id, row.declared.value, targetsRef.current));
      else out.errors[row.id] = messageOf(row.declared.failure);
    }
    return out;
  };
  const apply = (next: Loaded) => {
    setAvailable(next.available); setErrors(next.errors);
    setDrafts(next.drafts); setBases(next.drafts.map(copyDraft));
    setRevision(next.drafts[0]?.revision ?? ""); versions.current = {}; setLoaded(true);
  };
  useEffect(() => {
    if (!key) { setLoaded(true); return; }
    let active = true;
    void fetchAll(key.split("\n")).then(next => {
      if (!active) return;
      if (dirtyRef.current) {
        setAvailable(current => ({ ...current, ...next.available }));
        // Agents added elsewhere join the page clean; the draft's own agents keep their edits.
        const added = next.drafts.filter(d => !basesRef.current.some(b => b.runner === d.runner));
        if (added.length) { setDrafts(list => [...list, ...added]); setBases(list => [...list, ...added.map(copyDraft)]); }
        if (modelSignature(next.drafts.filter(d => basesRef.current.some(b => b.runner === d.runner))) === modelSignature(basesRef.current)) setRevision(next.drafts[0]?.revision ?? "");
        else { setConflict(true); setNotice("Model settings changed elsewhere. Discard to load them."); }
        return;
      }
      apply(next);
    });
    return () => { active = false; };
  }, [key, JSON.stringify(targets), token]);

  const update = (runner: string, fn: (d: MatrixDraft) => MatrixDraft) => {
    if (busy || errors[runner]) return;
    bump(runner); setNotice("");
    setDrafts(list => list.map(d => d.runner === runner ? fn(d) : d));
  };
  const edits = {
    toggle: (runner: string, id: string, on: boolean) => update(runner, d => { const r = toggleModel(d.rows, id, on, d.default); return { ...d, rows: r.rows, default: r.default }; }),
    size: (runner: string, id: string, tier: MatrixTier) => update(runner, d => ({ ...d, rows: setTier(d.rows, id, tier) })),
    makeDefault: (runner: string, id: string) => update(runner, d => d.rows.some(r => r.id === id && r.on) ? { ...d, default: id } : d),
    add: (runner: string, id: string, tier: MatrixTier | null) => update(runner, d => {
      const value = id.trim();
      if (!value || d.rows.some(r => r.id === value)) return d;
      // A pinned default the saved state never declared (no models at all) stays: it becomes the first row, so
      // adding never replaces it. A default left behind by removing every row in this draft does not come back.
      const savedRows = basesRef.current.find(base => base.runner === runner)?.rows ?? [];
      const pinned = savedRows.length === 0 && !!d.default && d.default !== value && !d.rows.some(r => r.id === d.default);
      let rows = addModel(pinned ? addModel(d.rows, d.default!) : d.rows, value);
      if (tier) rows = setTier(rows, value, tier);
      const valid = !!d.default && rows.some(r => r.id === d.default && r.on);
      return { ...d, rows, default: valid ? d.default : rows.filter(r => r.on).length === 1 ? value : d.default };
    }),
    /** Swap a model the agent no longer offers for another, keeping its place, size and default. */
    replace: (runner: string, id: string, next: string, tier: MatrixTier | null) => update(runner, d => {
      const value = next.trim();
      if (!value || value === id || d.rows.some(r => r.id === value)) return d;
      const rows = d.rows.map(r => r.id === id ? { id: value, on: r.on, tier: tier ?? r.tier, isDefault: r.isDefault, takes: [] } : r);
      return { ...d, rows, default: d.default === id ? value : d.default };
    }),
    remove: (runner: string, id: string) => update(runner, d => {
      const rows = removeModel(d.rows, id);
      // The last model removed leaves the saved default in place: the save needs one.
      return { ...d, rows, default: d.default === id ? rows.find(r => r.on)?.id ?? d.default : d.default };
    }),
  };
  /** Runners whose save would leave them with no default and every model off. */
  const blocked = drafts.filter(d => d.default == null && d.rows.length > 0 && d.rows.every(r => !r.on)).map(d => d.runner);

  const discard = async () => {
    setBusy(true); setError(undefined); setNotice(""); setConflict(false);
    try { apply(await fetchAll(key ? key.split("\n") : [])); }
    catch (failure) { setError(failure); }
    finally { setBusy(false); }
  };
  /** Refresh one agent's live listing, bypassing the listing cache once. */
  const refreshListing = async (runner: string): Promise<AvailableModels | null> => {
    setRefreshing(current => ({ ...current, [runner]: true }));
    try {
      const listing = await api.call<AvailableModels>("executor.models.available", { runner, refresh: true });
      setAvailable(current => ({ ...current, [runner]: listing }));
      return listing;
    } catch { return null; }
    finally { setRefreshing(current => ({ ...current, [runner]: false })); }
  };
  const save = async (): Promise<SaveOutcome> => {
    if (pending.current || !dirty || blocked.length) return { ok: !dirty };
    pending.current = true; setBusy(true); setError(undefined); setNotice(""); setConflict(false);
    const planNow = (expected: string) => buildSavePlan(draftsRef.current.filter(d => !errors[d.runner]).map(d => {
      const base = basesRef.current.find(b => b.runner === d.runner);
      return { runner: d.runner, revision: d.revision, baseRows: base?.rows ?? [], rows: d.rows, default: d.default, baseDefault: base?.default ?? null };
    }), targetsRef.current, expected);
    const started = versions.current;
    const fold = (changed: readonly string[], runners: RunnerModels[], next: string) => {
      const returned = new Map(runners.map(r => [r.runner, r]));
      const baseline = (runner: string, saved: RunnerModels) => draftFrom(runner, saved, targetsRef.current);
      const now = (runner: string) => versions.current[runner] ?? 0, then = (runner: string) => started[runner] ?? 0;
      setDrafts(list => rebaseSavedDrafts(list, changed, now, then, returned, baseline).drafts);
      setBases(list => rebaseSavedDrafts(list, changed, now, then, returned, baseline).baseDrafts);
      setRevision(next); versions.current = {};
    };
    const send = async (expected: string) => {
      const plan = planNow(expected);
      if (!plan.changed) return null;
      const result = await api.call<{ revision: string; runners: RunnerModels[]; warnings?: string[] }>("runner.models.set_many", { expectedRevision: expected, runners: plan.runners });
      fold(plan.changedRunners, result.runners, result.revision);
      return result;
    };
    try {
      let result;
      const first = revision || drafts[0]?.revision || "";
      try { result = await send(first); }
      catch (failure) {
        const plan = planNow(first);
        const fresh = await fetchAll(key ? key.split("\n") : []).catch(() => null);
        if (!fresh) throw failure;
        const freshRevision = fresh.drafts[0]?.revision ?? "";
        const declared = (runner: string) => fresh.drafts.find(d => d.runner === runner);
        // A lost response can follow a committed write: the service already holds exactly what this save sent.
        const committed = plan.runners.length > 0 && plan.runners.every(sent => {
          const now = declared(sent.id);
          return !!now && now.default === sent.default && JSON.stringify(now.rows.filter(r => r.on).map(r => [r.id, r.tier])) === JSON.stringify(sent.models.map(m => [m.id, m.tier]));
        });
        if (committed) {
          fold(plan.changedRunners, plan.runners.map(sent => ({ runner: sent.id, revision: freshRevision, default: sent.default, models: declared(sent.id)!.rows.filter(r => r.on).map(r => r.declared ?? { id: r.id, tier: r.tier as never }) })), freshRevision);
          result = { revision: freshRevision, runners: [], warnings: [] as string[] };
        } else {
          if (!isConflict(failure)) throw failure;
          // Another write on this page (or elsewhere) moved the revision. Retry once when the models are unchanged.
          if (modelSignature(fresh.drafts.filter(d => basesRef.current.some(b => b.runner === d.runner))) !== modelSignature(basesRef.current)) throw failure;
          setRevision(freshRevision);
          result = await send(freshRevision);
        }
      }
      if (!result) { setNotice("No changes."); return { ok: true }; }
      const warnings = (result.warnings ?? []).filter(w => !ROUTINE_WARNINGS.test(w));
      setNotice(warnings.length ? `Saved. ${warnings.join(" ")}` : "Saved.");
      return { ok: true, revision: result.revision, warnings };
    } catch (failure) {
      if (isConflict(failure)) { setConflict(true); setNotice("Model settings changed elsewhere. Discard to load them."); }
      else setError(failure);
      return { ok: false };
    } finally { pending.current = false; setBusy(false); }
  };
  return {
    available, errors, drafts, bases, loaded, dirty, busy, error, conflict, notice, blocked, refreshing,
    draftOf: (runner: string) => drafts.find(d => d.runner === runner),
    baseOf: (runner: string) => bases.find(d => d.runner === runner),
    edits, save, discard, refreshListing,
    /** Re-read models after another write on this page; identical models adopt the newer revision. */
    reload: () => reload(n => n + 1),
    clearNotice: () => setNotice(""),
  };
}
export type ModelDraftsState = ReturnType<typeof useModelDrafts>;
