import { pluginRegistry } from "../plugins";
import type { Ctx } from "../types";
import { CoreError } from "./errors";
import { type SurfaceKind } from "../plugins/registry";
import { readPluginSettings, saveSettings, setSurfaceHidden, validateSettings } from "../plugins/settings";

export const list = (ctx: Ctx) => ({ plugins: pluginRegistry(ctx).list(ctx) });
export const enable = (ctx: Ctx, id: string, grant: boolean) => pluginRegistry(ctx).enable(ctx, id, grant);
export const disable = (ctx: Ctx, id: string) => pluginRegistry(ctx).disable(ctx, id);
export const remove = (ctx: Ctx, id: string) => pluginRegistry(ctx).remove(ctx, id);
export const doctor = async (ctx: Ctx, id?: string) => ({ reports: await pluginRegistry(ctx).doctor(ctx, id) });


type RenderContext = { route: string; taskId?: string; theme: string };
export const uiList = (ctx: Ctx) => ({ surfaces: pluginRegistry(ctx).uiList(ctx) });
export const uiRender = (ctx: Ctx, p: { plugin: string; surface: "activity" | "panelTab" | "status"; id: string; context: RenderContext }) => pluginRegistry(ctx).renderSurface(ctx, p.plugin, p.surface, p.id, p.context);
export const uiAction = (ctx: Ctx, p: { plugin: string; surface: "activity" | "panelTab" | "status"; id: string; action: string; context: RenderContext; requestId: string; values?: Record<string, unknown> }) =>
  pluginRegistry(ctx).actionSurface(ctx, p.plugin, p.surface, p.id, p.action, p.context, p.requestId, p.values);

const KIND_OF = { activity: "activity", panelTab: "panelTabs", status: "status", settings: "settings" } as const;
export async function uiVisibility(ctx: Ctx, p: { plugin: string; surface: keyof typeof KIND_OF; id: string; visible: boolean; expect_rev: number }) {
  const kind: SurfaceKind = KIND_OF[p.surface];
  const reg = pluginRegistry(ctx);
  reg.list(ctx);
  if (!reg.hasSurface(ctx, p.plugin, kind, p.id)) throw new CoreError("not_found", `plugin ${p.plugin} has no ${p.surface} surface ${p.id}`);
  const rec = await setSurfaceHidden(ctx, p.plugin, `${kind}:${p.id}`, p.visible, p.expect_rev);
  return { plugin: p.plugin, surface: p.surface, id: p.id, visible: p.visible, rev: rec.rev };
}

export function settingsGet(ctx: Ctx, p: { plugin: string }) {
  const page = pluginRegistry(ctx).settingsSchema(ctx, p.plugin);
  const rec = readPluginSettings(ctx, p.plugin);
  return { id: page.id, title: page.title, schema: page.schema, values: rec.values, rev: rec.rev };
}

export async function settingsSet(ctx: Ctx, p: { plugin: string; values: Record<string, unknown>; expect_rev: number }) {
  const reg = pluginRegistry(ctx);
  const page = reg.settingsSchema(ctx, p.plugin);
  const errors = validateSettings(page.schema, p.values);
  if (!errors.length) errors.push(...await reg.validateWithPlugin(ctx, p.plugin, page.id, p.values));
  if (errors.length) throw new CoreError("invalid_input", `plugin ${p.plugin} settings are invalid: ${errors.slice(0, 3).map(e => `${e.path} ${e.message}`).join("; ")}`, undefined, { errors: errors.slice(0, 50) });
  const rec = await saveSettings(ctx, p.plugin, p.values, p.expect_rev);
  return { values: rec.values, rev: rec.rev };
}
