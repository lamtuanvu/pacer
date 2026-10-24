import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CoreError, type CoreErrorCode } from "../src/core/errors";
import { httpStatus, rpcError, toApiError, type ApiErrorCode } from "../src/api/protocol";
import golden from "./fixtures/core-error-contract.json";

test("shared Rust error golden matches every TypeScript API code and projection", () => {
  const source = readFileSync(new URL("../src/core/errors.ts", import.meta.url), "utf8");
  const coreCodes = [...source.split("export type CoreErrorCode =")[1]!.split(";")[0]!.matchAll(/"([a-z_]+)"/g)].map(match => match[1]!);
  const protocol = readFileSync(new URL("../src/api/protocol.ts", import.meta.url), "utf8");
  const apiCodes = [...protocol.split("export type ApiErrorCode =")[1]!.split(";")[0]!.matchAll(/"([a-z_]+)"/g)].map(match => match[1]!);
  expect([...new Set(golden.map(row => row.code))].sort()).toEqual([...new Set([...coreCodes, ...apiCodes])].sort());
  for (const row of golden) {
    const error = new CoreError(row.code as CoreErrorCode, "contract message", row.hint ?? undefined, row.data ?? undefined);
    expect(httpStatus(row.code as ApiErrorCode)).toBe(row.status);
    expect({ error: toApiError(error) }).toEqual(row.body);
    expect(rpcError(error)).toEqual(row.rpc);
  }
  // Ordinary failures are internal at the API boundary, not invalid_input.
  expect(toApiError(new Error("broken"))).toEqual({ code: "internal", message: "broken" });
});
