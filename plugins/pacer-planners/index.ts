import { join } from "node:path";
import type { Handler, PluginManifest } from "@pacer/plugin";
import {
  preparePlannerInstall,
  preparePlannerUninstallFiles,
  createPlannerIO,
  readPlannerPrior,
  sha256,
  piecesPresent,
} from "@pacer/plugin/install";
import type { PlannerRecord } from "@pacer/plugin/install";
import type { PlannerBuilder } from "./types";
import { installClaude, removeClaudeMcp, claudePreview } from "./claude";
import { installCodex } from "./codex";
import { installCursor } from "./cursor";
import { installOpencodeFiles } from "./opencode";
export const manifest: PluginManifest = {
  id: "pacer-planners",
  version: "0.1.0",
  publisher: "pacer",
  host: "^1.4",
  contributes: {
    planner: { agents: ["claude-code", "codex", "cursor", "opencode"] },
  },
  capabilities: [
    { name: "fs.read", scopes: ["${ACCOUNT_HOME}/**", "${HOME}/**"] },
    { name: "fs.write", scopes: ["${ACCOUNT_HOME}/**", "${HOME}/**"] },
    {
      name: "process.spawn",
      scopes: ["claude", "codex", "cursor-agent", "cursor", "opencode"],
    },
  ],
  tier: "free",
  reentrant: false,
};
const prepare: Handler = async (raw, host, signal) => {
  const params = raw as any;
  const prior = params.priorRange
    ? await readPlannerPrior(host, params.priorRange)
    : params.prior;
  return preparePlannerInstall(
    createPlannerIO(host, signal),
    params.env,
    prior as PlannerRecord | undefined,
    async (builder) => {
      const tx = builder as PlannerBuilder;
      tx.context = {
        home: params.home,
        env: params.env.configEnv ?? {},
        binary: params.binary,
        list: async (dir, glob) => {
          const value = await host.call<{ files: { path: string }[] }>(
            "capability.fs.list",
            { dir, glob },
          );
          return value.files.map((file) => file.path);
        },
      };
      if (params.agent === "claude-code") await installClaude(tx);
      else if (params.agent === "codex") await installCodex(tx);
      else if (params.agent === "cursor") await installCursor(tx);
      else if (params.agent === "opencode") await installOpencodeFiles(tx);
      else throw Error("unsupported planner");
    },
  );
};
export const handlers: Record<string, Handler> = {
  "planner.install": prepare,
  "planner.plan": prepare,
  "planner.detect": async (raw, host) => {
    const p = raw as any,
      hints = {
        "claude-code": "npm install -g @anthropic-ai/claude-code",
        codex: "npm install -g @openai/codex",
        cursor:
          "Install Cursor CLI from https://cursor.com/docs/cli/installation",
        opencode: "brew install opencode",
      } as Record<string, string>;
    let version: string | null = null;
    if (p.binary?.path && p.binary.name !== "cursor" && p.probe)
      try {
        const result = await host.call<{
          code: number;
          stdout: string;
          stderr: string;
        }>("capability.process.spawn", p.probe);
        if (result.code === 0)
          version =
            `${result.stdout}\n${result.stderr}`.match(
              /\d+\.\d+(?:\.\d+)?/,
            )?.[0] ?? null;
      } catch {}
    return {
      agent: p.agent,
      found: !!p.binary?.path,
      version,
      path: p.binary?.path ?? null,
      install_hint: hints[p.agent],
    };
  },
  "planner.check": async (raw, host, signal) => {
    const p = raw as any,
      io = createPlannerIO(host, signal),
      files = [];
    for (const file of p.files) {
      const image = await io.read(file.path);
      let intact = false;
      if (file.action === "moved")
        intact =
          image === null &&
          !!file.backup &&
          (await io.read(file.backup)) !== null;
      else
        intact =
          image !== null &&
          ((!!file.afterHash && sha256(image.text) === file.afterHash) ||
            (file.undo.length > 0 && piecesPresent(image.text, file.undo)));
      files.push({ path: file.path, intact });
    }
    return { intact: files.every((file) => file.intact), files };
  },
  "planner.preview": async (raw, host, signal) => {
    const p = raw as any,
      root = p.env.folder,
      skill = p.env.skillFolder ?? root;
    const files = [
      join(skill, "skills/pacer/SKILL.md"),
      ...(
        {
          "claude-code": [
            join(root, "rules/pacer.md"),
            join(root, "settings.json"),
          ],
          codex: [join(root, "AGENTS.md"), join(root, "hooks.json")],
          cursor: [join(root, "hooks.json")],
          opencode: [join(root, "AGENTS.md")],
        } as Record<string, string[]>
      )[p.agent]!,
    ];
    return {
      files,
      undo: `pacer uninstall ${p.env.plannerKey}`,
      ...(p.agent === "claude-code"
        ? {
            detail: await claudePreview(
              createPlannerIO(host, signal),
              p.home,
              root,
            ),
          }
        : {}),
    };
  },
  "planner.uninstall": async (raw, host, signal) => {
    const params = raw as any,
      io = createPlannerIO(host, signal);
    const prior = (
      params.priorRange
        ? await readPlannerPrior(host, params.priorRange)
        : params.prior
    ) as PlannerRecord;
    const plan = await preparePlannerUninstallFiles(io, prior);
    for (const { undo } of [...prior.commands].reverse()) {
      if (
        params.agent === "claude-code" &&
        undo[1] === "mcp" &&
        undo[2] === "remove"
      ) {
        const removed = await removeClaudeMcp(
          {
            runRaw: (argv) => io.run({ argv, timeoutMs: 30000 }),
            notes: plan.notes,
          },
          undo,
        );
        if (!removed)
          throw new Error(
            "recorded command undo failed; install record retained. Restore the agent CLI and retry uninstall",
          );
        continue;
      }
      const result = await io.run({ argv: [...undo], timeoutMs: 30000 });
      if (result.code !== 0)
        throw new Error(
          "recorded command undo failed; install record retained. Restore the agent CLI and retry uninstall",
        );
    }
    plan.uninstallReport.notes = [...plan.notes];
    return plan;
  },
};
