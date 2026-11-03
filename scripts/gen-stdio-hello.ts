import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { helloBody } from "../src/api/protocol";
import { v2Hello } from "../src/api/v2-compat";

// Tracked generator for the deterministic stdio hello inventory. Regenerates
// crates/server/src/stdio_hello.json from the canonical TypeScript hello
// bodies (run: `bun gen:stdio-hello`). The static vector carries only the
// platform-agnostic inventory (protocol, previous, pacer, ops, events).
// coreBuild is a runtime property of the actual paired core and is omitted
// here; the Rust stdio front door obtains it from the running core at hello
// time (crates/server/src/stdio_proxy.rs). Kept in sync by
// test/stdio-transport-parity.test.ts, which fails on drift.
const { coreBuild: _coreBuild, ...inventory } = helloBody() as Record<string, unknown>;
const out = { v2: v2Hello(), v3: inventory };
const path = join(import.meta.dir, "..", "crates", "server", "src", "stdio_hello.json");
writeFileSync(path, JSON.stringify(out)); // compact, no trailing newline (matches existing)
console.log("wrote", path);