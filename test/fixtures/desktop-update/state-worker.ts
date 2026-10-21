import { readFileSync, writeFileSync } from "node:fs";
import { readUpdate, writeUpdate } from "../../../src/update/desktop/store";
import { CoreError } from "../../../src/core/errors";
import type { Ctx } from "../../../src/types";

const [home, gate, marker, mode, id = "desktop-fixture"] = process.argv.slice(2) as string[];
const ctx = { pacerHome: home } as Ctx;
const record = readUpdate(ctx, id!);
if (mode === "read") {
  console.log(JSON.stringify(record));
} else {
  writeFileSync(marker!, "ready");
  while (true) {
    try { readFileSync(gate!); break; } catch { await Bun.sleep(2); }
  }
  try {
    console.log(JSON.stringify({ revision: writeUpdate(ctx, { ...record, autoDownload: false }, record.revision).revision }));
  } catch (error) {
    if (!(error instanceof CoreError)) throw error;
    console.log(JSON.stringify({ code: error.code }));
  }
}
