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

/**
 * How ask mode restricts opencode (verified against opencode 2.2.3 with a real model):
 * - The `tool.use` policy denies every tool except pacer's MCP tools. Denied tools stay on the
 *   model's list and every attempt fails with "Blocked by configuration policy", which is the
 *   evidence the self-test needs. (An agent-permission deny removes a tool from the list instead,
 *   so an attempt could never be observed.)
 * - `execute` (Code Mode) is not covered by that policy: its runtime can call opencode's own tools
 *   and `fetch`. Only the agent-permission deny removes it, so it is denied there.
 */
export const ASK_REMOVED = ["execute"] as const;

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
/**
 * Whether ask mode hands the agent pacer's read tools through `pacer mcp --assistant`. Off in v1:
 * opencode 2.2.3 connects the server but does not offer its tools to the model, so the agent
 * answers from the host-built digest and the conversation alone, with every tool denied. The grant
 * and the MCP path stay in place for when that is resolved.
 */
export const ASK_PACER_TOOLS = false;

/** What the agent is told in v1, where it has no tools. */
export const ASK_NO_TOOLS = "You have no tools in this conversation. Answer only from the pacer digest above and the conversation. When the answer needs data the digest does not show, say so plainly and name what the user can open in pacer to see it.";

export function askConfig(o: { pacer: string[]; grant: string; url: string; turnId: string; runDir: string; system: string; tools?: boolean }): string {
  const tools = o.tools ?? ASK_PACER_TOOLS;
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
          ...ASK_REMOVED.map(action => ({ action, resource: "*", effect: "deny" })),
          { action: "pacer_*", resource: "*", effect: "allow" },
        ],
      },
    },
    policies: [
      { action: "tool.use", resource: "*", effect: "deny" },
      ...(tools ? [{ action: "tool.use", resource: "pacer_*:*", effect: "allow" }] : []),
    ],
    ...(tools ? {
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
    } : {}),
  });
}

/** The prompt for a fresh session: the stored transcript, then the new question. */
export function seededPrompt(history: readonly { role: "user" | "assistant"; content: string }[], question: string): string {
  if (!history.length) return question;
  const lines = history.map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`);
  return `Earlier in this conversation:\n${lines.join("\n\n")}\n\nNew question:\n${question}`;
}

/** Build one turn's commands: a per-turn config directory and the conversation's empty working directory. */
export function askTurn(ctx: Ctx, o: {
  turnId: string; conversationId: string; grant: string; model: string | null; session?: string;
  system: string; question: string; history: readonly { role: "user" | "assistant"; content: string }[]; timeoutMs: number;
}): AskTurn {
  // opencode binds a session to its working directory, so each conversation keeps one empty
  // directory to resume in; the turn's own directory holds its isolated config and is deleted after.
  const runDir = join(ctx.pacerHome, "runs", "assistant", o.turnId);
  const cwd = join(ctx.pacerHome, "runs", "assistant", "conversations", o.conversationId);
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const config = askConfig({ pacer: pacerArgv(ctx.env), grant: o.grant, url: serviceUrl(ctx), turnId: o.turnId, runDir, system: o.system });
  // Only configuration is isolated: HOME and XDG_DATA_HOME stay the user's, so opencode finds its
  // own sign-in for the account and pacer never reads or copies the key.
  const env: Record<string, string> = {
    XDG_CONFIG_HOME: join(runDir, "config"), OPENCODE_CONFIG_DIR: join(runDir, "config"),
    OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
  };
  const argv = (session?: string) => ["opencode", "run", "--standalone", "--format", "json", "--agent", "pacer-ask",
    ...(o.model ? ["--model", o.model] : []), ...(session ? ["--session", session] : ["--title", "pacer assistant"])];
  const command: AskCommand = { argv: argv(o.session), cwd, env, stdin: o.session ? o.question : seededPrompt(o.history, o.question), timeoutMs: o.timeoutMs };
  const fallback: AskCommand | undefined = o.session ? { ...command, argv: argv(), stdin: seededPrompt(o.history, o.question) } : undefined;
  return { command, ...(fallback ? { fallback } : {}), config, cleanup: () => rmSync(runDir, { recursive: true, force: true }) };
}
