import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CoreError } from "../core/errors";
import { withLock } from "../core/lock";
import type { Ctx } from "../types";
import { pluginsConfig } from "./config";
import { type SettingsField, type SettingsSchema, cleanText } from "./ui-schema";

/** Plugin settings, surface visibility and the settings revision. Independent of the active strategy; mode 0600 (SEC-7). */
export interface PluginSettingsRecord { rev: number; values: Record<string, unknown>; hidden: string[] }
type Store = Record<string, PluginSettingsRecord>;
const EMPTY: PluginSettingsRecord = { rev: 0, values: {}, hidden: [] };

const file = (ctx: Pick<Ctx, "pacerHome">) => join(ctx.pacerHome, "plugin-settings.json");

function readStore(ctx: Pick<Ctx, "pacerHome">): Store {
  const path = file(ctx);
  if (!existsSync(path)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw as Store;
  } catch { return {}; }
}

/** Write a temp file beside the store and rename it over, so a crash never leaves a half-written store. */
function writeStore(ctx: Pick<Ctx, "pacerHome">, store: Store): void {
  mkdirSync(ctx.pacerHome, { recursive: true, mode: 0o700 });
  const tmp = `${file(ctx)}.tmp`;
  writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file(ctx));
}

export function readPluginSettings(ctx: Pick<Ctx, "pacerHome">, id: string): PluginSettingsRecord {
  return readStore(ctx)[id] ?? { ...EMPTY, values: {}, hidden: [] };
}

/** What `config.get` returns: the strategy's `plugins.config.<id>` as the fallback, overlaid by saved settings. */
export function effectiveConfig(ctx: Ctx, id: string): Record<string, unknown> {
  return { ...(pluginsConfig(ctx).config[id] ?? {}), ...(readPluginSettings(ctx, id).values) };
}

export interface FieldError { path: string; message: string }

function checkField(name: string, f: SettingsField, v: unknown, errors: FieldError[]): void {
  const bad = (message: string): void => { errors.push({ path: name, message }); };
  switch (f.type) {
    case "boolean": if (typeof v !== "boolean") bad("must be on or off"); return;
    case "string":
      if (typeof v !== "string") return bad("must be text");
      if (v.length > (f.maxLength ?? 2000)) return bad(`must be at most ${f.maxLength ?? 2000} characters`);
      if (f.enum && !f.enum.includes(v)) return bad("must be one of the listed options");
      if (cleanText(v) !== v) bad("contains characters that are not allowed");
      return;
    case "secretRef":
      if (typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v)) bad("must be the name of a secret reference");
      return;
    case "integer":
      if (typeof v !== "number" || !Number.isInteger(v)) return bad("must be a whole number");
      if (v < f.minimum || v > f.maximum) bad(`must be between ${f.minimum} and ${f.maximum}`);
      return;
    case "array":
      if (!Array.isArray(v) || v.some(x => typeof x !== "string" || x.length > 2000 || cleanText(x) !== x)) return bad("must be a list of text");
      if (v.length > f.maxItems) bad(`must have at most ${f.maxItems} items`);
      return;
    case "repos":
      if (!Array.isArray(v) || v.some(x => typeof x !== "string" || x.length > 4096)) return bad("must be a list of repositories");
      if (v.length > (f.maxItems ?? 100)) bad(`must have at most ${f.maxItems ?? 100} items`);
      return;
  }
}

/** Validate values against the manifest schema. Unknown fields are errors; absent fields are fine. */
export function validateSettings(schema: SettingsSchema, values: Record<string, unknown>): FieldError[] {
  const errors: FieldError[] = [];
  for (const [name, v] of Object.entries(values)) {
    const f = schema.fields[name];
    if (!f) errors.push({ path: name, message: "is not a setting of this plugin" });
    else checkField(name, f, v, errors);
  }
  return errors.slice(0, 50);
}

const LOCK = "plugin-settings";

export function saveSettings(ctx: Ctx, id: string, values: Record<string, unknown>, expectRev: number): Promise<PluginSettingsRecord> {
  return withLock(ctx, LOCK, async () => {
    const store = readStore(ctx), cur = store[id] ?? { rev: 0, values: {}, hidden: [] };
    if (cur.rev !== expectRev) throw new CoreError("conflict", `plugin ${id} settings are at revision ${cur.rev}, not ${expectRev}`, "Reload the page and try again.");
    const next = { ...cur, rev: cur.rev + 1, values };
    writeStore(ctx, { ...store, [id]: next });
    return next;
  });
}

export function setSurfaceHidden(ctx: Ctx, id: string, key: string, visible: boolean, expectRev: number): Promise<PluginSettingsRecord> {
  return withLock(ctx, LOCK, async () => {
    const store = readStore(ctx), cur = store[id] ?? { rev: 0, values: {}, hidden: [] };
    if (cur.rev !== expectRev) throw new CoreError("conflict", `plugin ${id} is at revision ${cur.rev}, not ${expectRev}`, "Reload and try again.");
    const hidden = visible ? cur.hidden.filter(k => k !== key) : [...new Set([...cur.hidden, key])];
    const next = { ...cur, rev: cur.rev + 1, hidden };
    writeStore(ctx, { ...store, [id]: next });
    return next;
  });
}
