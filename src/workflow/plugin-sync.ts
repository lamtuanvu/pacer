// Host sync for plugin-contributed workflows (protocol 1.12.0). Calls
// `workflow.definitions` page by page, validates, and stores under
// `plugin:<id>@<version>`. No plugin code runs in the engine.
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import { appendPluginLog } from "../plugins/host";
import { pluginRegistry } from "../plugins";
import type { PluginInfo } from "../plugins/registry";
import type { PluginManifest } from "../plugins/protocol";
import {
  WORKFLOW_DEFINITIONS_DEADLINE_MS,
  WORKFLOW_PROMPT_MAX_BYTES,
  WORKFLOW_SOURCE_MAX_BYTES,
  workflowDefinitionsReplyFits,
  workflowDefinitionsResult,
  type WorkflowDefinitionsResult,
} from "../plugins/workflow-protocol";
import { TASK_DB_BUSY_TIMEOUT_MS } from "../tasks/store";
import { parseWorkflow } from "./parse";
import type { StepDef, WorkflowDef } from "./schema";
import { validateWorkflow } from "./validate";
import {
  addDefinition,
  getDefinition,
  listDefinitions,
  setDefinitionInvalid,
  setPluginDefinitionsDisabled,
  workflowDatabase,
} from "./store";

const MAX_PAGES = 256;
/** Overall wall-clock budget for one plugin's page loop (not the serve start-up path). */
export const WORKFLOW_SYNC_OVERALL_DEADLINE_MS = 60_000;
/** Bounded backoff when SQLITE_BUSY defers a sync (off the start-up path). */
export const WORKFLOW_SYNC_RETRY_DELAYS_MS = [25, 100, 400, 1600] as const;

export type PluginSyncOpts = {
  /** Per-page `workflow.definitions` deadline (default 10 s). */
  deadlineMs?: number;
  /** Overall sync deadline for one plugin (default 60 s). */
  overallDeadlineMs?: number;
  /** Injectable clock for tests. */
  nowMs?: () => number;
  /** Schedule a deferred retry; defaults to `setTimeout`. */
  defer?: (work: () => void, delayMs: number) => void;
  /** Retry delays after SQLITE_BUSY; empty disables retries. */
  retryDelaysMs?: readonly number[];
  /** Internal attempt counter for deferred retries. */
  attempt?: number;
};

/** A relative prompt path reference (no newlines / templates). */
export function isPromptPath(prompt: string): boolean {
  return !prompt.includes("\n") && !prompt.includes("{{") && /^[A-Za-z0-9_./-]+\.[A-Za-z0-9]+$/.test(prompt);
}

/** Collect `prompt:` path values from a parsed definition. */
export function promptPathsOf(def: WorkflowDef): string[] {
  const paths: string[] = [];
  const take = (step: StepDef) => {
    if (step.type === "agent" || step.type === "generate") {
      if (isPromptPath(step.prompt)) paths.push(step.prompt);
    } else if (step.type === "fanout" && isPromptPath(step.each.prompt)) {
      paths.push(step.each.prompt);
    }
  };
  for (const step of Object.values(def.steps)) take(step);
  return paths;
}

/** Parse `plugin:<id>@<version>` origin; null when not a plugin origin. */
export function parsePluginOrigin(origin: string): { pluginId: string; version: string } | null {
  const m = /^plugin:([^@]+)@(.+)$/.exec(origin);
  if (!m) return null;
  return { pluginId: m[1]!, version: m[2]! };
}

function diagnostic(ctx: Ctx, pluginId: string, message: string): void {
  appendPluginLog(ctx, pluginId, "workflow", message);
}

function isSqliteBusy(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (typeof code === "string" && code.startsWith("SQLITE_BUSY")) return true;
  const text = `${err instanceof Error ? err.message : String(err)}`.toLowerCase();
  return text.includes("sqlite_busy") || text.includes("database is locked")
    || text.includes("database table is locked") || text.includes("database is busy");
}

/** Fail-fast under a held writer: never stall the event loop on start-up sync (CT / ARCH-16). */
function withFailFastWrites<T>(ctx: Ctx, run: () => T): T {
  // Open first, then set busy_timeout=0 before any write the caller performs.
  const db = workflowDatabase(ctx);
  db.run("PRAGMA busy_timeout = 0");
  try {
    return run();
  } finally {
    try { db.run(`PRAGMA busy_timeout = ${TASK_DB_BUSY_TIMEOUT_MS}`); }
    catch { /* leave fail-fast if restore cannot run */ }
  }
}

function declaredNames(manifest: PluginManifest): Set<string> {
  const raw = manifest.contributes.workflow;
  return new Set(raw ? Object.keys(raw) : []);
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function validatePage(
  pluginId: string,
  declared: Set<string>,
  page: WorkflowDefinitionsResult,
): { ok: true; entries: { name: string; def: WorkflowDef; source: string; prompts: Record<string, string> }[] } | { ok: false; reason: string } {
  if (!workflowDefinitionsReplyFits(page)) {
    return { ok: false, reason: "workflow.definitions reply exceeds 960 KiB" };
  }
  const entries: { name: string; def: WorkflowDef; source: string; prompts: Record<string, string> }[] = [];
  for (const item of page.workflows) {
    if (utf8Bytes(item.source) > WORKFLOW_SOURCE_MAX_BYTES) {
      return { ok: false, reason: `workflow '${item.name}' source exceeds ${WORKFLOW_SOURCE_MAX_BYTES} bytes` };
    }
    for (const [path, text] of Object.entries(item.prompts)) {
      if (utf8Bytes(text) > WORKFLOW_PROMPT_MAX_BYTES) {
        return { ok: false, reason: `workflow '${item.name}' prompt '${path}' exceeds ${WORKFLOW_PROMPT_MAX_BYTES} bytes` };
      }
    }
    if (!declared.has(item.name)) {
      return { ok: false, reason: `workflow name '${item.name}' is not declared in contributes.workflow` };
    }
    const expectedId = `${pluginId}/${item.name}`;
    const { def, errors: parseErrors } = parseWorkflow(item.source);
    if (!def) {
      return { ok: false, reason: `invalid workflow '${item.name}': ${parseErrors.map(e => e.message).join("; ") || "parse failed"}` };
    }
    if (def.id !== expectedId) {
      if (!def.id.startsWith(`${pluginId}/`)) {
        return { ok: false, reason: `workflow id '${def.id}' is outside plugin namespace '${pluginId}/'` };
      }
      return { ok: false, reason: `workflow id '${def.id}' does not match declared name '${expectedId}'` };
    }
    if (def.version !== item.version) {
      return { ok: false, reason: `workflow '${item.name}' version ${item.version} does not match source version ${def.version}` };
    }
    const shapeErrors = validateWorkflow(def);
    if (shapeErrors.length) {
      return { ok: false, reason: `invalid workflow '${item.name}': ${shapeErrors.map(e => `${e.path}: ${e.message}`).join("; ")}` };
    }
    for (const path of promptPathsOf(def)) {
      if (!Object.hasOwn(item.prompts, path)) {
        return { ok: false, reason: `workflow '${item.name}' missing prompt '${path}'` };
      }
    }
    entries.push({ name: item.name, def, source: item.source, prompts: item.prompts });
  }
  return { ok: true, entries };
}

function grantCoversWorkflows(info: PluginInfo, manifest: PluginManifest | null): boolean {
  if (info.bundled) return true;
  if (!manifest || !info.grant) return false;
  const names = Object.keys(manifest.contributes.workflow ?? {});
  const granted = new Set(info.grant.workflows ?? []);
  return names.every(n => granted.has(n));
}

/** Whether the live plugin may contribute / start workflows right now. */
export function pluginWorkflowsAreLive(info: PluginInfo | undefined, manifest: PluginManifest | null): boolean {
  if (!info) return false;
  if (info.state === "disabled" || info.state === "refused" || info.state === "failing" || info.state === "needs_grant") {
    return false;
  }
  if (info.state !== "idle" && info.state !== "ready" && info.state !== "starting") return false;
  if (!info.enabled) return false;
  return grantCoversWorkflows(info, manifest);
}

/**
 * Refuse starting a plugin-origin definition when the contributing plugin is not
 * live (disabled, removed, failing/refused, needs_grant, or grant misses the name).
 * Bundled plugins are trusted. Manual origins are unrestricted here.
 */
export function assertPluginAllowsWorkflowStart(ctx: Ctx, origin: string, defId: string): void {
  const parsed = parsePluginOrigin(origin);
  if (!parsed) return;
  const reg = pluginRegistry(ctx);
  const info = reg.list(ctx).find(p => p.id === parsed.pluginId);
  const manifest = reg.manifestOf(ctx, parsed.pluginId);
  if (!pluginWorkflowsAreLive(info, manifest)) {
    const state = info?.state ?? "removed";
    throw new CoreError(
      "not_allowed",
      `workflow '${defId}' cannot start: plugin '${parsed.pluginId}' is ${state}`,
    );
  }
  if (info!.bundled) return;
  const prefix = `${parsed.pluginId}/`;
  const workflowName = defId.startsWith(prefix) ? defId.slice(prefix.length) : null;
  if (workflowName && !(info!.grant?.workflows ?? []).includes(workflowName)) {
    throw new CoreError(
      "not_allowed",
      `workflow '${defId}' cannot start: plugin grant does not cover '${workflowName}'`,
    );
  }
}

/**
 * Rows an earlier build marked `disabled=1` because the def failed validateWorkflow
 * (before the distinct `invalid` column) get no schema backfill. Re-validate those
 * rows and set `invalid=1` so clearing `disabled` for a live plugin cannot un-gate them.
 * Idempotent; runs inside existing sync/reconcile write transactions.
 */
export function backfillInvalidFromDisabledMarker(ctx: Ctx, pluginId?: string): number {
  const prefix = pluginId ? `plugin:${pluginId}@` : "plugin:";
  let marked = 0;
  for (const meta of listDefinitions(ctx)) {
    if (!meta.origin.startsWith(prefix)) continue;
    if (meta.invalid) continue;
    if (!meta.disabled) continue;
    const def = getDefinition(ctx, `${meta.id}@${meta.version}`);
    if (!def) continue;
    if (validateWorkflow(def).length === 0) continue;
    setDefinitionInvalid(ctx, meta.id, meta.version, true);
    marked++;
  }
  return marked;
}

/**
 * Reconcile `workflow_defs.disabled` for every plugin that has origin definitions,
 * against live registry state. Writes only when a flag must change.
 */
export function reconcilePluginWorkflowFlags(ctx: Ctx): void {
  const pluginIds = new Set<string>();
  for (const def of listDefinitions(ctx)) {
    const parsed = parsePluginOrigin(def.origin);
    if (parsed) pluginIds.add(parsed.pluginId);
  }
  if (!pluginIds.size) return;
  // Before clearing disabled for live plugins, promote old invalid-via-disabled rows.
  backfillInvalidFromDisabledMarker(ctx);
  const reg = pluginRegistry(ctx);
  const byId = new Map(reg.list(ctx).map(p => [p.id, p]));
  for (const pluginId of pluginIds) {
    const info = byId.get(pluginId);
    const manifest = reg.manifestOf(ctx, pluginId);
    const live = pluginWorkflowsAreLive(info, manifest);
    setPluginDefinitionsDisabled(ctx, pluginId, !live);
  }
}

function scheduleDeferredRetry(
  ctx: Ctx,
  opts: PluginSyncOpts | undefined,
  work: (next: PluginSyncOpts) => void,
): void {
  const attempt = opts?.attempt ?? 0;
  const delays = opts?.retryDelaysMs ?? WORKFLOW_SYNC_RETRY_DELAYS_MS;
  if (attempt >= delays.length) return;
  const defer = opts?.defer ?? ((fn, ms) => { setTimeout(fn, ms); });
  const delay = delays[attempt]!;
  defer(() => {
    work({ ...opts, attempt: attempt + 1, defer: opts?.defer, retryDelaysMs: delays });
  }, delay);
}

/**
 * Page through `workflow.definitions` for one ready plugin and store valid
 * definitions. Invalid pages are logged as diagnostics and not stored.
 * Returns whether the sync completed, was skipped, or deferred on SQLITE_BUSY.
 */
export async function syncPluginWorkflows(
  ctx: Ctx,
  pluginId: string,
  opts?: PluginSyncOpts,
): Promise<"ok" | "skipped" | "deferred"> {
  const reg = pluginRegistry(ctx);
  const manifest = reg.manifestOf(ctx, pluginId);
  if (!manifest?.contributes.workflow) return "skipped";
  const info = reg.list(ctx).find(p => p.id === pluginId);
  if (!pluginWorkflowsAreLive(info, manifest)) return "skipped";

  const declared = declaredNames(manifest);
  if (!declared.size) return "skipped";

  try {
    withFailFastWrites(ctx, () => {
      // Promote pre-invalid-column "disabled because invalid" rows before clearing disabled.
      backfillInvalidFromDisabledMarker(ctx, pluginId);
      setPluginDefinitionsDisabled(ctx, pluginId, false);
    });
  } catch (error) {
    if (isSqliteBusy(error)) {
      diagnostic(ctx, pluginId, "workflow sync deferred: database is busy");
      scheduleDeferredRetry(ctx, opts, (next) => {
        void syncPluginWorkflows(ctx, pluginId, next).catch(() => { /* best-effort */ });
      });
      return "deferred";
    }
    throw error;
  }

  const nowMs = opts?.nowMs ?? Date.now;
  const pageDeadline = opts?.deadlineMs ?? WORKFLOW_DEFINITIONS_DEADLINE_MS;
  const overallDeadline = opts?.overallDeadlineMs ?? WORKFLOW_SYNC_OVERALL_DEADLINE_MS;
  const started = nowMs();
  const seenKeys = new Set<string>();

  let after: string | undefined;
  for (let pageNum = 0; pageNum < MAX_PAGES; pageNum++) {
    if (nowMs() - started > overallDeadline) {
      diagnostic(ctx, pluginId, `workflow.definitions exceeded overall sync deadline (${overallDeadline} ms); stopping`);
      return "ok";
    }
    let raw: unknown;
    try {
      raw = await reg.call(ctx, pluginId, "workflow.definitions", after ? { after } : {}, {
        deadlineMs: pageDeadline,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostic(ctx, pluginId, `workflow.definitions failed: ${message}`);
      return "ok";
    }
    const parsed = workflowDefinitionsResult.safeParse(raw);
    if (!parsed.success) {
      diagnostic(ctx, pluginId, `workflow.definitions returned an invalid page: ${parsed.error.issues[0]?.message ?? "invalid"}`);
      return "ok";
    }
    const checked = validatePage(pluginId, declared, parsed.data);
    if (!checked.ok) {
      diagnostic(ctx, pluginId, checked.reason);
      return "ok";
    }
    for (const item of checked.entries) {
      const key = `${item.name}@${item.def.version}`;
      if (seenKeys.has(key)) {
        diagnostic(ctx, pluginId, `duplicate workflow '${key}' across pages; stopping`);
        return "ok";
      }
      seenKeys.add(key);
    }
    const origin = `plugin:${pluginId}@${manifest.version}`;
    try {
      withFailFastWrites(ctx, () => {
        for (const item of checked.entries) {
          const existing = getDefinition(ctx, `${item.def.id}@${item.def.version}`);
          let supersede = false;
          if (existing) {
            const existingErrors = validateWorkflow(existing);
            if (existingErrors.length > 0) {
              supersede = true;
              diagnostic(
                ctx,
                pluginId,
                `definition ${item.def.id}@${item.def.version} no longer validates (${existingErrors.map(e => e.message).join("; ")}); superseding from plugin ${manifest.version}`,
              );
            }
          }
          const result = addDefinition(ctx, item.def, item.source, {
            origin, prompts: item.prompts, allowSourceMismatch: true, supersede,
          });
          if (result.skipped === "pinned_runs") {
            diagnostic(
              ctx,
              pluginId,
              `definition ${item.def.id}@${item.def.version} has pinned running runs; not superseded`,
            );
            if (existing && validateWorkflow(existing).length > 0) {
              setDefinitionInvalid(ctx, item.def.id, item.def.version, true);
              diagnostic(ctx, pluginId, `definition ${item.def.id}@${item.def.version} no longer validates; marked invalid`);
            }
          } else if (result.skipped === "source_mismatch") {
            diagnostic(ctx, pluginId, `definition ${item.def.id}@${item.def.version} already exists with a different source; not stored`);
            // Valid stored source wins immutability; invalid stored → persistent invalid marker.
            if (existing && validateWorkflow(existing).length > 0) {
              setDefinitionInvalid(ctx, item.def.id, item.def.version, true);
              diagnostic(ctx, pluginId, `definition ${item.def.id}@${item.def.version} no longer validates; marked invalid`);
            }
          } else if (result.superseded) {
            diagnostic(ctx, pluginId, `definition ${item.def.id}@${item.def.version} superseded with plugin ${manifest.version} source`);
          }
        }
      });
    } catch (error) {
      if (isSqliteBusy(error)) {
        diagnostic(ctx, pluginId, "workflow sync deferred: database is busy");
        scheduleDeferredRetry(ctx, opts, (next) => {
          void syncPluginWorkflows(ctx, pluginId, next).catch(() => { /* best-effort */ });
        });
        return "deferred";
      }
      throw error;
    }
    if (!parsed.data.next) {
      try {
        withFailFastWrites(ctx, () => revalidateStoredPluginDefinitions(ctx, pluginId, seenKeys));
      } catch (error) {
        if (!isSqliteBusy(error)) throw error;
      }
      return "ok";
    }
    after = parsed.data.next;
  }
  diagnostic(ctx, pluginId, `workflow.definitions exceeded ${MAX_PAGES} pages; stopping`);
  try {
    withFailFastWrites(ctx, () => revalidateStoredPluginDefinitions(ctx, pluginId, seenKeys));
  } catch (error) {
    if (!isSqliteBusy(error)) throw error;
  }
  return "ok";
}

/** Disable every definition this plugin contributed (disable or uninstall). */
export function disablePluginWorkflows(ctx: Ctx, pluginId: string): void {
  setPluginDefinitionsDisabled(ctx, pluginId, true);
}

/** Re-validate plugin-origin stored defs; disable ones that no longer pass validateWorkflow. */
function revalidateStoredPluginDefinitions(
  ctx: Ctx,
  pluginId: string,
  seenKeys: Set<string>,
): void {
  const prefix = `plugin:${pluginId}@`;
  for (const meta of listDefinitions(ctx)) {
    if (!meta.origin.startsWith(prefix)) continue;
    const key = `${meta.id.slice(pluginId.length + 1)}@${meta.version}`;
    // Name without plugin prefix — seenKeys uses contributes names.
    const nameKey = meta.id.startsWith(`${pluginId}/`)
      ? `${meta.id.slice(pluginId.length + 1)}@${meta.version}`
      : key;
    if (seenKeys.has(nameKey)) continue;
    const def = getDefinition(ctx, `${meta.id}@${meta.version}`);
    if (!def) continue;
    const errors = validateWorkflow(def);
    if (errors.length === 0) continue;
    diagnostic(
      ctx,
      pluginId,
      `stored definition ${meta.id}@${meta.version} no longer validates (${errors.map(e => e.message).join("; ")}); marking invalid`,
    );
    setDefinitionInvalid(ctx, meta.id, meta.version, true);
  }
}

/**
 * Start-up / refresh sync for every plugin that has (or may contribute) workflows.
 * Reconciles disabled flags for all origin definitions, then pages enabled plugins.
 * Must not run on the synchronous serve start-up path; callers schedule it.
 * SQLITE_BUSY defers with bounded backoff off the start-up path.
 */
export async function syncAllPluginWorkflows(ctx: Ctx, opts?: PluginSyncOpts): Promise<void> {
  // Mute plugin state publishes: startServer schedules this after listen, and starting
  // plugins to page workflow.definitions must not inject outbox noise into SSE/config
  // paths (same discipline as refused-at-registration: no bookkeeping plugin events).
  const reg = pluginRegistry(ctx);
  await reg.withoutStatePublish(() => syncAllPluginWorkflowsMuted(ctx, opts));
}

async function syncAllPluginWorkflowsMuted(ctx: Ctx, opts?: PluginSyncOpts): Promise<void> {
  let deferred = false;
  try {
    withFailFastWrites(ctx, () => reconcilePluginWorkflowFlags(ctx));
  } catch (error) {
    if (isSqliteBusy(error)) {
      deferred = true;
    } else {
      const message = error instanceof Error ? error.message : String(error);
      diagnostic(ctx, "host", `workflow sync reconcile failed: ${message}`);
      deferred = true;
    }
  }

  let targets: PluginInfo[] = [];
  try {
    const reg = pluginRegistry(ctx);
    targets = reg.list(ctx).filter(p => {
      const manifest = reg.manifestOf(ctx, p.id);
      return !!manifest?.contributes.workflow && pluginWorkflowsAreLive(p, manifest);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostic(ctx, "host", `workflow sync list failed: ${message}`);
    deferred = true;
    scheduleDeferredRetry(ctx, opts, (next) => {
      void syncAllPluginWorkflows(ctx, next).catch(() => { /* best-effort */ });
    });
    return;
  }

  for (const plugin of targets) {
    try {
      const result = await syncPluginWorkflows(ctx, plugin.id, opts);
      if (result === "deferred") deferred = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostic(ctx, plugin.id, `workflow sync failed: ${message}`);
    }
  }

  if (deferred) {
    scheduleDeferredRetry(ctx, opts, (next) => {
      void syncAllPluginWorkflows(ctx, next).catch(() => { /* best-effort */ });
    });
  }
}
