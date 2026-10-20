import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "../fsutil";
import type { Ctx } from "../types";
import { isObj } from "../util";

/**
 * Cheap login indicators only: never start a CLI or inspect credential contents.
 * `file` is the file whose presence or contents gave the answer.
 */
export function loginIndicator(ctx: Ctx, id: string, folder?: string): { loggedIn: boolean; fix: string; file: string } | null {
  switch (id) {
    case "claude-code": {
      const root = folder ?? ctx.env.CLAUDE_CONFIG_DIR;
      const file = root ? join(root, ".claude.json") : join(ctx.home, ".claude.json");
      // .claude.json can be hundreds of KB and this runs on every hook; a substring check avoids parsing it.
      let text = "";
      try { text = readFileSync(file, "utf8"); } catch { /* missing */ }
      return { loggedIn: !!ctx.env.ANTHROPIC_API_KEY || text.includes('"oauthAccount"'), fix: "run claude and log in", file };
    }
    case "codex": {
      const file = join(folder ?? ctx.env.CODEX_HOME ?? join(ctx.home, ".codex"), "auth.json");
      return { loggedIn: !!ctx.env.OPENAI_API_KEY || !!ctx.env.CODEX_API_KEY || existsSync(file), fix: "codex login", file };
    }
    case "cursor": {
      const file = join(folder ?? join(ctx.home, ".cursor"), "cli-config.json");
      const config = readJson<unknown>(file);
      return { loggedIn: !!ctx.env.CURSOR_API_KEY || (isObj(config) && isObj(config.authInfo)), fix: "cursor-agent login", file };
    }
    case "opencode": {
      const file = join(ctx.env.XDG_DATA_HOME ?? join(ctx.home, ".local/share"), "opencode/auth.json");
      return { loggedIn: existsSync(file), fix: "opencode auth login", file };
    }
    default:
      return null;
  }
}
