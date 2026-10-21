import { nativeServiceArgv } from "../../../src/update/desktop/native-service-argv";
import { nativeTransportSelfTest } from "../../../src/update/desktop/native-transport-test";
import { realpathSync } from "node:fs";
if (JSON.stringify(nativeServiceArgv()) !== JSON.stringify([realpathSync(process.execPath), "serve", "--port", "54321"]))
  throw Error("Compiled service argv mismatch");
const result = await nativeTransportSelfTest();
if (result.schema !== 1 || result.role !== "cli" || result.nativeTransportAbi !== 1 || result.transport !== "unix-audit-token" || result.verified !== true)
  throw Error("Invalid native smoke result");
console.log(JSON.stringify(result));
