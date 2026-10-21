import { recordProvenance } from "./provenance";
import { desktopDoctor } from "./doctor";
import { readFileSync } from "node:fs";
import { runScenario } from "./scenarios";
import { loadSession } from "../core";
import { createDesktopAdapter, nativeCommand } from "./desktop";
import { createTuiAdapter } from "./tui";
import { dispatch } from "./dispatch";
import { createCaptureWriter, recordStep } from "./evidence";
import { acquireLease } from "./lease";
import { ControlError, requestSchema, type ControlResult, type ControlRequest } from "./contract";
export const CONTROL_COMMANDS = new Set(["targets", "inspect", "act", "wait", "assert", "capture", "doctor"]);
export async function controlMain(argv: string[]): Promise<number> {
  const options = new Map<string, string>();
  const started = new Date().toISOString();
  try {
    for (let i = 1; i < argv.length; i++) {
      const name = argv[i];
      if (name === "--json") continue;
      if (!["--id", "--surface", "--target", "--selector", "--ref", "--revision", "--generation", "--action", "--text", "--key", "--value", "--width", "--height", "--delta-x", "--delta-y", "--x", "--y", "--capture-id", "--mode", "--condition", "--timeout-ms", "--file"].includes(name)) throw new ControlError("invalid_input", `unknown option ${name}`);
      if (argv[i + 1] === undefined) throw new ControlError("invalid_input", `${name} needs a value`);
      options.set(name.slice(2).replaceAll("-", "_"), argv[++i]);
    }
    const number = (name: string) => options.has(name) ? Number(options.get(name)) : undefined;
    const action = argv[0] === "act" ? { kind: options.get("action"), selector: options.has("selector") ? JSON.parse(options.get("selector")!) : undefined,
      ref: options.get("ref"), revision: options.get("revision"), generation: options.get("generation"), text: options.get("text"), key: options.get("key"), value: options.get("value"),
      x: number("x"), y: number("y"), capture_id: options.get("capture_id"), width: number("width"), height: number("height"), delta_x: number("delta_x"), delta_y: number("delta_y") } : undefined;
    if (argv[0] === "scenario") {
      const session = loadSession(options.get("id"));
      if (!options.get("file")) throw new ControlError("invalid_input", "scenario requires --file");
      const summary = await runScenario(JSON.parse(readFileSync(options.get("file")!, "utf8")), request => executeControl(session, request));
      console.log(JSON.stringify(summary)); return summary.verdict === "PASS" ? 0 : 1;
    }
    const request = requestSchema.parse({ command: argv[0], surface: options.get("surface") ?? "web", target: options.get("target"), action,
      condition: options.has("condition") ? JSON.parse(options.get("condition")!) : undefined, mode: options.get("mode"), timeout_ms: number("timeout_ms") });
    const session = loadSession(options.get("id"));
    const result = await executeControl(session, request);
    console.log(JSON.stringify(result)); return result.outcome === "ok" ? 0 : 1;
  } catch (error) {
    const result: ControlResult = { schema_version: 1, command_id: crypto.randomUUID(), command: argv[0], started_at: started, finished_at: new Date().toISOString(), outcome: "error", artifacts: [],
      delivery: error instanceof ControlError ? error.delivery : undefined,
      error: { code: error instanceof ControlError ? error.code : "invalid_input", message: error instanceof Error ? error.message : String(error) } };
    console.log(JSON.stringify(result)); return 1;
  }
}

export async function executeControl(session: import("../core").Session, input: ControlRequest): Promise<ControlResult> {
  const request = requestSchema.parse(input);
  const provenance = recordProvenance(session);
  let result: ControlResult;
  if (request.command === "doctor" && request.surface === "desktop") { result = await desktopDoctor(session); result.provenance = provenance; result.run_id = session.id; recordStep(session, result); return result; }
  if (request.surface === "web" || request.surface === "tray") result = await (await import("./worker")).browserCommand(session, request);
    else if (request.surface === "tui") {
      const lease = await acquireLease(`tui-${session.id}`, { run_id: session.id });
      try { result = await dispatch(request, createTuiAdapter(session), createCaptureWriter(session)); result.provenance = provenance; result.run_id = session.id; recordStep(session, result); }
      finally { await lease.release(); }
    } else {
      const lease = await acquireLease("desktop", { run_id: session.id });
      try { result = await dispatch(request, await createDesktopAdapter(session), createCaptureWriter(session)); result.provenance = provenance; result.run_id = session.id; recordStep(session, result); }
      finally { await lease.release(); }
    }
  return result;
}
