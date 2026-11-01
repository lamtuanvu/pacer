import { expect, test } from "bun:test";
import fixture from "./fixtures/api-error-contract.json";
import { errorContract } from "../scripts/api-error-contract";
import { CoreError } from "../src/core/errors";
import { callOp, opNames } from "../src/api/ops";
import { rpcError, toApiError } from "../src/api/errors";

test("generated API error fixture matches the live TypeScript contract", () => {
  expect(JSON.stringify(errorContract())).toBe(JSON.stringify(fixture));
});

test("unknown operation hint contains the sorted operation name union", async () => {
  expect(fixture.operations).toEqual(opNames());
  const error = await callOp({ env: {} } as Parameters<typeof callOp>[0], "missing.operation", {}).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CoreError);
  expect(toApiError(error)).toEqual({
    code: "unknown_op", message: 'unknown operation "missing.operation"', hint: `operations: ${fixture.operations.join(", ")}`,
  });
  expect(rpcError(error).code).toBe(-32601);
});

test("schema failures retain the invalid_input boundary code", async () => {
  const error = await callOp({ env: {} } as Parameters<typeof callOp>[0], "task.get", {}).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CoreError);
  expect(toApiError(error).code).toBe("invalid_input");
  expect(rpcError(error).code).toBe(-32602);
});
