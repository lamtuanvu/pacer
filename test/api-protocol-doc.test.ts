import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderProtocolDoc } from "../scripts/protocol-doc";
import { helloBody } from "../src/api/protocol";
import { opNames } from "../src/api/ops";

test("docs/protocol.md is generated from the registry and up to date: run `bun run protocol:doc`", () => {
  const doc = renderProtocolDoc();
  for (const name of opNames()) expect(doc).toContain(`### \`${name}\``);
  expect(doc).toContain("2.8.0");
  expect(readFileSync(join(import.meta.dir, "..", "docs", "protocol.md"), "utf8")).toBe(doc);
});

test("2.2+ hello advertises attention, activity and repository operations", () => {
  const hello = helloBody();
  expect(hello.protocol).toBe("3.0.0");
  for (const op of ["attention.dismiss", "attention.snooze", "task.retry_options", "activity.list", "repo.list", "repo.add", "repo.remove"]) expect(hello.ops).toContain(op);
  for (const text of ["ui.open", "expect_rev", "POST /v3/session/exchange", "## Activity", "## Attention and actions"]) expect(renderProtocolDoc()).toContain(text);
});

for (const major of [3,2] as const) test(`protocol v${major} docs match the selected schemas and routes`,()=>{
 const doc=renderProtocolDoc(major),file=major===3?"protocol.md":"protocol-v2.md";
 expect(readFileSync(join(import.meta.dir,"..","docs",file),"utf8")).toBe(doc);
 expect(doc).toContain(`GET /v${major}/snapshot`);
 if(major===3){expect(doc).not.toContain("retain the legacy summary array");expect(doc).not.toContain("`budget`, `task`, `mode`, `alert`");}
 expect(doc).toContain(major===3?"3.0.0":"2.8.0");
 const schema=doc.split("### `task.review`")[1]!.split("###")[0]!;
 expect(schema).toContain(major===3?'"verdict"':'"accepted"');
});


test("desktop image transport and errors are documented only in v3", () => {
  const current = renderProtocolDoc(3), previous = renderProtocolDoc(2);
  for (const value of ["`not_found` | 404", "POST /v3/desktop/capture/<request_id>/image", "GET /v3/desktop/capture/<request_id>/image", "X-Pacer-Capture-Worker", "X-Pacer-Capture-Metadata", "128 MiB decoded", "desktop.capture.register"])
    expect(current).toContain(value);
  expect(previous).not.toContain("desktop.capture");
  expect(previous).not.toContain("X-Pacer-Capture");
});
