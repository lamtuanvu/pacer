import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";
export function listStrategies(ctx: Ctx): string[] {
  const dir = join(ctx.pacerHome, "strategies");
  const names = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter(f => f.isFile() && f.name.endsWith(".yaml")).map(f => f.name.slice(0, -5)) : [];
  return ["default", ...names.filter(name => name !== "default").sort()];
}

