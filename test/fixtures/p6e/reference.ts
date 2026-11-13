// Test-only loader: evaluate the current TS source with explicit in-memory effect
// boundaries. It never imports the runner, supervisor or plugin implementations.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CoreError } from "../../../src/core/errors";
import { workActionRequestId } from "../../../src/work/action-id";
const transpiler = new Bun.Transpiler({ loader: "ts" });
function load(path: string, names: string[], deps: Record<string, any>) {
  const source = transpiler
    .transformSync(
      readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8"),
    )
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replace(/\bexport /g, "");
  return Function(
    ...Object.keys(deps),
    `${source}\nreturn {${names.join(",")}};`,
  )(...Object.values(deps));
}
const error = (e: any) => {
  if (e instanceof ReferenceError || e instanceof TypeError) throw e;
  return {
    error: {
      code: e.code ?? "failed",
      message: e.message,
      ...(e.hint ? { hint: e.hint } : {}),
    },
  };
};
const hostsCfg = load("src/config/hosts.ts", ["canonical", "repoKey"], {});
const { AGENTS } = load("src/config/agent-id.ts", ["AGENTS"], {});
const runnerId = load("src/config/runner-id.ts", ["parseRunnerId"], { AGENTS });
const taskFns = load(
  "src/api/read-model/tasks.ts",
  ["taskAttentionReason", "supersededTaskIds"],
  {},
);
const discovery = load("src/discovery/prompts.ts", ["discoveryPrompts"], {});
const { executorName } = load("src/link/notification.ts", ["executorName"], {});
const { sliceText } = load("src/util.ts", ["sliceText"], {});
const { redactEndpointError } = load(
  "src/endpoints/state.ts",
  ["redactEndpointError"],
  { sliceText },
);
const { isOffered, closestModels } = load(
  "src/models/available.ts",
  ["isOffered", "closestModels"],
  {},
);
const { awaitsAnswer } = load("src/tasks/types.ts", ["awaitsAnswer"], {});
const rules = load("src/attention/rules.ts", ["deriveItems", "sortItems"], {
  awaitsAnswer,
  ...runnerId,
  ...taskFns,
  ...discovery,
  executorName,
  workActionRequestId,
});
const taskAttention = load("src/core/task-attention.ts", ["deriveTaskItems"], {
  ...taskFns,
  ...rules,
});
export async function reference(c: any): Promise<any> {
  if (c.runner) c = { ...c, runner: { account: c.account.name, ...c.runner } };
  const ctx: any = {
    now: c.now ?? 100,
    pacerHome: "/fixture",
    env: c.env ?? {},
    home: "/fixture",
    readOnly: false,
  };
  let state = structuredClone(
    Object.hasOwn(c, "raw") ? c.raw : (c.store ?? {}),
  );
  const memory = {
    join,
    CoreError,
    readJson: () => structuredClone(state),
    writeJsonAtomic: (_p: string, v: any) => {
      state = structuredClone(v);
    },
    withLockSync: (_c: any, _n: any, fn: any) => fn(),
  };
  try {
    if (c.op === "clients") {
      let id = "";
      const api = load(
        "src/clients/registry.ts",
        ["register", "heartbeat", "list", "activeNotifier"],
        { ...memory, z, randomUUID: () => id },
      );
      const results = [];
      for (const a of c.actions) {
        if (a.now !== undefined) ctx.now = a.now;
        id = a.id;
        try {
          results.push(
            a.type === "register"
              ? api.register(ctx, a.options)
              : a.type === "heartbeat"
                ? api.heartbeat(ctx, a.id, a.notifier)
                : a.type === "active"
                  ? api.activeNotifier(ctx)
                  : api.list(ctx),
          );
        } catch (e) {
          results.push(error(e));
        }
      }
      return { results, state };
    }
    if (c.op === "attention" || c.op === "attention.tasks") {
      const input = {
        now: ctx.now,
        tasks: [],
        executors: [],
        accounts: [],
        planner: null,
        setup: { items: [] },
        update: null,
        ...c.input,
        retryTarget: (t: any) => c.input.retryTargets?.[t.id] ?? null,
      };
      return (
        c.op === "attention" ? rules.deriveItems : taskAttention.deriveTaskItems
      )(input);
    }
    if (c.op === "attention.store") {
      const api = load(
        "src/attention/store.ts",
        ["applyStore", "dismissItem", "snoozeItem"],
        { ...memory, ...rules },
      );
      const results = [];
      for (const a of c.actions) {
        if (a.now !== undefined) ctx.now = a.now;
        try {
          results.push(
            a.type === "apply"
              ? api.applyStore(ctx, a.items)
              : a.type === "dismiss"
                ? api.dismissItem(ctx, a.id, a.items)
                : api.snoozeItem(ctx, a.id, a.duration, a.items),
          );
        } catch (e) {
          results.push(error(e));
        }
      }
      return { results, state };
    }
    if (c.op === "notify") {
      const api = load(
        "src/notify/decide.ts",
        ["toNotify", "dispatchNotifications", "deliverWithPlugins"],
        {
          ...memory,
          withLock: async (_c: any, _n: any, fn: any) => fn(),
          getLevel: () => ({ level: c.level }),
          deliveryPresenters: () =>
            c.notifier
              ? [{ client_id: c.notifier.client_id, kind: "desktop", medium: "os" }]
              : [],
        },
      );
      const deliveries: any[] = [],
        publications: any[] = [];
      const sent = await api.dispatchNotifications(ctx, c.items, {
        events: c.events ?? [],
        notifiers: c.notifiers ?? ["z", "a"],
        publish: async (_c: any, e: any) => {
          publications.push(e);
          return { transports: c.publishOk === false ? [] : ["outbox"] };
        },
        deliver: async (id: string, data: any) => {
          deliveries.push({ id, data });
          return c.deliveries?.[id] ?? true;
        },
      });
      return {
        candidates: api.toNotify(c.items, c.level, c.raw ?? {}),
        sent,
        deliveries,
        publications,
        state,
      };
    }
    if (c.op.startsWith("job.")) {
      let saved = structuredClone(c.job);
      let handover = false;
      const api = load(
        "src/jobs/registry.ts",
        ["cancelJob", "recoverJobs", "listJobs", "startJob"],
        {
          ...memory,
          resolve: (v: any) => v,
          randomUUID: () => "new-job",
          currentVersion: () => c.version ?? "1.0",
          process: {
            pid: 42,
            kill: () => {
              if (!c.alive) throw { code: "ESRCH" };
            },
          },
          mkdirSync: () => {},
          writeFileSync: (_p: any, v: any) => {
            saved = JSON.parse(v);
          },
          renameSync: () => {},
          readFileSync: () => JSON.stringify(saved),
          readdirSync: () => [`${saved.id}.json`],
          rmSync: () => {},
          publish: async () => ({ transports: [] }),
          beginWorkSync: () => ({}),
          finishWorkSync: () => {},
          withLock: async (_c: any, _n: any, fn: any) => fn(),
          Date: class extends Date {
            static now() {
              return 20000;
            }
          },
          redactEndpointError,
        },
      );
      if (c.op === "job.cancel") return api.cancelJob(ctx, saved.id);
      if (c.op === "job.recover") {
        api.recoverJobs(
          ctx,
          undefined,
          c.afterRestart
            ? () => {
                handover = true;
                return new Promise(() => {});
              }
            : undefined,
        );
        return { job: saved, handover };
      }
      if (c.op === "job.finishRestart") {
        api.recoverJobs(ctx, undefined, () =>
          c.failed
            ? Promise.reject(Error(c.detail))
            : Promise.resolve(c.detail),
        );
        if (c.latest) saved = structuredClone(c.latest);
        await Promise.resolve();
        await Promise.resolve();
        return saved;
      }
      if (c.op === "job.list") return api.listJobs(ctx, c.filter ?? {});
      if (c.op === "job.run") {
        // Existing job has a different target so the tested creation is admitted.
        return await api.startJob(
          ctx,
          c.kind ?? "host.check",
          "new",
          c.steps,
          async (step: any) => {
            for (const a of c.actions ?? []) {
              if (a.type === "cancel") api.cancelJob(ctx, "new-job");
              else step[a.type](a.name, a.detail);
            }
            if (c.runError)
              throw new CoreError(c.runError.code, c.runError.message);
          },
          { cancellable: c.cancellable, awaitRestart: c.awaitRestart },
        );
      }
    }
    if (c.op.startsWith("host.")) {
      const host = {
        alias: c.alias,
        ssh: c.alias,
        maxTasks: 2,
        repos: {},
        accounts: {},
        ...c.host,
      };
      const local = {
        origin: "https://github.com/acme/api.git",
        name: "Dev",
        email: "dev@example.invalid",
        ...c.local,
      };
      const runners = Object.fromEntries(
        (c.runners ?? []).map((r: any, i: number) => [i, r]),
      );
      const steps: any[] = [];
      const step = Object.fromEntries(
        ["start", "pass", "fail", "skip"].map((type) => [
          type,
          (name: string, detail?: string) =>
            steps.push({
              type,
              name,
              ...(detail !== undefined ? { detail } : {}),
            }),
        ]),
      );
      let observedPath = "";
      ctx.run = async (argv: string[]) => {
        observedPath = argv[2]!;
        const selected = (c.candidates ?? []).find(
          (candidate: any) => candidate.path === observedPath,
        );
        const current = { ...local, ...selected };
        return {
          code: 0,
          stdout: argv.includes("get-url")
            ? current.origin
            : argv.includes("user.name")
              ? current.name
              : current.email,
        };
      };
      const api = load(
        "src/remote/hosts.ts",
        [
          "check",
          "setup",
          "clean",
          "summary",
          "prepareCheck",
          "setupJob",
          "SETUP_CLONE_PREVIEW",
        ],
        {
          ...memory,
          ...hostsCfg,
          loadStrategy: () => ({
            hosts: { [c.alias]: host },
            runners,
            accounts: {},
          }),
          listRepos: () => c.repos ?? [],
          listJobs: () => c.jobs ?? [],
          listTasks: () =>
            c.candidates
              ? c.candidates
                  .slice(1)
                  .map((candidate: any) => ({
                    brief: { repo: candidate.path },
                  }))
              : (c.tasks ?? []),
          process: { cwd: () => c.candidates?.[0]?.path ?? "/fixture/repo" },
          startJob: async (
            _ctx: any,
            kind: string,
            target: string,
            names: string[],
          ) => ({ kind, target, names, repo: observedPath }),
          listTasksWhere: () =>
            (c.tasks ?? []).filter((t: any) => t.state === "running"),
          TERMINAL_STATES: [
            "done",
            "partial",
            "failed",
            "limit",
            "stopped",
            "needs_input",
          ],
          pluginAvailabilityReason: () => c.unavailable ?? null,
          readHostCheck: () => c.stored ?? null,
          readHostReachability: () => c.reachability ?? null,
          probeCodexUsage: async () => {},
          transferred: async (_c: any, t: any) =>
            c.transferred?.[t.id] ?? false,
          driftFingerprint: () => c.hostFingerprint ?? null,
          issueConfiguredHostClone: async () => ({}),
          issueConfiguredHostIdentity: async () => ({}),
          issueConfiguredHostClean: async (
            _c: any,
            _a: any,
            id: string,
            received: boolean,
          ) => {
            if (!received) throw new Error("unreceived");
            return { id };
          },
          pluginRegistry: () => ({
            checkConfiguredHost: async (_c: any, _a: any, path?: string) =>
              path ? (c.repoProbes?.[path] ?? c.probe) : c.probe,
            checkConfiguredAccountHome: async (
              _c: any,
              _a: any,
              account: string,
            ) => ({ ok: c.accountHomes?.[account] ?? true }),
            cloneConfiguredHost: async () => ({ code: c.cloneCode ?? 0 }),
            find: () => c.caller ?? "pacer-remote-caller",
            callWithIssuedHostIdentity: async () => ({
              code: c.identityCode ?? 0,
            }),
            cleanConfiguredHost: async (_c: any, g: any) => ({
              code: c.cleanCodes?.[g.id] ?? 0,
            }),
          }),
        },
      );
      if (c.op === "host.setupPlan")
        return await api.setupJob(ctx, c.alias, c.key, c.options);
      if (c.op === "host.clean")
        return await api.clean(ctx, c.alias, { dryRun: c.dryRun });
      if (c.op === "host.summary") {
        state = { [c.alias]: c.stored };
        return api.summary(ctx, host);
      }
      try {
        const result =
          c.op === "host.check"
            ? await api.check(ctx, c.alias, {
                steps: step,
                ...(c.repo ? { repo: c.repo } : {}),
              })
            : await api.setup(ctx, c.alias, "repo", {
                ...c.options,
                steps: step,
                ...(c.preview ? { [api.SETUP_CLONE_PREVIEW]: c.preview } : {}),
              });
        return { result, steps };
      } catch (e) {
        return { ...error(e), steps };
      }
    }
    if (c.op === "runner.check") {
      let result: any;
      const stepEvents: any[] = [];
      const steps = Object.fromEntries(
        ["start", "pass", "fail", "skip"].map((type) => [
          type,
          (name: string, detail?: string) =>
            stepEvents.push({
              type,
              name,
              ...(detail !== undefined ? { detail } : {}),
            }),
        ]),
      );
      let reads = 0;
      const api = load("src/core/runner-check.ts", ["checkRunner"], {
        ...memory,
        loadStrategy: () => ({
          accounts: { [c.account.name]: c.account },
          hosts: {},
          runners: {},
        }),
        resolveRunner: () => c.runner,
        withLock: async (_c: any, _n: any, fn: any) => fn(),
        startJob: async (
          _c: any,
          kind: any,
          target: any,
          names: any,
          run: any,
        ) => {
          try {
            await run(steps);
          } catch (e) {
            result = error(e);
          }
          return {
            kind,
            target,
            names,
            steps: stepEvents,
            ...result,
            stored: state,
          };
        },
        detectAgents: async () => [{ agent: c.runner.agent, ...c.found }],
        listAccounts: async () =>
          c.status ? [{ name: c.account.name, ...c.status }] : [],
        checkLimits: async () => {
          reads++;
          return (reads > 1 ? (c.refreshed ?? c.row) : c.row)
            ? [
                {
                  account: c.account.name,
                  ...(reads > 1 ? (c.refreshed ?? c.row) : c.row),
                },
              ]
            : [];
        },
        runTestTask: async () => {
          if (c.testError) throw Error(c.testError);
        },
        readAccountUsage: async () => {},
        accountSignIn: () => ({ reason: c.signInReason }),
        accountEvidenceScope: () => ({}),
        availableModels: async () => {
          const m = c.models;
          if (!m) return { runner: c.runner.id, source: "none", models: null, fetchedAt: ctx.now };
          return {
            runner: c.runner.id,
            source: m.source,
            models:
              m.offered !== null && m.offered !== undefined
                ? [
                    ...(m.offered === true ? [{ id: c.runner.model }] : []),
                    ...m.closest.map((id: string) => ({ id })),
                  ]
                : null,
            fetchedAt: ctx.now,
            ...(m.note !== undefined ? { note: m.note } : {}),
          };
        },
        isOffered,
        closestModels,
        redactEndpointError,
      });
      return await api.checkRunner(ctx, c.runner.id);
    }
    throw Error(`unsupported ${c.op}`);
  } catch (e) {
    return error(e);
  }
}
