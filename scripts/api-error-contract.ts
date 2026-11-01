import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { CoreError } from "../src/core/errors";
import { httpStatus, rpcError, toApiError, type ApiErrorCode } from "../src/api/errors";

const root = resolve(import.meta.dir, "..");
const source = readFileSync(resolve(root, "src/api/errors.ts"), "utf8");
const table = source.match(/const STATUS: Record<ApiErrorCode, number> = \{([\s\S]*?)\};/)?.[1];
if (!table) throw new Error("API status table not found");
const codes = [...table.matchAll(/\b([a-z][a-z_]+):\s*\d+/g)].map((match) => match[1] as ApiErrorCode);
if (codes.length !== 16 || new Set(codes).size !== codes.length) throw new Error("API error code set changed; inspect the contract before regenerating");

export const errorContract = () => ({
  codes: codes.sort().map((code) => {
    const error = code === "internal" ? new Error(`sample ${code}`) : new CoreError(code, `sample ${code}`);
    return { code, http: httpStatus(code), rpc: rpcError(error).code };
  }),
  samples: [
    new CoreError("conflict", "sample conflict", "", {}),
    new CoreError("conflict", "sample conflict", "retry", { expected: 1 }),
  ].map((error) => ({ body: { error: toApiError(error) }, rpc: rpcError(error) })),
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(resolve(root, "test/fixtures/api-error-contract.json"), `${JSON.stringify(errorContract(), null, 2)}\n`);
}
