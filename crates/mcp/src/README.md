# MCP transport library

`pacer_server::mcp` is an opt-in stdio library for the M2 MCP port. It is not
registered as a native operation or selected by `pacer mcp`. TypeScript remains
the runtime entry point and behavioral reference.

The library owns the planner/grant tool catalogs, descriptions, input schemas,
validation and transforms, JSON-RPC stdio framing, and text/structured result
and error envelopes. `catalog.json` is a captured contract from the TypeScript
server, checked against the live reference and PR #587's goldens by
`test/mcp-parity.test.ts`. It contains no implementation or captured results.

## Host integration seam

Construct `McpServer::new(mode, version, backend)` and pass the server plus an
async buffered input and output to `run_stdio`. Requests run concurrently;
EOF drains pending calls. No process-global stdio or production filesystem is
opened by the library. Validation's delegate `base` refinement invokes
`git check-ref-format --branch` with an argument vector, matching TypeScript.

A `Backend` receives a tool name and validated arguments and returns the
structured domain value or error message. It must implement the existing tool
semantics, rather than assuming every tool is an API operation with the same
name or result shape. In particular, preserve task summarization, strategy
`activeOk`/`who`, executor delegation refusal, per-connection driving leases,
caller identity, and revision checks. `Mode::Grant` restricts the tool catalog;
it does not authorize calls. Its backend must use the authenticated scoped
service connection and preserve subtree/attempt authorization. The first runtime
integration must supply and live-validate these responsibilities.

JSON values at this boundary use a lossless encoding for JavaScript strings:
`parse_json` accepts raw JSON, including lone UTF-16 surrogates; `from_value`
encodes native Rust values; `stringify_json` writes boundary values. These
helpers escape genuine reserved Unicode scalars so they cannot collide with
surrogates. Use the helpers for direct `handle` requests/replies and backend
traffic, too. For backend requests containing unconstrained JSON,
`stringify_backend_json` preserves nonfinite numbers as numeric tokens rather
than converting them to null; `js_number` reads these numbers in native backends.
Ordinary serde serialization is not the boundary codec. Native
backend error strings can be encoded via `from_value(Value::String(message))`;
strings decoded by `parse_json` are already encoded.

Validation preserves Zod's code-point string limits, JavaScript whitespace
trimming and IEEE number semantics, including safe integers, signed overflow,
integer-valued exponent literals, defaults, unknown-key stripping, strict nested
objects and refinement/error order. Downstream domain checks retain their own
TypeScript semantics, including UTF-16 length checks. Nonfinite numeric tokens
are represented privately inside this codec; serde_json features and JSON parsing
in the existing transports are unchanged.

## Validation

- `cargo test -p pacer-server --test mcp --locked`
- `bun run test test/mcp-parity.test.ts test/mcp.test.ts`

The Rust `mcp_stdio` example is a parity driver, not a production backend. The
test fixture invokes real TypeScript domain handlers over a private temporary
socket, bypassing the TypeScript SDK's input validation and result formatting.
Thus a missing Rust validator or incorrect envelope cannot be hidden by a second
SDK pass. Success tests inject a runner so they cannot launch installed agents.
No captured result is replayed by the backend.

The supported transport methods are initialize, ping, tools/list and tools/call.
Tool contracts/results and the captured lifecycle cases are covered. Full SDK
extension behavior (tasks, progress, resources, prompts and all nested capability
metadata validation) is outside this library slice. It is not an SDK replacement
or an MCP default-server cutover.
