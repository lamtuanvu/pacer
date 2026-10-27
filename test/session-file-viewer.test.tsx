import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { FileViewer, resolvePreviewReference } from "../app/src/screens/session/FileViewer";
import { renderMarkdownPreview, htmlPreviewDocument } from "../app/src/screens/session/preview";

const file = { path: "src/main.ts", kind: "code" as const, text: "first\nsecond\n", size: 13, modified: "v1", line: 2 };

test("code viewer shows a selected line, search, and return action", () => {
  const html = renderToString(<FileViewer file={{ ...file, column: 2 }} onClose={() => {}} onRefresh={() => {}} />);
  expect(html).toContain("src/main.ts");
  expect(html).toContain("Back to terminal");
  expect(html).toContain("Search file");
  expect(html).toContain("aria-current=\"location\"");
  expect(html).toContain("s<mark");
  expect(html).toContain("Column 2");
});

test("large source limits rendered lines and keeps a requested location visible", () => {
  const html = renderToString(<FileViewer file={{ ...file, text: Array.from({ length: 3000 }, (_, index) => `line ${index + 1}`).join("\n"), line: 2800 }} onClose={() => {}} onRefresh={() => {}} />);
  expect(html).toContain("Showing lines");
  expect(html).toContain("Previous lines");
  expect(html).toContain("Next lines");
  expect(html).toContain("line 2800");
  expect(html).not.toContain("line 1</span>");
});

test("out-of-range line requests retain visible source", () => {
  const html = renderToString(<FileViewer file={{ ...file, line: 3000 }} onClose={() => {}} onRefresh={() => {}} />);
  expect(html).toContain("beyond the end of this file");
  expect(html).toContain("first");
});

test("HTML preview is sandboxed and source remains available", () => {
  const html = renderToString(<FileViewer file={{ ...file, path: "index.html", kind: "html", text: "<h1>Hello</h1>" }} onClose={() => {}} onRefresh={() => {}} />);
  expect(html).toMatch(/<iframe[^>]*\ssandbox(?:\s|>)/);
  expect(html).toContain("Source");
  expect(html).toContain("Preview");
  expect(html).toContain("HTML preview blocks scripts");
  expect(htmlPreviewDocument("<script>alert(1)</script>")).toContain("default-src 'none'");
});

test("Markdown preview escapes raw HTML and restricts unsafe links", () => {
  const rendered = renderMarkdownPreview("# Title\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1)) [good](https://example.com)");
  expect(rendered).toContain("<h1>Title</h1>");
  expect(rendered).toContain("&lt;script&gt;");
  expect(rendered).not.toContain("href=\"javascript:");
  expect(rendered).toContain('class="pc-inline-link"');
});

test("Markdown file links resolve from the viewed document and ignore fragments and schemes", () => {
  expect(resolvePreviewReference("docs/guide/README.md", "../api.md#usage"))
    .toBe("docs/guide/../api.md");
  expect(resolvePreviewReference("docs/guide/README.md", "my%20file.md:8"))
    .toBe("docs/guide/my file.md:8");
  expect(resolvePreviewReference("docs/guide/README.md", "README.md:3"))
    .toBe("docs/guide/README.md:3");
  expect(resolvePreviewReference("docs/guide/README.md", "#usage")).toBeNull();
  expect(resolvePreviewReference("docs/guide/README.md", "//example.com/a.md")).toBeNull();
  expect(resolvePreviewReference("docs/guide/README.md", "javascript:alert(1)")).toBeNull();
});
