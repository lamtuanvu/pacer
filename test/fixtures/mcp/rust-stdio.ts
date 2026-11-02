import { basename, dirname } from "node:path";
import { makeCtx } from "../../../src/ctx";
import pkg from "../../../package.json";
import { domainBackend } from "./rust-backend";

const binary = process.env.PACER_TEST_RUST_MCP;
if (!binary) throw new Error("PACER_TEST_RUST_MCP must name the opt-in Rust example");
const backend = await domainBackend(() => makeCtx());
try {
  const proc = Bun.spawn([binary, process.env.PACER_WORK_GRANT ? "grant" : "planner", pkg.version, basename(backend.path)], {
    cwd: dirname(backend.path), stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env,
  });
  process.exitCode = await proc.exited;
} finally { await backend.close(); }
