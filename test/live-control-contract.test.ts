import { describe, expect, test } from "bun:test";
import { parseResult, requestSchema, resolveElement, type SurfaceAdapter, type Target } from "../scripts/live/control/contract";
import { dispatch } from "../scripts/live/control/dispatch";

const target: Target = { id: "main", surface: "web", generation: "g1", capabilities: ["inspect", "click", "type", "capture"] };
const observation = { target, revision: "r1", elements: [{ ref: "e1", role: "button", name: "Save", actions: ["click"] }], truncated: false };
function adapter(): SurfaceAdapter {
  return {
    targets: async () => [target], inspect: async () => observation,
    act: async () => ({ delivery: "delivered" }),
    capture: async () => ({ method: "browser", bytes: new Uint8Array([1]), mime: "image/png", width: 1, height: 1, scale: 1 }),
    close: async () => {},
  };
}
const request = { command: "act", surface: "web", target: "main", action: { kind: "click", selector: { role: "button", name: "Save" } } } as const;

describe("live control contract", () => {
  test("rejects unsupported schema major but tolerates additive result fields", async () => {
    const result = await dispatch(request, adapter());
    expect(parseResult({ ...result, future: true }).schema_version).toBe(1);
    expect(() => parseResult({ ...result, schema_version: 2 })).toThrow("unsupported_schema");
  });
  test("validates bounded deadlines and rejects arbitrary actions", () => {
    expect(requestSchema.parse(request).timeout_ms).toBe(10000);
    expect(() => requestSchema.parse({ ...request, timeout_ms: 60001 })).toThrow();
    expect(() => requestSchema.parse({ ...request, action: { kind: "shell", text: "echo bad" } })).toThrow();
  });
  test("semantic selectors must resolve exactly one element", () => {
    expect(resolveElement(observation, { role: "button", name: "Save" }).ref).toBe("e1");
    expect(() => resolveElement(observation, { name: "Missing" })).toThrow("not_found");
    expect(() => resolveElement({ ...observation, elements: [...observation.elements, { ...observation.elements[0], ref: "e2" }] }, { name: "Save" })).toThrow("ambiguous");
    expect(() => resolveElement({ ...observation, truncated: true }, { name: "Missing" })).toThrow("inconclusive");
  });
  test("scoped selectors resolve duplicate labels in different navigation regions", () => {
    const scoped = { ...observation, elements: [
      { ...observation.elements[0], ancestors: [{ role: "navigation", name: "Settings sections" }] },
      { ...observation.elements[0], ref: "e2", ancestors: [{ role: "navigation", name: "Sidebar" }] },
    ] };
    expect(resolveElement(scoped, { role: "button", name: "Save", within: { role: "navigation", name: "Settings sections" } }).ref).toBe("e1");
  });
  test("stale reference refuses delivery", async () => {
    let calls = 0;
    const backend = adapter(); backend.act = async () => { calls++; return { delivery: "delivered" }; };
    const result = await dispatch({ ...request, action: { kind: "click", ref: "e1", revision: "old", generation: "g1" } }, backend);
    expect(result.error?.code).toBe("stale_reference");
    expect(calls).toBe(0);
  });
  test("capture failure retains delivered state and never repeats mutation", async () => {
    let calls = 0;
    const backend = adapter();
    backend.act = async () => { calls++; return { delivery: "delivered" }; };
    backend.capture = async () => { throw Error("capture offline"); };
    const result = await dispatch(request, backend);
    expect(result.delivery).toBe("delivered");
    expect(result.error?.code).toBe("capture_unavailable");
    expect(calls).toBe(1);
    expect(result.verdict).toBeUndefined();
  });
  test("Unicode multiline input reaches adapter unchanged", async () => {
    let text: string | undefined;
    const backend = adapter();
    backend.act = async (_target, action) => { text = action.text; return { delivery: "delivered" }; };
    const value = 'Tiếng Việt\n"quoted" `code` $(literal)';
    const result = await dispatch({ ...request, action: { kind: "type", text: value } }, backend);
    expect(result.delivery).toBe("delivered"); expect(text).toBe(value);
  });
  test("uncertain action failure still attempts capture exactly once", async () => {
    const backend = adapter(); let captures = 0;
    backend.act = async () => { throw Error("lost action acknowledgement"); };
    backend.capture = async () => { captures++; return { method: "terminal", bytes: new Uint8Array([1]), mime: "text/plain" }; };
    const result = await dispatch(request, backend);
    expect(result.delivery).toBe("unknown"); expect(captures).toBe(1);
  });
  test("unsupported capability is explicit", async () => {
    const result = await dispatch({ ...request, action: { kind: "resize", width: 500, height: 400 } }, adapter());
    expect(result.error?.code).toBe("unsupported_capability");
  });
});
