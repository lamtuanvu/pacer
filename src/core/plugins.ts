import { pluginRegistry } from "../plugins";
import type { Ctx } from "../types";

export const list = (ctx: Ctx) => ({ plugins: pluginRegistry(ctx).list(ctx) });
export const enable = (ctx: Ctx, id: string, grant: boolean) => pluginRegistry(ctx).enable(ctx, id, grant);
export const disable = (ctx: Ctx, id: string) => pluginRegistry(ctx).disable(ctx, id);
export const remove = (ctx: Ctx, id: string) => pluginRegistry(ctx).remove(ctx, id);
export const doctor = async (ctx: Ctx, id?: string) => ({ reports: await pluginRegistry(ctx).doctor(ctx, id) });
