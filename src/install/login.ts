import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "../fsutil";
import type { Ctx } from "../types";
import { isObj } from "../util";

/** Cheap login indicators only: never start a CLI or inspect credential contents. */
export function loginIndicator(ctx: Ctx, id: string, folder?: string): { loggedIn: boolean; fix: string } | null {
  switch (id) {
    case "claude-code": {
      const root = folder ?? ctx.env.CLAUDE_CONFIG_DIR;
      // .claude.json can be hundreds of KB and this runs on every hook; a substring check avoids parsing it.
      let text = "";
      try { text = readFileSync(root ? join(root, ".claude.json") : join(ctx.home, ".claude.json"), "utf8"); } catch { /* missing */ }
      return { loggedIn: !!ctx.env.ANTHROPIC_API_KEY || text.includes('"oauthAccount"'), fix: "run claude and log in" };
    }
    case "codex":
      return { loggedIn: !!ctx.env.OPENAI_API_KEY || !!ctx.env.CODEX_API_KEY || existsSync(join(folder ?? ctx.env.CODEX_HOME ?? join(ctx.home, ".codex"), "auth.json")), fix: "codex login" };
    case "cursor": {
      const config = readJson<unknown>(join(folder ?? join(ctx.home, ".cursor"), "cli-config.json"));
      return { loggedIn: !!ctx.env.CURSOR_API_KEY || (isObj(config) && isObj(config.authInfo)), fix: "cursor-agent login" };
    }
    case "opencode":
      return { loggedIn: existsSync(join(ctx.env.XDG_DATA_HOME ?? join(ctx.home, ".local/share"), "opencode/auth.json")), fix: "opencode auth login" };
    default:
      return null;
  }
}
