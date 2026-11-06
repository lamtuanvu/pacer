import { searchFiles } from "../core/files-search";
import type { Ctx } from "../types";
import { toCoreError } from "../core/errors";

export function filesSearchBridge(ctx: Ctx, params: { query: string; repo?: string; limit?: number }) {
  try {
    return searchFiles(ctx, params);
  } catch (e) {
    throw toCoreError(e);
  }
}
