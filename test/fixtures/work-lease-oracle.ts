/** Pure closure/schema reference, plus the invalid-blocker path that must not write. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { workerClosureProof } from "../../src/update/desktop/orca-proof";
import { beginWorkSync } from "../../src/update/desktop/admission";
import { CoreError } from "../../src/core/errors";
import type { Ctx } from "../../src/types";

interface Input {
  proofs?: Array<{ reply: Parameters<typeof workerClosureProof>[0]; dispatchId: string; terminal: string | null }>;
  uuids?: string[];
  emptyBlockerHome?: string;
}
const input = JSON.parse(await Bun.stdin.text()) as Input;
let emptyBlocker: { code: string; created: boolean } | undefined;
if (input.emptyBlockerHome) {
  let code = "accepted";
  try { beginWorkSync({ pacerHome: input.emptyBlockerHome } as Ctx, { kind: "session", id: "", label: "invalid" }); }
  catch (error) { code = error instanceof CoreError ? error.code : String(error); }
  emptyBlocker = { code, created: existsSync(join(input.emptyBlockerHome, "desktop-updates")) };
}
console.log(JSON.stringify({
  proofs: input.proofs?.map(row => workerClosureProof(row.reply, row.dispatchId, row.terminal)),
  uuids: input.uuids?.map(value => z.string().uuid().safeParse(value).success),
  emptyBlocker,
}));
