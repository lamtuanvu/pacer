import { arch, platform } from "node:os";
import { execFileSync } from "node:child_process";
import pkg from "../../package.json";
import { validateExecution } from "../config/execution";
import { loadStrategy, validateStrategy } from "../config/strategy";
import { readProjectStrategies } from "../config/project-strategies";
import { desktopUpdateStatuses } from "../update/desktop/service";
import { discoveryRuleInput } from "../discovery/prompts";
import { policySummary } from "../plugins/policy";
import { waitingIO } from "../core/path-probe";
import { computeStatus } from "../engine/status";
import { machineGuardState } from "../engine/machine";
import { serviceInstalled } from "../service";
import { PROTOCOL_VERSION } from "./protocol";
import { readModelContext, serviceNotifiers } from "./read-model";
import { sessionProbeParts } from "./session-probe-bridge";
import type { Ctx } from "../types";

const machineOS = (() => {
  if (platform() !== "darwin") return platform();
  try {
    return `macOS ${execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8", timeout: 1000 }).trim()}`;
  } catch {
    return "macOS (version unavailable)";
  }
})();

const startedAt = Math.floor(Date.now() / 1000 - process.uptime());

function waitingField() {
  const waiting = waitingIO();
  return waiting ? { waiting } : {};
}

function strategyForSnapshot(ctx: Ctx) {
  try {
    return loadStrategy(ctx);
  } catch {
    const strategy = validateStrategy({ planner: "claude-code", providers: { "claude-code": {} } }, "snapshot");
    strategy.runners = {};
    strategy.accounts = {};
    strategy.providers = {};
    strategy.routing = [];
    return strategy;
  }
}

/** Injection payload for native `snapshot.get` read-model composition. */
export async function snapshotProbeParts(ctx: Ctx) {
  const session = sessionProbeParts(ctx);
  const { setup } = await readModelContext(ctx);
  const policy = policySummary(ctx);
  const strategy = strategyForSnapshot(ctx);
  const execution = validateExecution(strategy.execution);
  const machine = { os: machineOS, arch: arch(), ...machineGuardState(execution) };
  let policyError: string | undefined;
  try {
    readProjectStrategies(ctx);
  } catch (error) {
    policyError = error instanceof Error ? error.message : String(error);
  }
  const notifiers = serviceNotifiers(ctx);
  const service = {
    ...(policyError ? { projectStrategyError: policyError } : {}),
    version: pkg.version,
    protocol: PROTOCOL_VERSION,
    pid: process.pid,
    startedAt,
    notifiers,
    notifier: notifiers.os,
    ...waitingField(),
  };
  const discovery = discoveryRuleInput(ctx, ctx.now);
  let status: unknown;
  let statusError: string | undefined;
  try {
    status = await computeStatus({ ...ctx, readOnly: true }, strategy);
  } catch (error) {
    statusError = error instanceof Error ? error.message : String(error);
  }
  return {
    revision: session.revision,
    active: session.active,
    alivePids: session.alivePids,
    setup,
    policy,
    machine,
    service,
    desktopUpdates: desktopUpdateStatuses(ctx),
    serviceInstalled: serviceInstalled(ctx),
    canPair: discovery?.canPair ?? false,
    status,
    statusError,
  };
}
