import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import { orcaAdd, orcaOpen, orcaRemove, orcaStatus, orcaUpdate } from "./orca";
import type { AppActionResult, AppAddResult, AppId, AppStatus } from "./types";

const APP_IDS: readonly AppId[] = ["orca"];

function requireId(id: string): AppId {
  if ((APP_IDS as readonly string[]).includes(id)) return id as AppId;
  throw new CoreError("not_found", `unknown app "${id}"`, `Known apps: ${APP_IDS.join(", ")}`);
}

/** Every host app pacer can add itself to, with live detect/status. */
export async function listApps(ctx: Ctx): Promise<{ apps: AppStatus[] }> {
  return { apps: [await orcaStatus(ctx)] };
}

/** Add pacer to a host app. Pass `approve` only after the person confirmed that fingerprint. */
export async function addApp(ctx: Ctx, id: string, approve?: string): Promise<AppAddResult> {
  requireId(id);
  return orcaAdd(ctx, approve);
}

export async function openApp(ctx: Ctx, id: string): Promise<AppActionResult> {
  requireId(id);
  return orcaOpen(ctx);
}

export async function updateApp(ctx: Ctx, id: string, approve?: string): Promise<AppAddResult> {
  requireId(id);
  return orcaUpdate(ctx, approve);
}

export async function removeApp(ctx: Ctx, id: string): Promise<AppActionResult> {
  requireId(id);
  return orcaRemove(ctx);
}

export type { AppStatus, AppAddResult, AppActionResult, AppId, AppPresence } from "./types";
export type { AppGrant } from "./grants";
