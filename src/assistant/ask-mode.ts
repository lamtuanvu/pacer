import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PORT } from "../serve/constants";
import { pacerArgv } from "../install/self";
import type { Ctx } from "../types";

/**
 * Ask mode for the executor backend (spec §3): one `opencode run` per turn, restricted to pacer's
 * own tools. The host builds every command and the config that carries the turn's grant; the
 * plugin only runs a command it was issued and reads its output, so the grant never reaches it.
 */

/** The reference the plugin passes for the config; the host resolves it when the command runs. */
export const ASK_CONFIG_REF = "secrets:assistantAskConfig";

/** Built-in opencode tools ask mode denies. `execute` is Code Mode, which can call opencode's own
 * tools and `fetch`; it is not covered by the tool.use policy and must be denied by permission. */
export const ASK_DENIED = ["execute", "shell", "edit", "read", "glob", "grep", "webfetch", "websearch", "subagent", "skill", "question", "experimental_image_generate"] as const;

/** One host-issued command, as the plugin must echo it to `capability.process.spawn`. */
export interface AskCommand {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  timeoutMs: number;
}

export interface AskTurn {
  /** Resumes `session` when one is stored for this account and backend, else starts one. */
  command: AskCommand;
  /** A new session seeded with the transcript, for when resuming fails. Absent without a session. */
  fallback?: AskCommand;
  /** The rendered opencode config, bound to `ASK_CONFIG_REF` for this call only. */
  config: string;
  /** Delete the turn's run directory. */
  cleanup: () => void;
}

/** The service address the CLI's MCP server reaches pacer at. */
export function serviceUrl(ctx: Ctx): string {
  return `http://127.0.0.1:${ctx.env.PACER_PORT ?? DEFAULT_PORT}`;
}

/** The restricted opencode config for one turn: one agent, every built-in denied, pacer's MCP server only. */
export function askConfig(o: { pacer: string[]; grant: string; url: string; turnId: string; runDir: string; system: string }): string {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    default_agent: "pacer-ask",
    instructions: [],
    plugins: [],
    agents: {
      "pacer-ask": {
        description: "pacer ask mode: pacer's read tools only",
        mode: "primary",
        system: o.system,
        permissions: [
          ...ASK_DENIED.map(action => ({ action, resource: "*", effect: "deny" })),
          { action: "pacer_*", resource: "*", effect: "allow" },
        ],
      },
    },
    policies: [
      { action: "tool.use", resource: "*", effect: "deny" },
      { action: "tool.use", resource: "pacer_*", effect: "allow" },
    ],
    mcp: {
      servers: {
        pacer: {
          type: "local",
          // Listed directly, not through Code Mode, so `execute` can stay denied.
          codemode: false,
          command: [...o.pacer, "mcp", "--assistant"],
          environment: { PACER_ASSISTANT_GRANT: o.grant, PACER_ASSISTANT_URL: o.url, PACER_ASSISTANT_TURN: o.turnId, PACER_HOME: o.runDir },
        },
      },
    },
  });
}

/** The prompt for a fresh session: the stored transcript, then the new question. */
export function seededPrompt(history: readonly { role: "user" | "assistant"; content: string }[], question: string): string {
  if (!history.length) return question;
  const lines = history.map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`);
  return `Earlier in this conversation:\n${lines.join("\n\n")}\n\nNew question:\n${question}`;
}

/** Build one turn's commands in a fresh, empty run directory under the service's runs. */
export function askTurn(ctx: Ctx, o: {
  turnId: string; grant: string; model: string | null; session?: string;
  system: string; question: string; history: readonly { role: "user" | "assistant"; content: string }[]; timeoutMs: number;
}): AskTurn {
  const runDir = join(ctx.pacerHome, "runs", "assistant", o.turnId);
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const config = askConfig({ pacer: pacerArgv(ctx.env), grant: o.grant, url: serviceUrl(ctx), turnId: o.turnId, runDir, system: o.system });
  // Only configuration is isolated: HOME and XDG_DATA_HOME stay the user's, so opencode finds its
  // own sign-in for the account and pacer never reads or copies the key.
  const env: Record<string, string> = {
    XDG_CONFIG_HOME: join(runDir, "config"), OPENCODE_CONFIG_DIR: join(runDir, "config"),
    OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
  };
  const argv = (session?: string) => ["opencode", "run", "--standalone", "--format", "json", "--agent", "pacer-ask",
    ...(o.model ? ["--model", o.model] : []), ...(session ? ["--session", session] : ["--title", "pacer assistant"])];
  const command: AskCommand = { argv: argv(o.session), cwd: runDir, env, stdin: o.session ? o.question : seededPrompt(o.history, o.question), timeoutMs: o.timeoutMs };
  const fallback: AskCommand | undefined = o.session ? { ...command, argv: argv(), stdin: seededPrompt(o.history, o.question) } : undefined;
  return { command, ...(fallback ? { fallback } : {}), config, cleanup: () => rmSync(runDir, { recursive: true, force: true }) };
}
