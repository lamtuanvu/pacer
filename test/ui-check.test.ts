import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkUiSource, checkUiTree } from "../scripts/ui-check";

// Removing each guard below must make a representative consumer violation pass.
describe("UI source policy", () => {
  test.each(["screens/Screen.tsx", "shell/Rail.tsx", "tray/Tray.tsx", "term/term.tsx", "new-area/Form.tsx"])("checks controls in %s", (file) => {
    for (const tag of ["button", "input", "select", "textarea", "details"]) {
      const source = `export const Control = () => <${tag} className="pc-btn" />;`;
      expect(checkUiSource(`app/src/${file}`, source).some(v => v.rule === "UI-19")).toBe(true);
    }
  });

  test("checks anchors and reports actionable source locations", () => {
    const [failure] = checkUiSource("app/src/tray/Tray.tsx", "// comment\nconst Link = () => <a href='/'>Go</a>;");
    expect(failure).toMatchObject({ path: "app/src/tray/Tray.tsx", line: 2, rule: "UI-19" });
    expect(failure!.message).toContain("Link");
    for (const name of ["pc-inline-link", "pc-text-action", "pc-btn"]) {
      expect(checkUiSource("app/src/screens/Help.tsx", `<a className="${name}" href='/'>Help</a>`)).toEqual([]);
    }
    expect(checkUiSource("app/src/screens/Help.tsx", '<a className="pc-btn-fake" />')).not.toEqual([]);
    expect(checkUiSource("app/src/screens/Help.tsx", '<a className={classes} />')).not.toEqual([]);
  });

  test.each([
    "font:13px/19px var(--font-sans)", "font:600 var(--type-body-size) var(--font-sans)",
    "font-size:12px", "font-weight:650", "line-height:1.6", "letter-spacing:.02em",
    "color:red", "background:#fff", "border:1px solid rgb(0 0 0 / .4)",
    "padding:10px", "margin:var(--space-2) 3px", "gap:.5rem", "border-radius:4px",
    "padding:var(--space-2, 9px)", "--custom-space:9px", "--custom-color:rebeccapurple",
    "box-shadow:0 3px 9px var(--line)", "min-height:44px", "transition:color 150ms",
  ])("rejects visual token bypass %s", declaration => {
    expect(checkUiSource("app/src/tray/tray.css", `.control { ${declaration}; }`).some(v => v.rule === "UI-21")).toBe(true);
    expect(checkUiSource("app/src/ds/components.css", `.control { ${declaration}; }`).some(v => v.rule === "UI-21")).toBe(true);
  });

  test("permits tokens and narrow layout, hairline, SVG and breakpoint categories", () => {
    expect(checkUiSource("app/src/screen.css", `
      @media(max-width:767px) { .layout { display:grid; grid-template-columns:minmax(0,1fr) 25%; width:100%; min-width:0; height:100vh; flex:1; order:-1;
        gap:var(--space-2); padding:0 var(--space-3); font:inherit; font-size:var(--type-body-size); font-weight:var(--type-body-weight);
        border:1px solid var(--line); border-radius:50%; color:inherit; background:transparent; line-height:normal;
        opacity:.5; transform:rotate(45deg); } }
    `)).toEqual([]);
    expect(checkUiSource("app/src/ds/Control.tsx", 'const B = () => <button style={{ padding: "var(--space-2)" }}><svg width={20} viewBox="0 0 20 20"><path d="M 0 0 L 20 20" /></svg></button>')).toEqual([]);
    expect(checkUiSource("app/src/ds/components.css", '.meter { width:calc(var(--used) * 1%); }')).toEqual([]);
  });

  test("routed screen roots cannot recreate page containment", () => {
    for (const declaration of ["max-width:var(--size-960)", "margin-inline:auto", "padding:var(--space-6)"]) {
      expect(checkUiSource("app/src/screens/probe.css", `.pc-overview { ${declaration}; }`).some(v => v.rule === "UI-25")).toBe(true);
    }
    expect(checkUiSource("app/src/screens/probe.css", ".pc-overview__cols { padding:var(--space-3); }")).toEqual([]);
    expect(checkUiSource("app/src/screens/probe.css", ".u3-settings:not(.pc-page) { padding:var(--space-3); }")).toEqual([]);
  });

  test.each([
    'style={{ fontSize: "12px" }}', 'style={{ fontWeight: 600 }}', 'style={{ color: "red" }}',
    'style={{ padding: 10 }}', 'style={{ "--custom": "#fff" }}', 'style="font:12px sans-serif"',
    'style={{ fontSize: `${size}px` }}', 'style={{ color: value }}', 'style={{ ...visuals }}',
  ])("rejects inline style bypass %s", attrs => {
    expect(checkUiSource("app/src/term/term.tsx", `const Text = () => <span ${attrs} />`).some(v => v.rule === "UI-21")).toBe(true);
  });

  test("checks named style objects and DOM styles, not only JSX attributes", () => {
    for (const source of [
      'const style = { fontSize: "12px" }; const Text = () => <span style={style} />;',
      'const s = {}; mount.style.color = "red";',
      'mount.style.setProperty("--my-color", "#fff");',
      'mount.setAttribute("style", "padding:10px");',
    ]) expect(checkUiSource("app/src/term/term.tsx", source)).not.toEqual([]);
  });

  test("ignores comments and unrelated domain literals", () => {
    expect(checkUiSource("app/src/screens/Code.tsx", '// <button /> color:red\nconst text = "<button />"; const data = { color: "red", padding: 10 }; <pre>{text}</pre>')).toEqual([]);
  });

  test.each([
    'import { NarrowContext } from "../shell/context";',
    'export { Thing } from "../screens/Thing";',
    'const api = import("../data/api");',
    'const api = require("../../../src/core/config");',
    'import { Thing } from "../ds/../shell/context";',
  ])("rejects reverse imports %s", source => {
    expect(checkUiSource("app/src/ds/Button.tsx", source).some(v => v.rule === "UI-20")).toBe(true);
  });

  test("permits Preact, DS and shared view model imports", () => {
    expect(checkUiSource("app/src/ds/Button.tsx", 'import { h } from "preact"; import { useState } from "preact/hooks"; import { taskStatus } from "../../../src/view-model/words"; import { Icon } from "./icons";')).toEqual([]);
  });

  test("generated ownership is exact, not inferred from a filename or comment", () => {
    expect(checkUiSource("app/src/ds/tokens.css", ':root { --ink:#fff; }')).toEqual([]);
    expect(checkUiSource("app/src/ds/tokens.ts", 'export const color = "#fff";')).toEqual([]);
    expect(checkUiSource("app/src/tray/tokens.css", '/* Generated */ .control { color:#fff; }')).not.toEqual([]);
    expect(checkUiSource("app/src/other.generated.css", '.control { padding:5px; }')).not.toEqual([]);
  });

  test("rejects digit-bearing custom property and font/color vendor bypasses", () => {
    for (const declaration of ["--space1:12px", "--color2:red", "--weight:bold", "--weight:normal", "-webkit-text-fill-color:red", "-webkit-font-size:13px"]) {
      expect(checkUiSource("app/src/tray/tray.css", `.control { ${declaration} }`)).not.toEqual([]);
    }
  });

  test("does not allow a spread to override a canonical anchor class", () => {
    expect(checkUiSource("app/src/screens/Links.tsx", '<a className="pc-btn" {...props}>Go</a>')).not.toEqual([]);
    expect(checkUiSource("app/src/screens/Links.tsx", '<a {...props} className="pc-btn">Go</a>')).toEqual([]);
  });

  test("DS type imports and CSS imports obey the same dependency direction", () => {
    for (const source of [
      'type Consumer = import("../screens/Consumer").Consumer;',
      'import Consumer = require("../screens/Consumer");',
    ]) expect(checkUiSource("app/src/ds/Button.tsx", source).some(v => v.rule === "UI-20")).toBe(true);
    expect(checkUiSource("app/src/ds/components.css", '@import "../screens/consumer.css";').some(v => v.rule === "UI-20")).toBe(true);
  });

  test("rejects raw controls created through h/createElement and injected style elements", () => {
    for (const source of [
      'import {h} from "preact"; const X = () => h("button", {});',
      'const X = document.createElement("input");',
      'const X = () => <style>{".foo{padding:12px}"}</style>;',
    ]) expect(checkUiSource("app/src/term/term.tsx", source)).not.toEqual([]);
  });

  test.each([
    'import {h} from "preact"; const X = h("div", {style:{color:"red",padding:"12px"}});',
    'import {h as make} from "preact"; const p = {style:{color:"red"}}; const X = make("div", p);',
    'const X = () => <span {...{style:{color:"red",padding:"12px"}}} />;',
    'const p = {style:{color:"red"}}; const X = () => <span {...p} />;',
    'const p = {style:runtimeStyle}; const X = () => <span {...p} />;',
    'const p = {style:runtimeStyle}; const X = h("div", p);',
    'mount.style.cssText = "color:red;padding:12px";',
    'mount.style[key] = "red";',
    'mount.style["color"] = "red";',
    'const key = "color"; mount.style[key] = "red";',
  ])("G1 rejects alternate style channel %s", source => {
    expect(checkUiSource("app/src/screens/Probe.tsx", source).some(v => v.rule === "UI-21")).toBe(true);
  });
  test("G1 accepts token props and native forwarding without scanning domain objects", () => {
    for (const source of [
      'const X = h("div", {style:{color:"var(--ink)",padding:"var(--space-2)"}});',
      'const p = {id:"x",style:{color:"var(--ink)"}}; const X = () => <span {...p} />;',
      'const p = {id:"x",title:"Title"}; const X = () => <span {...p} />;',
      'const data = {color:"red", padding:"12px"}; const X = () => <pre>{data.color}</pre>;',
      'mount.style.cssText = "color:var(--ink);padding:var(--space-2)";',
      'const key = "color"; mount.style[key] = "var(--ink)";',
      'mount.style["color"] = "var(--ink)";',
    ]) expect(checkUiSource("app/src/screens/Probe.tsx", source)).toEqual([]);
    expect(checkUiSource("app/src/ds/Control.tsx", 'const Control = ({label,...props}) => <button {...props}>{label}</button>;')).toEqual([]);
  });

  test("G2 decodes escaped properties without interpreting selector or string escapes as declarations", () => {
    for (const source of [String.raw`.x { c\6flor:red; }`, String.raw`.x { font\2d size:12px; }`]) {
      expect(checkUiSource("app/src/tray/tray.css", source).some(v => v.rule === "UI-21")).toBe(true);
    }
    expect(checkUiSource("app/src/tray/tray.css", String.raw`.c\6flor:hover { color:var(--ink); content:"font\2d size:12px"; }`)).toEqual([]);
    expect(checkUiSource("app/src/tray/tray.css", String.raw`.x { c\6flor:var(--ink); font\2d size:var(--type-body-size); }`)).toEqual([]);
  });

  test("G3 logical dimensions and stroke keywords require tokens", () => {
    for (const property of ["inline-size", "block-size", "min-inline-size", "max-inline-size", "min-block-size", "max-block-size"]) {
      expect(checkUiSource("app/src/tray/tray.css", `.x { ${property}:44px; }`)).not.toEqual([]);
      expect(checkUiSource("app/src/tray/Tray.tsx", `const X = () => <span style={{ "${property}":"44px" }} />`)).not.toEqual([]);
      expect(checkUiSource("app/src/tray/tray.css", `.x { ${property}:var(--size-control); }`)).toEqual([]);
      expect(checkUiSource("app/src/tray/tray.css", `.x { ${property}:100%; }`)).toEqual([]);
    }
    for (const property of ["border", "border-inline", "border-block-start", "border-width", "outline", "outline-width", "text-stroke-width", "stroke-width"]) {
      for (const width of ["thin", "medium", "thick"]) {
        expect(checkUiSource("app/src/tray/tray.css", `.x { ${property}:${width} solid var(--line); }`)).not.toEqual([]);
        expect(checkUiSource("app/src/tray/Tray.tsx", `const X = () => <span style={{ "${property}":"${width}" }} />`)).not.toEqual([]);
      }
    }
    expect(checkUiSource("app/src/tray/tray.css", '.x { border-inline:1px solid var(--line); border-block-start:var(--stroke) solid currentColor; inline-size:100vw; }')).toEqual([]);
  });

  test("G4 checks every CSS import form and ignores import-like comments/strings", () => {
    for (const wrap of [(path:string) => `"${path}"`, (path:string) => `url("${path}")`, (path:string) => `url('${path}')`, (path:string) => `url(${path})`]) {
      for (const path of ["../screens/probe.css", "https://example.invalid/style.css", "//example.invalid/style.css", "var(--sheet)"]) {
        expect(checkUiSource("app/src/ds/probe.css", `@import ${wrap(path)};`).some(v => v.rule === "UI-20")).toBe(true);
      }
      expect(checkUiSource("app/src/ds/probe.css", `@import ${wrap("./components.css")};`)).toEqual([]);
    }
    expect(checkUiSource("app/src/ds/probe.css", '@import "./components.css"; @import url(../screens/probe.css);').some(v => v.rule === "UI-20")).toBe(true);
    expect(checkUiSource("app/src/ds/probe.css", '/* @import url(../screens/probe.css); */ .x { content:"@import url(../screens/probe.css);"; }')).toEqual([]);
  });

  test("keeps negative fixtures executable and valid layout fixtures passing", () => {
    for (const [fixture, path, rules] of [
      ["raw-terminal.tsx.fixture", "app/src/term/term.tsx", ["UI-19"]],
      ["tray-font.css.fixture", "app/src/tray/tray.css", ["UI-21", "UI-21"]],
      ["reverse-import.tsx.fixture", "app/src/ds/Button.tsx", ["UI-20", "UI-20"]],
      ["valid-layout.css.fixture", "app/src/screens/layout.css", []],
    ] as const) {
      expect(checkUiSource(path, readFileSync(new URL(`./fixtures/ui-check/${fixture}`, import.meta.url), "utf8")).map(v => v.rule)).toEqual([...rules]);
    }
  });

  test("allows only the parameter-derived brand geometry channels", () => {
    for (const [path, metric] of [["app/src/ds/AgentMark.tsx", "--agent-size"], ["app/src/ds/Mark.tsx", "--mark-size"]]) {
      expect(checkUiSource(path!, `const Mark = () => <span style={{ "${metric}": \`\$\{size\}px\` }} />`)).toEqual([]);
      expect(checkUiSource(path!, `const Mark = () => <span style={{ "${metric}": "red" }} />`)).not.toEqual([]);
      expect(checkUiSource("app/src/screens/Mark.tsx", `const Mark = () => <span style={{ "${metric}": \`\$\{size\}px\` }} />`)).not.toEqual([]);
      expect(checkUiSource(path!, `const Mark = () => <span style={{ color: \`\$\{size\}px\` }} />`)).not.toEqual([]);
    }
  });

  test("allows only terminal scale width/height computed from PTY or measured screen geometry", () => {
    const width = '`${screen.offsetWidth}px`';
    const source = `const scale = () => { mount.current.style.width = ${width}; };`;
    expect(checkUiSource("app/src/term/term.tsx", source)).toEqual([]);
    for (const bad of [
      source.replace("const scale", "const paint"),
      source.replace("style.width", "style.fontSize"),
      source.replace("screen.offsetWidth", "arbitrary"),
      source.replace(width, '"44px"'),
    ]) expect(checkUiSource("app/src/term/term.tsx", bad)).not.toEqual([]);
    expect(checkUiSource("app/src/screens/term.tsx", source)).not.toEqual([]);
  });

  test("scans every authored subtree in stable order and excludes fixtures outside app", () => {
    const root = mkdtempSync(join(tmpdir(), "pacer-ui-check-"));
    try {
      for (const file of ["app/src/term/term.tsx", "app/src/tray/Tray.tsx", "app/src/new/Control.tsx", "test/fixtures/bad.tsx"]) {
        mkdirSync(join(root, file, ".."), { recursive: true });
        writeFileSync(join(root, file), 'const Control = () => <input />;');
      }
      const result = checkUiTree(root);
      expect(result.map(v => v.path)).toEqual(["app/src/new/Control.tsx", "app/src/term/term.tsx", "app/src/tray/Tray.tsx"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

test('shared spacing cannot be overridden in consumer styles, even with tokens', () => {
 for (const selector of ['.pc-detail-navigation', '.pc-stack', '.pc-stack--section', '.pc-page-body > p', '.custom .pc-page-header', '.pc-disclosure-panel > summary', '.pc-section']) {
  expect(checkUiSource('app/src/screens/example.css', `${selector}{margin-block:var(--space-3)}`).some(v=>v.rule==='UI-27')).toBe(true);
 }
 expect(checkUiSource('app/src/ds/components.css', '.pc-stack{gap:var(--space-3)}')).toEqual([]);
 expect(checkUiSource('app/src/screens/example.css', '.custom-grid{display:grid;gap:var(--space-3)}')).toEqual([]);
});

test('spacing ownership follows nested selectors, media blocks and legacy gap aliases', () => {
 for (const source of [
  '.pc-stack { & { gap:var(--space-6) } }',
  '.pc-stack { @media(min-width:900px) { padding:var(--space-3) } }',
  '.custom { .pc-stack { grid-row-gap:var(--space-6) } }',
  '.pc-stack { grid-gap:var(--space-6) }',
 ]) expect(checkUiSource('app/src/example.css', source).some(v=>v.rule==='UI-27')).toBe(true);
 expect(checkUiSource('app/src/example.css', '.custom { @media(min-width:900px) { gap:var(--space-3) } }')).toEqual([]);
});

test("assistant conic mark exception rejects neighboring selectors, colors, files and gradients", () => {
  const path = "app/src/ds/components.css";
  const mark = ".pc-aurora-avatar{background:conic-gradient(from 200deg,var(--aurora-1),var(--aurora-3),var(--aurora-2),var(--aurora-1))}";
  expect(checkUiSource(path, mark)).toEqual([]);
  for (const source of [mark.replace(".pc-aurora-avatar", ".other"), mark.replace("var(--aurora-1)", "red"), mark.replace("200deg", "100deg"), ".other " + mark, mark.replace(".pc-aurora-avatar", ".other,.pc-aurora-avatar")]) expect(checkUiSource(path, source)).not.toEqual([]);
  expect(checkUiSource("app/src/shell/other.css", mark)).not.toEqual([]);
});
test("only the frame's header offset accepts measured top-bar height", () => {
  const source = 'root.style.setProperty("--pc-frame-header-height", `${topBar?.getBoundingClientRect().height ?? 0}px`);';
  expect(checkUiSource("app/src/shell/AppFrame.tsx", source)).toEqual([]);
  expect(checkUiSource("app/src/screens/workspace/Workspace.tsx", source)).not.toEqual([]);
  for (const bad of [source.replace("--pc-frame-header-height", "height"), source.replace(".height", ".width"), source.replace("?? 0", "?? 20"), source.replace("root.style", "other.style"), source.replace("topBar?", "input?")]) {
    expect(checkUiSource("app/src/shell/AppFrame.tsx", bad)).not.toEqual([]);
  }
});

test("only the frame's assistant offset accepts measured dock height", () => {
  const source = 'root.style.setProperty("--pc-dock-height", `${dock?.getBoundingClientRect().height ?? 0}px`);';
  expect(checkUiSource("app/src/shell/AppFrame.tsx", source)).toEqual([]);
  for (const bad of [source.replace("--pc-dock-height", "height"), source.replace(".height", ".width"), source.replace("?? 0", "?? 20"), source.replace("root.style", "other.style")]) expect(checkUiSource("app/src/shell/AppFrame.tsx", bad)).not.toEqual([]);
  expect(checkUiSource("app/src/shell/Other.tsx", source)).not.toEqual([]);
});

test("assistant header clearance is a scoped measured geometry channel", () => {
  const source = 'root.style.setProperty("--pc-assistant-header-height", `${sessionHeader && body ? Math.max(0, sessionHeader.getBoundingClientRect().bottom - body.getBoundingClientRect().top) : 0}px`);';
  expect(checkUiSource("app/src/shell/AppFrame.tsx", source)).toEqual([]);
  expect(checkUiSource("app/src/screens/session/TasksPage.tsx", source)).not.toEqual([]);
  for (const bad of [source.replace("sessionHeader && body ? Math.max(0, sessionHeader.getBoundingClientRect().bottom - body.getBoundingClientRect().top) : 0", "clearance"), source.replace("Math.max(0,", "Math.max(20,"), 'const clearance = input; root.style.setProperty("--pc-assistant-header-height", `${clearance}px`);', 'const clearance = 20; root.style.setProperty("--pc-assistant-header-height", `${clearance}px`);']) {
    expect(checkUiSource("app/src/shell/AppFrame.tsx", bad)).not.toEqual([]);
  }
});

test('panel resize geometry allows only its bounded width channel, not neighboring styles',()=>{
 const path='app/src/ds/SidePanel.tsx';
 expect(checkUiSource(path,'panelElement.current.style.setProperty("--pc-panel-width",String(width));')).toEqual([]);
 for(const source of ['panelElement.current.style.setProperty("--other-width",String(width));','panelElement.current.style.width = `${width}px`;','panelElement.current.style.setProperty("--pc-panel-width", "272px");'])expect(checkUiSource(path,source)).not.toEqual([]);
 expect(checkUiSource('app/src/screens/Other.tsx','panelElement.current.style.setProperty("--pc-panel-width",String(width));')).not.toEqual([]);
});

test("anchored menu permits only its measured viewport assignments", () => {
  const path = "app/src/ds/useAnchoredMenu.ts";
  const metrics = [
    ['maxHeight', 'Math.max(0, height)'],
    ['left', 'Math.max(gutter, Math.min(rect.right - element.offsetWidth, viewport.clientWidth - element.offsetWidth - gutter))'],
    ['top', 'down ? rect.bottom : rect.top - element.offsetHeight'],
  ];
  for (const [property, metric] of metrics) {
    const source = 'element.style.' + property + ' = `${' + metric + '}px`;';
    expect(checkUiSource(path, source)).toEqual([]);
    expect(checkUiSource('app/src/ds/Other.ts', source)).not.toEqual([]);
    expect(checkUiSource(path, source.replace(metric!, metric + ' + 8'))).not.toEqual([]);
    expect(checkUiSource(path, source.replace(property!, 'padding'))).not.toEqual([]);
    expect(checkUiSource(path, source.replace('element.style', 'neighbor.style'))).not.toEqual([]);
  }
});

test("frame scroll clearance permits only measured work-header height", () => {
  const source = 'root.style.setProperty("--pc-work-header-height", `${workHeader?.getBoundingClientRect().height ?? 0}px`);';
  expect(checkUiSource("app/src/shell/AppFrame.tsx", source)).toEqual([]);
  for (const bad of [source.replace("--pc-work-header-height", "height"), source.replace(".height", ".width"), source.replace("?? 0", "?? 20"), source.replace("root.style", "other.style")]) expect(checkUiSource("app/src/shell/AppFrame.tsx", bad)).not.toEqual([]);
});
