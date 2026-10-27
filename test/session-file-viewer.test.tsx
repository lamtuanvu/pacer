import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToString } from "preact-render-to-string";
import {
  FileViewer, HtmlPreview, PAGE_LINES, PREVIEW_LIMIT_BYTES, describeFileError, fileGlyph, findMatches, formatSize,
  languageName, pageOfLine, parseReference, resolvePreviewReference, splitLines, viewerLayout,
} from "../app/src/screens/session/FileViewer";
import { INLINE_STYLES, blockedResources } from "../app/src/screens/session/preview-html";
import { renderMarkdownPreview, htmlPreviewDocument } from "../app/src/screens/session/preview";

const file = { path: "src/main.ts", kind: "code" as const, text: "first\nsecond\n", size: 13, modified: "v1", line: 2 };
const noop = () => {};

test("code viewer shows a selected line, header actions, search entry and return action", () => {
  const html = renderToString(<FileViewer file={{ ...file, column: 2 }} onClose={noop} onRefresh={noop} />);
  expect(html).toContain("src/main.ts");
  expect(html).toContain("Back to terminal");
  expect(html).toContain('aria-label="Search"');
  expect(html).toContain('aria-label="Copy path"');
  expect(html).toContain('aria-label="Refresh"');
  expect(html).toContain("Read-only");
  expect(html).toContain('<kbd class="pc-kbd">Esc</kbd>');
  expect(html).toContain("aria-current=\"location\"");
  expect(html).toContain("s<mark");
  expect(html).toContain("Column 2");
  expect(html).toContain("Line 2</span>");
  expect(html).toMatch(/<footer[^>]*>.*TypeScript.*0\.1 KB.*2 lines.*Ln 2.*<\/footer>/);
});

test("large source limits rendered lines and keeps a requested location visible", () => {
  const html = renderToString(<FileViewer file={{ ...file, text: Array.from({ length: 3000 }, (_, index) => `line ${index + 1}`).join("\n"), line: 2800 }} onClose={noop} onRefresh={noop} />);
  expect(html).toContain("Showing lines 2001–3000 of 3000; search covers the whole file");
  expect(html).toContain("pc-file-viewer__banner--warn");
  expect(html).toContain("Previous lines");
  expect(html).toContain("Next lines");
  expect(html).toContain("line 2800");
  expect(html).not.toContain("line 1</span>");
});

test("out-of-range line requests retain visible source", () => {
  const html = renderToString(<FileViewer file={{ ...file, line: 3000 }} onClose={noop} onRefresh={noop} />);
  expect(html).toContain("beyond the end of this file (2 lines)");
  expect(html).toContain("first");
});

test("Markdown and HTML open on Source; the preview runs only when picked", () => {
  for (const kind of ["html", "markdown"] as const) {
    const html = renderToString(<FileViewer file={{ ...file, path: kind === "html" ? "index.html" : "README.md", kind, text: "<h1>Hello</h1>" }} onClose={noop} onRefresh={noop} />);
    expect(html).toContain('role="tablist" aria-label="File view"');
    expect(html).toMatch(/role="tab" aria-selected="true"[^>]*>Source</);
    expect(html).toMatch(/role="tab" aria-selected="false"[^>]*>Preview</);
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain("Raw text with line numbers");
    expect(html).not.toContain("<iframe");
  }
  expect(renderToString(<FileViewer file={file} onClose={noop} onRefresh={noop} />)).not.toContain('role="tablist"');
});

test("HTML preview is sandboxed and names what it blocked", () => {
  const text = '<script src="https://cdn.example/app.js"></script><script>alert(1)</script><link rel="preconnect" href="https://fonts.example"><img src="logo.png"><h1>Hello</h1>';
  const html = renderToString(<HtmlPreview file={{ ...file, path: "index.html", kind: "html", text }} />);
  expect(html).toMatch(/<iframe[^>]*\ssandbox(?:\s|>|="")/);
  expect(html).toContain('role="note"');
  expect(html).toContain("Preview is isolated from pacer");
  expect(html).toContain("Scripts don't run, inline styles aren't applied and nothing loads from the network. 2 scripts and 1 external request were blocked.");
  expect(html).toMatch(/<iframe[^>]*tabindex="-1"/i);
  expect(html).toContain("inline script");
  expect(html).toContain("local asset not loaded");
  expect(htmlPreviewDocument("<script>alert(1)</script>")).toContain("default-src 'none'");
});

test("blocked-resource scanner covers scripts, links, media, frames and CSS", () => {
  const source = `<!-- <script src="https://commented.example/x.js"></script> -->
    <script src="https://cdn.example/a.js"></script><script src='//cdn.example/b.js'></script><script> let x = 1 </script><script></script>
    <script src="vendor/local.js"></script>
    <link rel="stylesheet" href="https://cdn.example/site.css"><link rel="preconnect" href="//fonts.example"><link rel="stylesheet" href="styles/site.css">
    <link rel="canonical" href="/about"><link rel="icon" href="https://cdn.example/favicon.ico">
    <img src="https://img.example/a.png"><img src="data:image/png;base64,AAAA"><img src="assets/b.png">
    <iframe src="https://embed.example/"></iframe><video><source src="https://media.example/v.mp4"></video>
    <style>@import url("https://fonts.example/f.css"); @import 'theme.css'; body{background:url(https://img.example/bg.png)} .a{background:url('#x')}</style>
    <div style="background-image:url(//img.example/inline.png)"></div>`;
  expect(blockedResources(source)).toEqual([
    { kind: "script", address: "https://cdn.example/a.js", local: false },
    { kind: "script", address: "//cdn.example/b.js", local: false },
    { kind: "script", address: "inline script", local: false },
    { kind: "script", address: "vendor/local.js", local: true },
    { kind: "style", address: "https://cdn.example/site.css", local: false },
    { kind: "connect", address: "//fonts.example", local: false },
    { kind: "style", address: "styles/site.css", local: true },
    { kind: "img", address: "https://cdn.example/favicon.ico", local: false },
    { kind: "img", address: "https://img.example/a.png", local: false },
    { kind: "img", address: "assets/b.png", local: true },
    { kind: "frame", address: "https://embed.example/", local: false },
    { kind: "img", address: "https://media.example/v.mp4", local: false },
    { kind: "style", address: "https://fonts.example/f.css", local: false },
    { kind: "style", address: "theme.css", local: true },
    { kind: "img", address: "https://img.example/bg.png", local: false },
    { kind: "img", address: "//img.example/inline.png", local: false },
    { kind: "style", address: INLINE_STYLES, local: false, inline: true },
  ]);
  expect(blockedResources("<h1>Plain</h1>")).toEqual([]);
});

test("blocked-resource scanner covers srcset, poster, audio, embed and object, and ignores src text inside other values", () => {
  const source = `<img srcset="https://img.example/a-1x.png 1x, img/a-2x.png 2x" alt="x src=https://fake.example/no.png">
    <picture><source srcset="https://img.example/wide.webp 800w"></picture>
    <video poster="https://img.example/poster.jpg" src="clips/v.mp4"></video><audio src="https://media.example/a.mp3"></audio>
    <embed src="https://embed.example/e.swf"><object data="docs/file.pdf"></object>
    <a title='data-src="https://fake.example/x" src=https://fake.example/y' href="#">x</a><p data-note="a > b src=https://fake.example/z">t</p>`;
  expect(blockedResources(source)).toEqual([
    { kind: "img", address: "https://img.example/a-1x.png", local: false },
    { kind: "img", address: "img/a-2x.png", local: true },
    { kind: "img", address: "https://img.example/wide.webp", local: false },
    { kind: "img", address: "clips/v.mp4", local: true },
    { kind: "img", address: "https://img.example/poster.jpg", local: false },
    { kind: "img", address: "https://media.example/a.mp3", local: false },
    { kind: "frame", address: "https://embed.example/e.swf", local: false },
    { kind: "frame", address: "docs/file.pdf", local: true },
  ]);
  expect(blockedResources('<p style="color:red">x</p>')).toEqual([{ kind: "style", address: INLINE_STYLES, local: false, inline: true }]);
});

test("server errors map to titled states with only actions that can work", () => {
  const path = "src/gone.ts";
  expect(describeFileError({ code: "not_found", message: "File no longer exists in this session workspace" }, path))
    .toEqual({ glyph: "missing", title: "This file isn't in the workspace", body: "src/gone.ts may have been moved, deleted or not written yet.", copy: true, retry: true });
  expect(describeFileError({ code: "not_allowed", message: "File is outside the session workspace" }, path))
    .toMatchObject({ title: "Outside this workspace", body: "pacer only opens files inside the session workspace.", copy: true, retry: false });
  expect(describeFileError({ code: "not_allowed", message: "Private Pacer state cannot be previewed" }, path))
    .toMatchObject({ title: "Can't open this file", body: "Private Pacer state cannot be previewed", copy: true, retry: false });
  expect(describeFileError({ code: "too_large", message: "File is too large to preview" }, path))
    .toMatchObject({ title: "Too large to preview", body: "pacer previews files up to 512 KB.", copy: true });
  for (const message of ["Binary files cannot be previewed", "File is not UTF-8 text"])
    expect(describeFileError({ code: "invalid_input", message }, path)).toMatchObject({ title: "pacer can't show this file", body: "It's a binary file or isn't UTF-8 text." });
  expect(describeFileError({ code: "conflict", message: "This session attempt has changed; refresh it" }, path))
    .toEqual({ glyph: "changed", title: "This session changed", body: "The agent's attempt moved on. Refresh the session.", copy: false, retry: false });
  expect(describeFileError({ code: "not_found", message: "Session workspace is unavailable" }, path))
    .toMatchObject({ title: "Workspace unavailable", body: "This session's workspace is no longer available; it may have been removed or cleaned up." });
  // Without a typed code (for example a proxy error), the message still selects the state.
  expect(describeFileError({ code: "internal", message: "File no longer exists in this session workspace" }, path).title).toBe("This file isn't in the workspace");
  expect(describeFileError({ code: "internal", message: "File is not UTF-8 text" }, path).title).toBe("pacer can't show this file");
});

test("the too-large copy uses the service's read limit", () => {
  const openat = readFileSync("src/session/openat.ts", "utf8");
  const match = /MAX_FILE_BYTES\s*=\s*(\d+)\s*\*\s*(\d+)/.exec(openat);
  expect(match).not.toBeNull();
  expect(Number(match![1]) * Number(match![2])).toBe(PREVIEW_LIMIT_BYTES);
});

test("errors keep the header and Back to terminal; Retry appears only for missing files", () => {
  const missing = renderToString(<FileViewer reference="src/gone.ts:4" error={{ code: "not_found", message: "File no longer exists in this session workspace" }} onClose={noop} onRefresh={noop} />);
  expect(missing).toContain("gone.ts");
  expect(missing).toContain("Back to terminal");
  expect(missing).toContain("This file isn't in the workspace");
  expect(missing).toContain(">Retry<");
  expect(missing).toContain(">Copy path<");
  expect(missing).toContain("Line 4");
  expect(missing).not.toContain('aria-label="Refresh"');
  const changed = renderToString(<FileViewer reference="src/a.ts" error={{ code: "conflict", message: "This session attempt has changed; refresh it" }} onClose={noop} onRefresh={noop} />);
  expect(changed).toContain("This session changed");
  expect(changed).toMatch(/role="group" aria-labelledby="([^"]+)"[\s\S]*id="\1"[^>]*>This session changed/);
  expect(changed).not.toMatch(/pc-file-viewer__state"[^>]*aria-live/);
  const binary = renderToString(<FileViewer reference="bin/app" error={{ code: "invalid_input", message: "Binary files cannot be previewed" }} onClose={noop} onRefresh={noop} />);
  expect(binary).toContain('class="pc-file-viewer__glyph">BIN</span>');
  expect(changed).not.toContain(">Retry<");
  expect(changed).not.toContain(">Copy path<");
});

test("loading shows the reference's name and path at once with a polite status", () => {
  const html = renderToString(<FileViewer reference="docs/guide.md:12:3" onClose={noop} onRefresh={noop} />);
  expect(html).toContain("<strong title=\"docs/guide.md\">guide.md</strong>");
  expect(html).toContain("Line 12");
  expect(html).toMatch(/role="status" aria-live="polite"[^>]*>Reading docs\/guide\.md…/);
  expect(html).toContain("Back to terminal");
  expect(html).not.toContain("pc-file-viewer__skeleton");
});

test("search counts every match across the file and pages follow the match", () => {
  const lines = ["Alpha alpha", "beta", "ALPHA"];
  expect(findMatches(lines, "alpha", false)).toEqual([{ line: 1, start: 0 }, { line: 1, start: 6 }, { line: 3, start: 0 }]);
  expect(findMatches(lines, "alpha", true)).toEqual([{ line: 1, start: 6 }]);
  expect(findMatches(lines, "", false)).toEqual([]);
  expect(findMatches(["aaaa"], "aa", false)).toEqual([{ line: 1, start: 0 }, { line: 1, start: 2 }]);
  // "İ" lower-cases to two code units; offsets must still point into the original line.
  const turkish = "İİ abc ABC";
  expect(findMatches([turkish], "abc", false)).toEqual([{ line: 1, start: 3 }, { line: 1, start: 7 }]);
  expect(turkish.slice(7, 10)).toBe("ABC");
  expect(pageOfLine(1)).toBe(0);
  expect(pageOfLine(PAGE_LINES)).toBe(0);
  expect(pageOfLine(PAGE_LINES + 1)).toBe(1);
});

test("file descriptors: glyph, language, size, lines, reference and layout", () => {
  expect(["a.ts", "a.md", "a.html", "a.css", "notes.txt", "Makefile", "data.xyz", "photo.png"].map(fileGlyph)).toEqual(["TS", "MD", "</>", "</>", "TXT", "TXT", "FILE", "FILE"]);
  expect(languageName("a.tsx")).toBe("TypeScript");
  expect(languageName("README")).toBe("Plain text");
  expect(formatSize(13)).toBe("0.1 KB");
  expect(formatSize(2048)).toBe("2.0 KB");
  expect(formatSize(3 * 1024 * 1024)).toBe("3.0 MB");
  expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
  expect(splitLines("")).toEqual([""]);
  expect(parseReference("src/a.ts:4:2")).toEqual({ path: "src/a.ts", line: 4, column: 2 });
  expect(parseReference("README.md")).toEqual({ path: "README.md" });
  expect([1440, 1100, 1099, 768, 767, 375].map(viewerLayout)).toEqual(["pane", "pane", "replace", "replace", "sheet", "sheet"]);
});

test("Markdown preview escapes raw HTML and restricts unsafe links", () => {
  const rendered = renderMarkdownPreview("# Title\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1)) [good](https://example.com)");
  expect(rendered).toContain("<h1>Title</h1>");
  expect(rendered).toContain("&lt;script&gt;");
  expect(rendered).not.toContain("href=\"javascript:");
  expect(rendered).toContain('class="pc-inline-link"');
  const image = renderMarkdownPreview('![Build graph](https://img.example/g.png "t")');
  expect(image).toContain('<span class="pc-file-viewer__image" title="https://img.example/g.png">Image not loaded: Build graph</span>');
  expect(image).not.toContain("<img");
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

test("the blocked-resource scanner ignores comments, including nested and unterminated ones", () => {
  expect(blockedResources('<!-<!-- x -->- <script src="https://a.example/x.js"></script> -->')).toEqual([]);
  expect(blockedResources('<img src="https://b.example/y.png"><!-- <script src="https://a.example/x.js"></script>')).toEqual([{ kind: "img", address: "https://b.example/y.png", local: false }]);
});
