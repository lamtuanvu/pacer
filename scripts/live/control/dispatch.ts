import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ControlError, MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION, requestSchema, resolveElement, type Artifact, type CaptureResult, type ControlRequest, type ControlResult, type SurfaceAdapter, type Target } from "./contract";
import { evaluateCondition } from "./assertions";
export type SaveCapture = (capture: CaptureResult, target: Target, commandId: string) => Promise<Artifact>;
/** One action attempt. Delivery remains independent of observer/capture health. */
export async function dispatch(input: ControlRequest, adapter: SurfaceAdapter, save?: SaveCapture): Promise<ControlResult> {
  const result: ControlResult = {
    schema_version: 1, command_id: randomUUID(), command: input.command,
    started_at: new Date().toISOString(), finished_at: "", outcome: "ok", artifacts: [],
  };
  let request: z.output<typeof requestSchema> | undefined;
  try {
    request = requestSchema.parse(input);
    result.request = JSON.parse(JSON.stringify({ ...request, action: request.action ? { ...request.action, text: request.action.text === undefined ? undefined : "[redacted text input]", value: request.action.value === undefined ? undefined : "[redacted selected value]" } : undefined }));
    const targets = (await adapter.targets()).filter(target => target.surface === request!.surface);
    if (request.command === "targets") { result.targets = targets; return result; }
    const matches = targets.filter(target => target.id === request!.target);
    if (matches.length !== 1) throw new ControlError(matches.length ? "ambiguous" : "target_unavailable", "target must resolve exactly once");
    const target = result.target = matches[0];
    if (request.command === "act") {
      const action = { ...request.action! };
      result.delivery = "not_delivered";
      if (!target.capabilities.includes(action.kind)) throw new ControlError("unsupported_capability", action.kind);
      const before = result.observation = await adapter.inspect(target);
      if (action.selector) {
        const element = resolveElement(before, action.selector);
        action.ref = element.ref;
        action.revision = before.revision;
        action.generation = target.generation;
      }
      if (action.ref && (action.revision !== before.revision || action.generation !== target.generation || !before.elements.some(element => element.ref === action.ref))) {
        throw new ControlError("stale_reference", "inspect again before acting");
      }
      result.delivery = "unknown";
      result.delivery = (await adapter.act(target, action)).delivery;
      const current = (await adapter.targets()).find(candidate => candidate.id === target.id && candidate.surface === target.surface);
      if (!current) throw new ControlError("target_unavailable", "target closed after delivery");
      result.target = current;
      result.observation = await adapter.inspect(current);
      if (result.delivery !== "delivered") throw new ControlError("action_inconclusive", "action was not confirmed delivered");
    } else if (request.command === "inspect" || request.command === "doctor") {
      result.observation = await adapter.inspect(target);
    } else if (request.command === "wait" || request.command === "assert") {
      const deadline = Date.now() + request.timeout_ms;
      for (;;) {
        result.observation = await adapter.inspect(target);
        result.verdict = evaluateCondition(result.observation, request.condition!).verdict;
        if (result.verdict === "PASS" || request.command === "assert" || Date.now() >= deadline) break;
        await Bun.sleep(Math.min(100, Math.max(1, deadline - Date.now())));
      }
      if (result.verdict !== "PASS") {
        result.outcome = "error";
        result.error = {
          code: result.verdict === "UNVERIFIED" ? "inconclusive" : "assertion_failed",
          message: JSON.stringify({ expected: request.condition, revision: result.observation.revision }),
        };
      }
    }
  } catch (error) {
    result.outcome = "error";
    if (error instanceof ControlError && error.delivery) result.delivery = error.delivery;
    if (request?.command === "wait" || request?.command === "assert") result.verdict = "UNVERIFIED";
    result.error = {
      code: error instanceof ControlError ? error.code : error instanceof z.ZodError ? "invalid_input" : "observer_unavailable",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    const shouldCapture = result.target && request && (
      ["capture", "wait", "assert"].includes(request.command) || (request.command === "act" && result.delivery !== "not_delivered")
    );
    if (shouldCapture) {
      try {
        const capture = await adapter.capture(result.target!, request!.mode, result.command_id);
        if (capture.bytes.byteLength > MAX_IMAGE_BYTES || (capture.width ?? 0) > MAX_IMAGE_DIMENSION || (capture.height ?? 0) > MAX_IMAGE_DIMENSION) {
          throw new ControlError("capture_invalid", "capture exceeds limits");
        }
        if (capture.warnings) result.warnings = capture.warnings;
        if (save) result.artifacts.push(await save(capture, result.target!, result.command_id));
      } catch (error) {
        result.outcome = "error";
        result.error ??= { code: "capture_unavailable", message: String(error) };
        if (result.verdict === "PASS") result.verdict = "UNVERIFIED";
      }
    }
    result.finished_at = new Date().toISOString();
  }
  return result;
}
