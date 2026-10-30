import {expect,test} from "bun:test";
import {applyUndo,mergeUndo,piecesPresent,removeTomlTable,type UndoOp} from "../packages/plugin-sdk/src/install/undo";
import * as host from "../src/install/manifest";
import {upsertBlock} from "../packages/plugin-sdk/src/install/blocks";
const block = [{kind:"block",style:"md"}] as const;
test("applyUndo removes each kind in order and preserves JSON member surroundings", () => {
  expect(applyUndo("mine\n\n<!-- >>> pacer >>> -->\none\n<!-- <<< pacer <<< -->\n", [...block])).toBe("mine\n");
  expect(applyUndo('top = 1\n[mcp_servers.pacer]\ncommand = "pacer"\n[next]\nx = 2\n', [{ kind: "toml-table", table: "mcp_servers.pacer" }])).toBe("top = 1\n[next]\nx = 2\n");
  expect(applyUndo('[mcp_servers.pacer]\nx = 1', [{ kind: "toml-table", table: "mcp_servers.pacer" }])).toBe("");
  expect(applyUndo('{\n  "mcp": {"pacer": {}},\n  "mine": true\n}\n', [{ kind: "json-member", path: ["mcp", "pacer"], dropEmpty: ["mcp"] }])).toBe('{\n  "mine": true\n}\n');
  expect(applyUndo('{"hooks":{"SessionStart":[{"hooks":[{"command":"pacer"}]}]},"statusLine":{},"mine":1}', [
    { kind: "hooks", format: "claude", commands: ["pacer"], restore: [{ event: "SessionStart", hook: { type: "command", command: "legacy" } }] },
    { kind: "json-key", key: "statusLine" },
  ])).toBe(JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "legacy" }] }] }, mine: 1 }, null, 2) + "\n");
});

test("piecesPresent detects owned pieces and never throws on malformed documents", () => {
  expect(piecesPresent(upsertBlock("", "one", "md"), [...block])).toBe(true);
  expect(piecesPresent("mine", [...block])).toBe(false);
  expect(piecesPresent('{"mcp":{"pacer":{}}}', [{ kind: "json-member", path: ["mcp", "pacer"] }])).toBe(true);
  expect(piecesPresent('bad', [{ kind: "json-key", key: "pacer" }])).toBe(false);
  expect(piecesPresent('[pacer]\nx=1', [{ kind: "toml-table", table: "pacer" }])).toBe(true);
  expect(piecesPresent('{"hooks":{"sessionStart":[{"command":"pacer"}]}}', [{ kind: "hooks", format: "cursor", commands: ["pacer"], restore: [] }])).toBe(true);
});

test("mergeUndo unions hooks and deduplicates ownership operations", () => {
  expect(mergeUndo([...block, { kind: "hooks", format: "cursor", commands: ["old"], restore: [] }], [...block, { kind: "hooks", format: "cursor", commands: ["new", "old"], restore: [{ event: "sessionStart", hook: { command: "legacy" } }] }])).toEqual([...block, { kind: "hooks", format: "cursor", commands: ["old", "new"], restore: [{ event: "sessionStart", hook: { command: "legacy" } }] }]);
});

test("TOML table undo accepts trailing header comments and leaves the next table intact", () => {
  const text = '[mcp_servers.pacer] # managed\ncommand = "pacer"\n[next]\nx = 2\n';
  expect(applyUndo(text, [{ kind: "toml-table", table: "mcp_servers.pacer" }])).toBe('[next]\nx = 2\n');
  expect(piecesPresent(text, [{ kind: "toml-table", table: "mcp_servers.pacer" }])).toBe(true);
});


test("SDK undo and retained host helpers agree byte-for-byte across every operation", () => {
  const cases: {text:string;ops:UndoOp[]}[] = [
    {text:"before\n\n<!-- >>> pacer >>> -->\n界\n<!-- <<< pacer <<< -->\n",ops:[{kind:"block",style:"md"}]},
    {text:"anchor\n\n# >>> pacer >>>\nnew\n# <<< pacer <<<\n",ops:[{kind:"block",style:"hash",restore:[{text:"legacy\n",anchor:"anchor\n",spacing:"\n",atMarker:true}]}]},
    {text:"other",ops:[{kind:"block",style:"hash",restore:[{text:"legacy\n",anchor:"missing\n"}]}]},
    {text:'[managed] # comment\r\nx=1\r\n[next]\r\ny=2',ops:[{kind:"toml-table",table:"managed"}]},
    {text:'\ufeff{\n// keep\n"mcp":{"pacer":{},},"mine":"界",\n}',ops:[{kind:"json-member",path:["mcp","pacer"],dropEmpty:["mcp"]}]},
    {text:'{"hooks":{"SessionStart":[{"matcher":"Bash","hooks":[{"command":"owned"},{"command":"other"}]}]}}',ops:[{kind:"hooks",format:"claude",commands:["owned"],restore:[{event:"SessionStart",matcher:"Bash",hook:{command:"legacy",timeout:15}}]}]},
    {text:'{"hooks":{"sessionStart":[{"command":"owned","custom":true}]},"statusLine":{},"mine":1}',ops:[{kind:"hooks",format:"cursor",commands:["owned"],restore:[]},{kind:"json-key",key:"statusLine"}]},
    {text:'{"key":1,"key":2}',ops:[{kind:"json-key",key:"key"}]},
  ];
  for(const {text,ops} of cases) {
    const notes:string[]=[],hostNotes:string[]=[];
    expect(applyUndo(text,ops,notes)).toBe(host.applyUndo(text,ops,hostNotes));
    expect(notes).toEqual(hostNotes);
    expect(piecesPresent(text,ops)).toBe(host.piecesPresent(text,ops));
    expect(mergeUndo(ops,ops)).toEqual(host.mergeUndo(ops,ops));
  }
  expect(removeTomlTable("prefix\n[owned]\nx=1\n[next]\ny=2", "owned")).toBe(host.removeTomlTable("prefix\n[owned]\nx=1\n[next]\ny=2", "owned"));
});
test("SDK mergeUndo retains restore ordering and never aliases input", () => {
  const old:UndoOp[]=[{kind:"block",style:"hash",restore:[{text:"first",anchor:null}]}];
  const added:UndoOp[]=[{kind:"block",style:"hash",restore:[{text:"first",anchor:"other"},{text:"second",anchor:null}]}];
  const before=JSON.stringify({old,added}),merged=mergeUndo(old,added);
  expect(merged).toEqual(host.mergeUndo(old,added));
  expect(JSON.stringify({old,added})).toBe(before);
  if(merged[0]?.kind==="block") merged[0].restore![0]!.text="mutated";
  expect(JSON.stringify({old,added})).toBe(before);
});
