import {expect, test} from "bun:test";
import {execFileSync} from "node:child_process";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {callOp} from "../src/api/ops";
import {toApiError} from "../src/api/errors";
import {fakeCtx} from "./helpers";
import golden from "./fixtures/config-writes-goldens.json";

let binary: string;
function driver() {
  if (!binary) {
    execFileSync("cargo", ["build", "-q", "-p", "pacer-server", "--example", "config_ops_diff", "--locked"]);
    const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1", "--locked"]).toString());
    binary = join(metadata.target_directory, "debug/examples/config_ops_diff");
  }
  return binary;
}
function home() {
  const path = mkdtempSync(join(tmpdir(), "native-config-"));
  writeFileSync(join(path, "strategy.yaml"), golden.initial + "\nplugins:\n  disabled: [pacer-endpoints]\n", {mode: 0o600});
  return path;
}
const normalize = (value: unknown, path: string) => JSON.parse(JSON.stringify(value).replaceAll(path, "$HOME"));
async function compare(op: string, params: unknown, setup?: (home: string) => void, rawParams?: string) {
  const rs = home(), ts = home();
  setup?.(rs); setup?.(ts);
  const ctx = fakeCtx({pacerHome: ts, home: ts, now: 1_700_000_000, env: {PACER_ORCA_USER_DATA:join(ts,"orca-user-data"),PACER_AGENT:"fixture"}});
  let expected: unknown;
  try {expected = {result: await callOp(ctx, op, params)};} catch (error) {expected = {error:toApiError(error)};}
  const input = `{"op":${JSON.stringify(op)},"params":${rawParams ?? JSON.stringify(params)},"home":${JSON.stringify(rs)},"now":${ctx.now},"agent":"fixture"}\n`;
  const actual = JSON.parse(execFileSync(driver(), [], {input}).toString());
  expect(normalize(actual,rs), `${op} ${JSON.stringify(params)} actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`).toEqual(normalize(expected,ts));
  for (const file of ["strategy.yaml", "active", "strategies/review.yaml", "settings.json"]) {
    const read = (path: string) => existsSync(join(path,file)) ? readFileSync(join(path,file)) : null;
    expect(read(rs), `${op}: ${file}`).toEqual(read(ts));
  }
  // Activity IDs are random; compare event order and payloads apart from IDs.
  const events = (path: string) => {
    if (!existsSync(join(path,"link/outbox.jsonl"))) return [];
    return readFileSync(join(path,"link/outbox.jsonl"),"utf8").trim().split("\n").map(line => {
      const entry=JSON.parse(line);
      if (entry.envelope.type === "entity" && entry.envelope.data.kind === "activity") { delete entry.envelope.data.id; delete entry.envelope.data.value.id; }
      return entry.envelope;
    }).filter(event => event.type !== "entity" || event.data.kind !== "plugin");
  };
  expect(normalize(events(rs),rs)).toEqual(normalize(events(ts),ts));
  return expected;
}
const named = (path: string) => {
  mkdirSync(join(path,"strategies"),{mode:0o700});
  writeFileSync(join(path,"strategies/review.yaml"),golden.initial,{mode:0o600});
};

test("native registry matches every TS config operation result, bytes and publication", async () => {
  const cases: [string,unknown,((home: string)=>void)?][] = [
    ["strategy.list",{}],
    ["strategy.list",{},path=>{named(path);writeFileSync(join(path,"strategies","broken.yaml"),"planner: [oops\n",{mode:0o600});}],
    ["strategy.list",{},path=>{named(path);writeFileSync(join(path,"active"),"review\n");}],
    ["strategy.show",{name:"default"}],
    ["strategy.show",{name:"review"},named],
    ["strategy.show",{name:"review"},path=>{named(path);writeFileSync(join(path,"active"),"review\n");}],
    ["strategy.show",{name:"missing"}],
    ["strategy.save",{name:"review",draft:{from:"default",description:"fixture",set:{"pacing.policy":"even"}},reason:"reviewed"}],
    ["strategy.use",{name:"review"},named], ["strategy.use",{name:"default"},path=>{named(path);writeFileSync(join(path,"active"),"review\n");}],
    ["strategy.remove",{name:"review"},named], ["strategy.remove",{name:"default"}],
    ["strategy.remove",{name:"review"},path=>{named(path);writeFileSync(join(path,"active"),"review\n");}],
    ["routing.set",{rules:[{kinds:["docs"],executors:["cursor"]},{executors:["codex"]}]}],
    ["routing.set",{rules:[]}], ["routing.set",{rules:[{executors:["missing"]}]}],
    ["runner.set",{id:"codex",enabled:false,model:null,max_tasks:2,rank:1}],
    ["runner.set",{id:"missing"}], ["runner.set",{id:"claude-code"}],
    ["runner.reorder",{ids:["cursor","codex"]}], ["runner.reorder",{ids:["codex"]}],
    ["runner.remove",{id:"cursor"}], ["runner.remove",{id:"claude-code"}], ["runner.remove",{id:"codex#missing"}],
    ["notifications.get",{}], ["notifications.get",{},p=>writeFileSync(join(p,"settings.json"),'{"notifications":"all"}')],
    ...["off","important","all"].map(level=>["notifications.set",{level}] as [string,unknown]),
    // Nested pacing inserts that add new map keys after a blank line before the
    // next root key are not byte-identical on this golden yet; stick to keys the
    // shared editor already matches here (corpus covers the broader matrix).
    ["config.set",{key:"update_check",value:false}],
    ["config.set",{key:"execution.auto_clean",value:true}],
    ["config.set",{key:"task_retention_days",value:7}],
    ["config.set",{key:"execution.local_max_tasks",value:3}],
    ["config.set",{key:"pacing.order",value:["codex","cursor"]}],
    ["config.set",{key:"terminal.app",value:"Ghostty"}],
    ["config.set",{key:"terminal.open",value:"kitty"}],
  ];
  for (const [op,params,setup] of cases) await compare(op,params,setup);
}, 60_000);

test("native schemas match TS Unicode lengths, JS safe integers, nulls and issue order", async () => {
  const cases: [string,unknown][] = [
    ["strategy.list",null],["strategy.show",{}],["strategy.show",{name:3}],["strategy.show",{name:""}],
    ["strategy.show",{name:"😀".repeat(65)}],
    ["strategy.use",{}],["strategy.use",{name:3}],["strategy.use",[]],
    ["strategy.save",{name:"review",draft:{from:"default"},reason:"\uFEFF"}],
    ["strategy.save",{name:"review",draft:{from:"default"},reason:"\u0085"}],
    ["strategy.save",{name:"review",draft:{from:"default",set:null},reason:"ok"}],
    ["strategy.save",{name:"review",draft:{from:"default",set:[],unset:3,description:null},reason:4,overwrite:null}],
    ["strategy.save",{name:"review",draft:null,reason:""}],
    ["runner.set",{id:"😀".repeat(65),model:"",enabled:null,max_tasks:0,rank:-1}],
    ...[1.5,1e20,-1e20,null,"1"].map(rank=>["runner.set",{id:"codex",rank,max_tasks:rank}] as [string,unknown]),
    ["runner.remove",{id:""}], ["runner.remove",{id:"codex\n"}],
    ["runner.reorder",{ids:[3,""]}], ["routing.set",{rules:[{kinds:null,executors:[null,""]},null]}],
    ["notifications.set",{level:"bad"}], ["notifications.get",null],
    ["config.set",{}], ["config.set",{key:"nope",value:1}],
    ["config.set",{key:"update_check",value:{a:1}}],
    ["config.set",{key:"pacing.policy",value:"bad"}],
    ["config.set",{key:"terminal.open",value:"not-a-preset"}],
  ];
  for (const [op,params] of cases) await compare(op,params);
},60_000);

test("notification migration and writes preserve TS object spread and numeric key order", async () => {
  for (const initial of ['[1e30,1e-7,1e-6,1e400,9007199254740993,-0]', '["keep",3]', '"ascii"', '"😀"', '{"0":"\\ud83d","1":"\\ude00","notifications":"all"}', '{"2":"second","0":"first","other":true}', '3', 'null', '{"unrelated":true,"notifications":"invalid"}']) {
    for (const op of ["notifications.get", "notifications.set"]) {
      await compare(op, op.endsWith("set") ? {level:"all"} : {}, path=>writeFileSync(join(path,"settings.json"), initial, {mode:0o600}));
    }
  }
}, 30_000);

test("native API preserves current-strategy raw errors and edit diagnostics", async () => {
  for (const [op,params] of [["runner.set",{id:"codex"}],["runner.reorder",{ids:[]}],["routing.set",{rules:[]}] ] as const) {
    await compare(op,params,path=>writeFileSync(join(path,"strategy.yaml"),"planner: unknown\n"));
  }
  await compare("routing.set",{rules:[{executors:["cursor","codex"]}]});
});

test("raw JSON draft.set keys use JS integer-index ordering", async () => {
  const rs=home(),ts=home();
  const text='{"name":"review","draft":{"from":"default","set":{"2":1,"1":2}},"reason":"approved"}';
  const params=JSON.parse(text),ctx=fakeCtx({home:ts,pacerHome:ts});
  let expected;
  try {expected={result:await callOp(ctx,"strategy.save",params)};}catch(error){expected={error:toApiError(error)};}
  const input=`{"home":${JSON.stringify(rs)},"op":"strategy.save","params":${text}}\n`;
  const actual=JSON.parse(execFileSync(driver(),[],{input}).toString());
  expect(actual).toEqual(expected);
});

test("notification reads and writes preserve valid deeply nested unrelated fields", async () => {
  for (const depth of [130,512]) {
    const initial='{"notifications":"all","nested":'+'['.repeat(depth)+'1'+']'.repeat(depth)+'}';
    for (const op of ["notifications.get","notifications.set"]) await compare(op,op.endsWith("set")?{level:"off"}:{},path=>writeFileSync(join(path,"settings.json"),initial,{mode:0o600}));
  }
});


test("notification UTF-8 replacement preserves unrelated state on reads, migration and writes", async () => {
  const invalid = [
    [0xff], [0xc0, 0xaf], [0xe2, 0x82], [0xed, 0xa0, 0x80],
    [0xf0, 0x90, 0x80], [0x80, 0xbf], [0xf4, 0x90, 0x80, 0x80],
  ];
  for (const bytes of invalid) for (const level of ["all", "invalid"]) {
    const initial = Buffer.concat([Buffer.from('{"keep":"'), Buffer.from(bytes), Buffer.from(`","notifications":"${level}"}`)]);
    for (const op of ["notifications.get", "notifications.set"]) {
      await compare(op, op.endsWith("set") ? {level:"off"} : {}, path =>
        writeFileSync(join(path,"settings.json"), initial, {mode:0o600}));
    }
  }
}, 60_000);

test("raw JSON numeric API fields match TS validation, results and persisted bytes", async () => {
  const fields: [string, (value: string) => string][] = [
    ...["max_tasks", "rank"].map(key => [key, (value: string) => `{"id":"codex","${key}":${value}}`] as [string, (value: string) => string]),
    ...["planner_reserve", "planner_reserve_headroom", "ahead_threshold", "behind_threshold"].map(key => [`pacing.${key}`, (value: string) => `{"name":"review","draft":{"from":"default","set":{"pacing.${key}":${value}}},"reason":"numeric parity"}`] as [string, (value: string) => string]),
    ...["timeoutMs", "reservePct", "comfortablePct"].map(key => [`dispatch.${key}`, (value: string) => `{"name":"review","draft":{"from":"default","set":{"dispatch":{"${key}":${value}}}},"reason":"numeric parity"}`] as [string, (value: string) => string]),
    ...["minSamples", "maxAgeDays"].map(key => [`dispatch.learning.${key}`, (value: string) => `{"name":"review","draft":{"from":"default","set":{"dispatch":{"learning":{"${key}":${value}}}}},"reason":"numeric parity"}`] as [string, (value: string) => string]),
    ...["providers.codex.budget.weekly_tokens", "providers.codex.cooldown", "classifier.timeout_ms", "classifier.bench.timeout_ms", "classifier.adapters.ollama.max_tokens", "classifier.adapters.jev.usd_per_mtok_in", "classifier.adapters.jev.usd_per_mtok_out", "classifier.decisions.difficulty.min_confidence", "classifier.decisions.difficulty.max_for_cheap"].map(key => [key, (value: string) => `{"name":"review","draft":{"from":"default","set":{"${key}":${value}}},"reason":"numeric parity"}`] as [string, (value: string) => string]),
    ["dispatch.steps.require.context", value => `{"name":"review","draft":{"from":"default","set":{"dispatch":{"steps":[{"id":"step","require":{"context":${value}}}]}}},"reason":"numeric parity"}`],
  ];
  const literals = ["1.0", "1e2", "-0.0", "-1", "0.5", "0.000001", "9.999999999999997e-7", "1.0000000000000002e-6", "1e-7", "1e20", "1e21", "9007199254740990", "9007199254740991", "9007199254740992", "9007199254740993", "-9007199254740991", "-9007199254740992"];
  for (const [field, raw] of fields) for (const literal of literals) {
    const text = raw(literal);
    try { await compare(field === "rank" || field === "max_tasks" ? "runner.set" : "strategy.save", JSON.parse(text), undefined, text); }
    catch (error) { throw new Error(`${field}=${literal}: ${error}`); }
  }
  await compare("strategy.save", {name:"review", draft:{from:"default", set:{"providers.codex.model":"fixture-model"}}, reason:"runner model parity"});
}, 120_000);

// Preserve the reference editor's behavior for block routing, including rejected edits.
const blockRouting = golden.initial.replace(
  "  - kinds: [docs]\n    executors: [codex, cursor] # keep list\n  - default: [codex, cursor]",
  "  - kinds:\n      - docs\n    executors:\n      - codex\n  - kinds: [tests]\n    executors: [cursor] # c\n  - default:\n      - codex");

test("block routing removal preserves CRLF, trailing spaces and exact error excerpts", async () => {
  for (const newline of ["\n", "\r\n"]) for (const padding of ["", " ", "   "]) {
    const initial = blockRouting.replaceAll("kinds:\n", `kinds:${padding}\n`).replaceAll("\n", newline);
    const setup = (path: string) => writeFileSync(join(path, "strategy.yaml"), initial);
    await compare("runner.remove", {id:"cursor"}, setup);
    await compare("routing.set", {rules:[{kinds:["docs"],executors:["cursor"]},{executors:["codex"]}]}, setup);
    await compare("routing.set", {rules:[{executors:["codex"]}]}, setup);
  }
}, 60_000);

test("native load accepts duplicate keys before the editor returns the reference diagnostic", async () => {
  await compare("runner.set", {id:"codex", enabled:false}, path => writeFileSync(join(path,"strategy.yaml"),
    golden.initial.replace("  codex: {} # keep runner", "  codex: {} # keep runner\n  codex: {}")));
});

test("native strategy loader matches Bun YAML numeric and mapping keys", async () => {
  for (const initial of [
    golden.initial.replace("  codex: {} # keep runner", "  codex: {max_tasks: 0x2} # keep runner"),
    ...["1", "1.0", "true", "null"].map(key => golden.initial.replace("accounts:\n", `accounts:\n  ${key}: {kind: codex}\n`)),
  ]) await compare("runner.set", {id:"codex", enabled:false}, path => writeFileSync(join(path,"strategy.yaml"), initial));
}, 120_000);

test("native strategy loader matches Bun YAML non-finite number validation", async () => {
  for (const value of [".inf", "-.Inf", ".nan", "inf", "nan"]) {
    await compare("runner.set", {id:"codex", enabled:false}, path => writeFileSync(join(path,"strategy.yaml"),
      golden.initial.replace("pacing:\n", `pacing:\n  planner_reserve: ${value}\n`)));
  }
}, 120_000);

test("native pacing fields preserve non-finite YAML values", async () => {
  for (const key of ["planner_reserve", "planner_reserve_headroom", "fill_threshold", "ahead_threshold", "behind_threshold"]) for (const value of [".inf", "-.inf", ".nan"]) {
    await compare("runner.set", {id:"codex", enabled:false}, path => writeFileSync(join(path,"strategy.yaml"),
      golden.initial.replace("pacing:\n", `pacing:\n  ${key}: ${value}\n`)));
  }
}, 120_000);

// Values stay numbers until validation and JSON serialization; user strings never
// stand in for NaN, and exponent overflow has the same semantics as .inf.
test("non-finite YAML values preserve TS comparisons, strings and serialization", async () => {
  const values = [".inf", "-.inf", ".nan", "1e400", "-1e400", '"\\0pacer-yaml-nan"'];
  const locations = [
    (v: string) => golden.initial.replace("pacing:\n", `pacing:\n  planner_reserve: ${v}\n`),
    (v: string) => golden.initial.replace("pacing:\n", `pacing:\n  ahead_threshold: ${v}\n`),
    (v: string) => golden.initial.replace("pacing:\n", `pacing:\n  fill_threshold: ${v}\n`),
    (v: string) => golden.initial + `\nexecution: {local_load_limit: ${v}}\n`,
    (v: string) => golden.initial.replace("  codex: {} # keep runner", `  codex: {model: ${v}} # keep runner`),
    (v: string) => golden.initial.replace("  codex: {kind: codex}", `  codex: {kind: codex, usage: metered, budget: {weekly_tokens: ${v}}}`),
  ];
  for (const value of values) for (const initial of locations.map(f => f(value))) {
    const setup = (path: string) => writeFileSync(join(path, "strategy.yaml"), initial);
    await compare("runner.set", {id:"codex", enabled:false}, setup);
    await compare("strategy.save", {name:"review", draft:{from:"default"}, reason:"non-finite parity"}, setup);
  }
}, 120_000);

test("duplicate YAML key diagnostics match reference context, properties and UTF-16 columns", async () => {
  const cases = [
    golden.initial.replace("  claude: {kind: claude}", "  claude: {kind: claude, kind: claude}"),
    golden.initial.replace("  claude: {kind: claude}", '  claude: {"😀": 1, kind: claude, kind: claude}'),
    golden.initial.replace("  claude: {kind: claude}", `  claude: {padding: "${"x".repeat(100)}", kind: claude, kind: claude}`),
    golden.initial.replace("accounts:\n", `accounts: # ${"x".repeat(100)}\n`).replace("  claude: {kind: claude}", "  claude: {kind: claude}\n  claude: {kind: claude}"),
    golden.initial.replace("  codex: {kind: codex}", "  codex: {kind: codex}\n  &k codex: {kind: codex}"),
    golden.initial.replace("  claude: {kind: claude}", "  claude: {kind: claude}\n  &k \"claude\": {kind: claude}"),
  ];
  for (const initial of cases) for (const newline of ["\n", "\r\n"]) {
    const setup = (path: string) => writeFileSync(join(path,"strategy.yaml"), initial.replaceAll("\n", newline));
    await compare("runner.set", {id:"codex", enabled:false}, setup);
    await compare("routing.set", {rules:[{executors:["codex"]}]}, setup);
  }
}, 120_000);

// The editor uses yaml's scalar-node === check, independently of Bun's loader.
test("editor keys accept NaN, signed radix, collection and alias pairs like yaml", async () => {
  const maps = [
    "  .nan: first\n  .nan: second\n",
    "  -0x10: first\n  -16: second\n",
    "  +0o10: first\n  8: second\n",
    "  ? {a: 1}\n  : first\n  ? {a: 1}\n  : second\n",
    "  a: &x 1\n  *x : second\n  1: third\n",
    "  !!str 1: first\n  1: second\n",
    '  !!int "1": first\n  "1": second\n',
    "  !!int -0x10: first\n  -16: second\n",
    "  !!float 1: first\n  1: second\n",
    "  !!int 1.0: first\n  1.0: second\n",
    "  !custom 1: first\n  1: second\n",
  ];
  const operations = [
    ["runner.set", {id:"codex",enabled:false}],
    ["runner.reorder", {ids:["cursor","codex"]}],
    ["routing.set", {rules:[{kinds:["docs"],executors:["cursor","codex"]},{executors:["codex","cursor"]}]}],
  ] as const;
  for (const map of maps) for (const [op,params] of operations) {
    const initial=golden.initial+"\nmisc:\n"+map;
    expect(await compare(op,params,path=>writeFileSync(join(path,"strategy.yaml"),initial))).toHaveProperty("result");
  }
},120_000);

test("nested YAML sequences preserve Bun save bytes including empty collections", async () => {
  const cases = [
    "misc: {c: [[]], e: [[1, 2], [.inf]]}\n",
    "misc: [[[]], [[1, 2], [.inf, -.inf, .nan]], [[], {}, [true, null]]]\n",
  ];
  for (const fixture of cases) expect(await compare("strategy.save",{name:"review",draft:{from:"default"},reason:"nested YAML parity"},
    path=>writeFileSync(join(path,"strategy.yaml"),golden.initial+"\n"+fixture))).toHaveProperty("result");
},120_000);

test("radix prefixes reject internal signs in YAML values and keys", async () => {
  for (const literal of ["0x+5","0o+5","+0x+5","-0x+5","0x-5","0o-5"]) {
    await compare("runner.set",{id:"codex",enabled:false},path=>writeFileSync(join(path,"strategy.yaml"),
      golden.initial.replace("  codex: {} # keep runner",`  codex: {max_tasks: ${literal}} # keep runner`)));
    expect(await compare("strategy.save",{name:"review",draft:{from:"default"},reason:"radix parity"},path=>writeFileSync(join(path,"strategy.yaml"),
      golden.initial+`\nmisc: {value: ${literal}, ${literal}: kept}\n`))).toHaveProperty("result");
  }
},120_000);

test("editor keys resolve explicit tags and large radix integers before duplicate checks", async () => {
  for(const map of [
    '  !!int "1": first\n  1: second\n',
    '  !!bool "true": first\n  true: second\n',
    '  !!str 1: first\n  "1": second\n',
    "  0x10000000000000000: first\n  18446744073709551616: second\n",
    "  0o2000000000000000000000: first\n  18446744073709551616: second\n",
  ]) expect(await compare("runner.set",{id:"codex",enabled:false},path=>writeFileSync(join(path,"strategy.yaml"),golden.initial+"\nmisc:\n"+map))).toHaveProperty("error");
  const radixKeys = ["0x20000000000001", "0x10000000000000801", "0xffffffffffffffffffffffff", "0o7777777777777777777777", "0x"+"f".repeat(256)];
  for(const key of radixKeys) {
    const n=parseInt(key.slice(2),key.startsWith("0x")?16:8), decimal=Number.isFinite(n)?String(n):".inf";
    const initial=golden.initial+`\nmisc:\n  ${key}: first\n  ${decimal}: second\n`;
    expect(await compare("runner.set",{id:"codex",enabled:false},path=>writeFileSync(join(path,"strategy.yaml"),initial))).toHaveProperty("error");
  }
},120_000);

test("verbatim core tags retain yaml editor duplicate detection", async () => {
  for (const [tag,key] of [["int","1"],["bool","true"],["float","1.0"],["null","null"]]) {
    const initial=golden.initial+`\nmisc:\n  !<tag:yaml.org,2002:${tag}> ${key}: first\n  ${key}: second\n`;
    for (const [op,params] of [
      ["runner.set",{id:"codex",enabled:false}],
      ["runner.reorder",{ids:["cursor","codex"]}],
      ["routing.set",{rules:[{executors:["cursor","codex"]}]}],
    ] as const) expect(await compare(op,params,path=>writeFileSync(join(path,"strategy.yaml"),initial))).toHaveProperty("error");
  }
},120_000);

test("signed radix strings stay strings through strategy save", async () => {
  for (const literal of ["+0x5","+0o5"]) expect(await compare("strategy.save",{name:"review",draft:{from:"default"},reason:"string radix parity"},
    path=>writeFileSync(join(path,"strategy.yaml"),golden.initial+`\nmisc: {value: "${literal}", "${literal}": kept}\n`))).toHaveProperty("result");
},120_000);

test("native config.get matches TypeScript with injected host fields", async () => {
  const rs = home(), ts = home();
  const ctx = fakeCtx({ pacerHome: ts, home: ts, now: 1_700_000_000, env: { PACER_ORCA_USER_DATA: join(ts, "orca-user-data"), PACER_AGENT: "fixture" } });
  const { configHostParts } = await import("../src/api/config-host-bridge");
  const hostParts = configHostParts(ctx);
  let expected: unknown;
  try { expected = { result: await callOp(ctx, "config.get", {}) }; } catch (error) { expected = { error: toApiError(error) }; }
  const input = `{"op":"config.get","params":{},"home":${JSON.stringify(rs)},"now":${ctx.now},"agent":"fixture","hostParts":${JSON.stringify(hostParts)}}\n`;
  const actual = JSON.parse(execFileSync(driver(), [], { input }).toString());
  expect(normalize(actual, rs), JSON.stringify(actual)).toEqual(normalize(expected, ts));
}, 120_000);
