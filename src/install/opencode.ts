import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";

export function opencodeDir(ctx: Pick<Ctx, "home" | "env">): string {
  return join(ctx.env.XDG_CONFIG_HOME || join(ctx.home, ".config"), "opencode");
}

export function opencodeConfigPath(ctx: Pick<Ctx, "home" | "env">): string {
  const dir = opencodeDir(ctx);
  const jsonc = join(dir, "opencode.jsonc");
  return existsSync(jsonc) ? jsonc : join(dir, "opencode.json");
}
