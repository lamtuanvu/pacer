/** Bundled by test/desktop-update-bundle-identity.test.ts with and without a compiled fixture lease. */
import { DESKTOP_IDENTIFIERS } from "../../../src/update/desktop/bundle-identity";
import { nativeIdentifier } from "../../../src/update/desktop/native-os";
import { openDesktop } from "../../../src/commands/open";
import type { Ctx } from "../../../src/types";

const calls: string[][] = [];
const ctx = { run: async (argv: string[]) => { calls.push(argv); return { code: 0, stdout: "", stderr: "" }; } } as unknown as Ctx;
await openDesktop(ctx, "overview", "darwin");
console.log(JSON.stringify({ identifiers: DESKTOP_IDENTIFIERS, shim: nativeIdentifier("native-shim"), open: calls[0] }));
