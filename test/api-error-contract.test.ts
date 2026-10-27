import { expect, test } from "bun:test";
import { CoreError } from "../src/core/errors";
import { httpStatus, rpcError, toApiError } from "../src/api/protocol";
import { apiErrorContract } from "./fixtures/api-error-contract";

test("every API error retains its HTTP and JSON-RPC mapping", () => {
  expect(Object.keys(apiErrorContract)).toHaveLength(14);
  for (const code of Object.keys(apiErrorContract) as Array<keyof typeof apiErrorContract>) {
    const expected = apiErrorContract[code];
    const error = code === "internal"
      ? new Error("failure")
      : new CoreError(code as Exclude<keyof typeof apiErrorContract, "internal">, "failure", "retry", { private: true });
    const api = toApiError(error);
    expect(api.code).toBe(code);
    expect(api.message).toBe("failure");
    expect(httpStatus(api.code)).toBe(expected.http);
    expect(rpcError(error)).toEqual({
      code: expected.rpc,
      message: "failure",
      data: code === "internal" ? { code } : { code, hint: "retry" },
    });
  }
});

test("the HTTP body retains operation data while JSON-RPC omits it", () => {
  const error = new CoreError("conflict", "stale revision", "refresh", { revision: 7 });
  expect(toApiError(error)).toEqual({ code: "conflict", message: "stale revision", hint: "refresh", data: { revision: 7 } });
  expect(rpcError(error)).toEqual({ code: -32000, message: "stale revision", data: { code: "conflict", hint: "refresh" } });
  expect(toApiError(new CoreError("conflict", "stale revision", ""))).toEqual({ code: "conflict", message: "stale revision" });
  expect(rpcError(new CoreError("conflict", "stale revision", ""))).toEqual({ code: -32000, message: "stale revision", data: { code: "conflict" } });
});
