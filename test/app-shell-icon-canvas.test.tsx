import {expect,test} from "bun:test";
import {renderToString} from "preact-render-to-string";
import {Icon,type IconName} from "../app/src/ds/icons";
const shapes = (html:string) => [...html.matchAll(/<(path|circle|rect)\b[^>]*>/g)].map(match=>match[0].replace(/\s*\/>$/,">"));
const icon = (name:IconName) => renderToString(<Icon name={name}/>);

test("activity icons match the canvas with the adopted Workspace replacement",async()=>{
 const board = await Bun.file("docs/design/project/ActivityBar.dc.html").text();
 const names: Record<string,IconName> = {dispatch:"activity-dispatch",needs:"needs-you",tasks:"task-checklist",insights:"activity-insights",terminal:"activity-terminal"};
 for (const match of board.matchAll(/id: '([^']+)'[^\n]+d: '([^']+)'/g)) {
  const html=icon(names[match[1]!]!);
  expect(html).toContain(`d="${match[1] === "terminal" ? "M3 4h18v16H3zM9 4v16M9 12h12" : match[2]}"`);
  expect(html).toContain('stroke-width="1.8"');
 }
 for (const [label,name] of [["Release checklist (plugin)","plugin-checklist"],["Add a plugin","add-plugin"]] as const) {
  const svg=board.slice(board.indexOf(`aria-label="${label}"`)).match(/<svg[\s\S]*?<\/svg>/)![0];
  expect(shapes(icon(name))).toEqual(shapes(svg));
 }
 const gear=board.slice(board.indexOf('aria-label="Settings,')).match(/<svg[\s\S]*?<\/svg>/)![0];
 expect(shapes(icon("settings")).sort()).toEqual(shapes(gear).sort());
});

test("settings navigation paths match the canvas, including its distinct plugin entry",async()=>{
 const board=await Bun.file("docs/design/project/SettingsNav.dc.html").text();
 const names:Record<string,IconName>={overview:"settings-home",agents:"settings-agents",routing:"settings-routing",budget:"settings-budget",machines:"settings-machines",plugins:"settings-plugins",app:"settings-app",diagnostics:"settings-diagnostics",release:"settings-release"};
 for(const match of board.matchAll(/^      (\w+): '([^']+)'/gm)) expect(icon(names[match[1]!]!)).toContain(`d="${match[2]}"`);
});

test("top bar shape markup and bare status terminal match their own boards",async()=>{
 const top=await Bun.file("docs/design/project/TopBar.dc.html").text();
 const svgs=[...top.matchAll(/<svg[\s\S]*?<\/svg>/g)].map(match=>match[0]);
 for(const [index,name] of (["topbar-search","topbar-left","topbar-bottom","topbar-right"] as const).entries()) expect(shapes(icon(name))).toEqual(shapes(svgs[index]!));
 const status=await Bun.file("docs/design/project/StatusBar.dc.html").text();
 expect(shapes(icon("status-terminal"))).toEqual(shapes(status.match(/<svg[\s\S]*?<\/svg>/)![0]));
 // Existing semantic symbols remain distinct from the board-specific variants.
 expect(icon("review")).not.toBe(icon("needs-you"));
 expect(icon("sessions")).not.toBe(icon("task-checklist"));
 expect(icon("search")).not.toBe(icon("topbar-search"));
});


test("command navigation, task results and terminal retain their own canvas symbols",async()=>{
 const board=await Bun.file("docs/design/project/CommandMenu.dc.html").text();
 for(const [key,name] of [["nav","command-nav"],["task","stack"],["term","command-terminal"],["pause","command-pause"]] as const){
  const path=board.match(new RegExp(`${key}: '([^']+)'`))![1];
  expect(icon(name)).toContain(`d="${path}"`);
 }
 expect(icon("activity-terminal")).not.toBe(icon("command-terminal"));
 expect(icon("dispatch")).not.toBe(icon("activity-dispatch"));
});
