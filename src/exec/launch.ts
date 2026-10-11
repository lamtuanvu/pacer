import { join } from "node:path";
import type { ProviderCfg } from "../config/strategy";

export interface Launch { argv: string[]; cwd: string; stdin?: string; lastMessageFile?: string }

export function launchFor(cfg: ProviderCfg, prompt: string, repo: string, taskDir: string, taskId: string): Launch {
  const model = cfg.model;
  if (cfg.via === "opencode") {
    return {
      cwd: repo,
      argv: ["opencode", "run", "--agent", "build", "-m", model ?? "", "--auto", "--title", `pacer ${taskId}`, prompt],
    };
  }
  switch (cfg.id) {
    case "codex": {
      const lastMessageFile = join(taskDir, `${taskId}.codex-last.md`);
      return {
        cwd: repo,
        stdin: prompt,
        lastMessageFile,
        argv: ["codex", "exec", "-C", repo, "-s", "workspace-write", "--skip-git-repo-check", "-o", lastMessageFile,
          ...(model ? ["-m", model] : []), "-"],
      };
    }
    case "cursor":
      return {
        cwd: repo,
        argv: ["cursor-agent", "-p", "--output-format", "text", "--force", "--workspace", repo, ...(model ? ["--model", model] : []), prompt],
      };
    case "agy":
      return {
        cwd: repo,
        argv: ["agy", "-p", "--sandbox", "--dangerously-skip-permissions", "--add-dir", repo, ...(model ? ["--model", model] : []), prompt],
      };
    case "claude-code":
      return {
        cwd: repo,
        argv: ["claude", "-p", "--permission-mode", "acceptEdits", "--output-format", "text", ...(model ? ["--model", model] : []), prompt],
      };
    default:
      throw new Error(`no launcher for provider "${cfg.id}"`);
  }
}
