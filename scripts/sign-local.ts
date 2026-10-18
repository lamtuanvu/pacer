#!/usr/bin/env bun
import { createIdentity, signLocal } from "../src/update/signing";
export * from "../src/update/signing";

if (import.meta.main && process.platform === "darwin") {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1) throw Error("usage: bun scripts/sign-local.ts <binary> | --create-identity");
    if (args[0] === "--create-identity") await createIdentity();
    else if (args[0].startsWith("--")) throw Error(`unknown option: ${args[0]}`);
    // A build still succeeds unsigned; the hint explains the removable-volume prompt.
    else await signLocal(args[0]).catch(e => console.warn(`pacer: left ${args[0]} ad hoc signed: ${e instanceof Error ? e.message : String(e)}`));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
