#![allow(clippy::unwrap_used, clippy::expect_used)]
use pacer_foundation::Ctx;
use pacer_store::outbox::{append_outbox, parse_outbox_event, parse_snapshot};
use pacer_store::{
    ActivityOptions, append_activity, publish, publish_config_change, read_activity, read_latest,
    read_outbox_since, rotate_activity,
};
use regex::Regex;
use serde_json::{Value, json};
use std::{collections::HashMap, fs, io::Write, path::Path, process::Command};

fn ctx(path: &Path) -> Ctx {
    Ctx::with(
        path.to_path_buf(),
        path.join(".pacer"),
        HashMap::new(),
        1_760_000_000.0,
    )
}

fn bun(home: &Path, code: &str) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .unwrap();
    let result = Command::new("bun")
        .arg("-e")
        .arg(code)
        .env("TEST_HOME", home)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn config_publication_matches_bun_bytes_and_sequence() {
    let rust = tempfile::tempdir().unwrap();
    let ts = tempfile::tempdir().unwrap();
    let c = ctx(rust.path());
    let report = publish_config_change(&c, "strategy").unwrap();
    assert_eq!(report.seq, 2);
    bun(
        ts.path(),
        r#"
import {publishConfigChange} from './src/core/events.ts';
const c={home:process.env.TEST_HOME,pacerHome:process.env.TEST_HOME+'/.pacer',now:1760000000,env:{},run:async()=>({code:127,stdout:'',stderr:''}),which:()=>null};
await publishConfigChange(c,'strategy');
"#,
    );
    let id = Regex::new(r"1760000000-[0-9a-f]{4}").unwrap();
    for file in [
        "link/latest.json",
        "link/outbox.jsonl",
        "state/activity.jsonl",
    ] {
        let actual = fs::read_to_string(c.pacer_home.join(file)).unwrap();
        let expected = fs::read_to_string(ts.path().join(".pacer").join(file)).unwrap();
        assert_eq!(
            id.replace_all(&actual, "fixed"),
            id.replace_all(&expected, "fixed"),
            "{file}"
        );
    }
    #[cfg(unix)]
    for (path, expected) in [
        ("link", 0o700),
        ("link/outbox.jsonl", 0o600),
        ("link/latest.json", 0o600),
        ("state", 0o700),
        ("state/activity.jsonl", 0o600),
    ] {
        use std::os::unix::fs::PermissionsExt;
        let mode = |root: &Path| {
            fs::metadata(root.join(".pacer").join(path))
                .unwrap()
                .permissions()
                .mode()
                & 0o777
        };
        assert_eq!(mode(rust.path()), expected, "Rust {path}");
        assert_eq!(mode(ts.path()), expected, "Bun {path}");
    }
    let rust_log = fs::read_to_string(c.pacer_home.join("state/activity.jsonl")).unwrap();
    let ts_log = fs::read_to_string(ts.path().join(".pacer/state/activity.jsonl")).unwrap();
    let mut a: Value = serde_json::from_str(rust_log.trim()).unwrap();
    let mut b: Value = serde_json::from_str(ts_log.trim()).unwrap();
    a["id"] = json!("fixed");
    b["id"] = json!("fixed");
    assert_eq!(a, b);
    assert_eq!(read_outbox_since(&c, 0.0).unwrap().len(), 2);
}

#[test]
fn stale_pid_temp_survives_and_publication_retries_from_outbox_tail() {
    let root = tempfile::tempdir().unwrap();
    let c = ctx(root.path());
    let link = c.pacer_home.join("link");
    fs::create_dir_all(&link).unwrap();
    let stale = link.join(format!("latest.json.{}.tmp", std::process::id()));
    fs::write(&stale, "stale").unwrap();
    let event = json!({"type":"config","data":{"area":"first","at":c.now}});
    let first = publish(&c, &[event]);
    assert!(first.errors.is_empty(), "{:?}", first.errors);
    assert_eq!(first.seq, 1);
    assert_eq!(fs::read_to_string(&stale).unwrap(), "stale");
    fs::write(link.join("latest.json"), r#"{"v":1,"seq":0,"at":0}"#).unwrap();
    let second = publish(
        &c,
        &[json!({"type":"config","data":{"area":"second","at":c.now}})],
    );
    assert!(second.errors.is_empty(), "{:?}", second.errors);
    assert_eq!(second.seq, 2);
    assert_eq!(read_outbox_since(&c, 0.0).unwrap().len(), 2);

    let stale_rotation = link.join(format!("outbox.jsonl.{}.tmp", std::process::id()));
    fs::write(&stale_rotation, "stale rotation").unwrap();
    let events: Vec<Value> = (0..1001)
        .map(|i| json!({"type":"config","data":{"area":format!("fixture-{i}"),"at":c.now}}))
        .collect();
    let rotated = publish(&c, &events);
    assert!(rotated.errors.is_empty(), "{:?}", rotated.errors);
    assert_eq!(rotated.seq, 1003);
    assert_eq!(
        fs::read_to_string(&stale_rotation).unwrap(),
        "stale rotation"
    );
    assert_eq!(read_latest(&c)["seq"], json!(1003));
}

#[cfg(unix)]
#[test]
fn publication_modes_match_bun_and_are_private() {
    use std::os::unix::fs::PermissionsExt;
    let rust = tempfile::tempdir().unwrap();
    let ts = tempfile::tempdir().unwrap();
    let event = json!({"type":"entity","data":{"kind":"message","id":"m"}});
    let c = ctx(rust.path());
    assert_eq!(publish(&c, &[event]).seq, 1);
    bun(
        ts.path(),
        r#"
import {publish} from './src/link/publish.ts';
const c={home:process.env.TEST_HOME,pacerHome:process.env.TEST_HOME+'/.pacer',now:1760000000,env:{}};
await publish(c,[{type:'entity',data:{kind:'message',id:'m'}}]);
"#,
    );
    for (path, expected) in [
        ("link", 0o700),
        ("link/outbox.jsonl", 0o600),
        ("link/latest.json", 0o600),
    ] {
        let mode = |root: &Path| {
            fs::metadata(root.join(".pacer").join(path))
                .unwrap()
                .permissions()
                .mode()
                & 0o777
        };
        assert_eq!(mode(rust.path()), mode(ts.path()), "{path}");
        assert_eq!(mode(rust.path()), expected, "{path}");
    }
    let link = ts.path().join(".pacer/link");
    fs::set_permissions(&link, fs::Permissions::from_mode(0o777)).unwrap();
    let outbox = link.join("outbox.jsonl");
    fs::set_permissions(&outbox, fs::Permissions::from_mode(0o666)).unwrap();
    let second = ctx(ts.path());
    assert_eq!(
        publish(
            &second,
            &[json!({"type":"entity","data":{"kind":"message","id":"n"}})]
        )
        .seq,
        2
    );
    assert_eq!(
        fs::metadata(link).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(outbox).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let state = rust.path().join(".pacer/state");
    fs::create_dir_all(&state).unwrap();
    let activity = state.join("activity.jsonl");
    fs::write(&activity, "").unwrap();
    fs::set_permissions(&state, fs::Permissions::from_mode(0o777)).unwrap();
    fs::set_permissions(&activity, fs::Permissions::from_mode(0o666)).unwrap();
    append_activity(
        &c,
        json!({"kind":"message","level":"info","text":"private"}),
    )
    .unwrap();
    assert_eq!(
        fs::metadata(state).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(activity).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn non_ascii_event_ids_and_truncation_match_bun() {
    let inputs = json!([
        {"type":"entity","data":{"kind":"message","id":"界".repeat(70)}},
        {"type":"entity","data":{"kind":"message","id":"界".repeat(129)}},
        {"type":"entity","data":{"kind":"message","id":"😀".repeat(64)}},
        {"type":"entity","data":{"kind":"message","id":"😀".repeat(65)}},
        {"type":"budget","data":{"generatedAt":1,"strategy":"界".repeat(130),"planner":"😀".repeat(33),"mode":"normal","providers":[],"ranked":[]}}
    ]);
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .unwrap();
    let result = Command::new("bun")
        .arg("-e")
        .arg(
            r#"
import {parseOutboxEvent} from './src/link/envelope.ts';
process.stdout.write(JSON.stringify(JSON.parse(process.env.TEST_INPUTS).map(parseOutboxEvent)));
"#,
        )
        .env("TEST_INPUTS", inputs.to_string())
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let expected: Value = serde_json::from_slice(&result.stdout).unwrap();
    let actual = Value::Array(
        inputs
            .as_array()
            .unwrap()
            .iter()
            .map(|v| parse_outbox_event(v).unwrap_or(Value::Null))
            .collect(),
    );
    assert_eq!(actual, expected);
}

#[test]
fn astral_task_goal_boundary_matches_bun_publication_bytes() {
    for (prefix, suffix) in [(199, ""), (198, "z")] {
        let rust = tempfile::tempdir().unwrap();
        let ts = tempfile::tempdir().unwrap();
        let goal = format!("{}😀{suffix}", "x".repeat(prefix));
        let raw = json!({"type":"task","data":{"id":"t","state":"running","goal":goal,"executor":format!("{}😀", "x".repeat(63)),"updatedAt":1}});
        let event = parse_outbox_event(&raw).unwrap();
        let report = publish(&ctx(rust.path()), &[event]);
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        bun(
            ts.path(),
            &format!(
                r#"
import {{parseOutboxEvent}} from './src/link/envelope.ts';
import {{publish}} from './src/link/publish.ts';
const c={{home:process.env.TEST_HOME,pacerHome:process.env.TEST_HOME+'/.pacer',now:1760000000,env:{{}}}};
const event=parseOutboxEvent({{type:'task',data:{{id:'t',state:'running',goal:'x'.repeat({prefix})+'😀'+'{suffix}',executor:'x'.repeat(63)+'😀',updatedAt:1}}}});
const report=await publish(c,[event]);
if(report.errors.length) throw new Error(report.errors.join(','));
"#
            ),
        );
        for file in ["link/outbox.jsonl", "link/latest.json"] {
            assert_eq!(
                fs::read(rust.path().join(".pacer").join(file)).unwrap(),
                fs::read(ts.path().join(".pacer").join(file)).unwrap(),
                "{file}, prefix {prefix}"
            );
        }
    }
}

#[test]
fn astral_activity_boundary_matches_bun_jsonl_and_outbox_text_bytes() {
    let rust = tempfile::tempdir().unwrap();
    let ts = tempfile::tempdir().unwrap();
    let input = json!({"kind":"message","level":"info","text":format!("{}😀", "x".repeat(499))});
    append_activity(&ctx(rust.path()), input).unwrap();
    bun(
        ts.path(),
        r#"
import {appendActivity} from './src/activity/log.ts';
import {existsSync} from 'node:fs';
const c={home:process.env.TEST_HOME,pacerHome:process.env.TEST_HOME+'/.pacer',now:1760000000,env:{}};
appendActivity(c,{kind:'message',level:'info',text:'x'.repeat(499)+'😀'});
for(let i=0;i<100&&!existsSync(c.pacerHome+'/link/outbox.jsonl');i++) await Bun.sleep(10);
if(!existsSync(c.pacerHome+'/link/outbox.jsonl')) throw Error('missing outbox');
"#,
    );
    let text_bytes = |root: &Path, file: &str| {
        let bytes = fs::read(root.join(".pacer").join(file)).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        Regex::new(r#""text":"([^"]*)""#)
            .unwrap()
            .captures(&text)
            .unwrap()[0]
            .as_bytes()
            .to_vec()
    };
    for file in ["state/activity.jsonl", "link/outbox.jsonl"] {
        assert_eq!(
            text_bytes(rust.path(), file),
            text_bytes(ts.path(), file),
            "{file}"
        );
    }
}

#[test]
fn overlong_event_and_strategy_boundaries_match_bun_publication_bytes() {
    let rust = tempfile::tempdir().unwrap();
    let ts = tempfile::tempdir().unwrap();
    let snapshot = json!({"v":1,"seq":0,"at":0,"strategies":["😀".repeat(65)]});
    for root in [rust.path(), ts.path()] {
        let link = root.join(".pacer/link");
        fs::create_dir_all(&link).unwrap();
        fs::write(link.join("latest.json"), snapshot.to_string()).unwrap();
    }
    let raw = json!([
        {"type":"config","data":{"area":"x".repeat(129),"at":1}},
        {"type":"assistant","data":{"turnId":format!("{}😀", "x".repeat(127)),"conversationId":"c","state":"done"}}
    ]);
    let events: Vec<Value> = raw
        .as_array()
        .unwrap()
        .iter()
        .map(|event| parse_outbox_event(event).unwrap())
        .collect();
    assert!(publish(&ctx(rust.path()), &events).errors.is_empty());
    bun(
        ts.path(),
        r#"
import {parseOutboxEvent} from './src/link/envelope.ts';
import {publish} from './src/link/publish.ts';
const c={home:process.env.TEST_HOME,pacerHome:process.env.TEST_HOME+'/.pacer',now:1760000000,env:{}};
const events=[
  {type:'config',data:{area:'x'.repeat(129),at:1}},
  {type:'assistant',data:{turnId:'x'.repeat(127)+'😀',conversationId:'c',state:'done'}}
].map(parseOutboxEvent);
const report=await publish(c,events);
if(report.errors.length) throw Error(report.errors.join(','));
"#,
    );
    for file in ["link/outbox.jsonl", "link/latest.json"] {
        assert_eq!(
            fs::read(rust.path().join(".pacer").join(file)).unwrap(),
            fs::read(ts.path().join(".pacer").join(file)).unwrap(),
            "{file}"
        );
    }
}

#[test]
fn alternating_bun_and_rust_events_keep_sequence() {
    let tmp = tempfile::tempdir().unwrap();
    let c = ctx(tmp.path());
    bun(
        tmp.path(),
        r#"
import {publish} from './src/link/publish.ts';
const c={home:process.env.TEST_HOME,pacerHome:process.env.TEST_HOME+'/.pacer',now:1760000000,env:{}};
await publish(c,[{type:'entity',data:{kind:'machine',id:'m',value:{name:'m'}}}]);
"#,
    );
    assert_eq!(
        publish(
            &c,
            &[json!({"type":"entity","data":{"kind":"plugin","id":"p","value":{"state":"ready"}}})]
        )
        .seq,
        2
    );
    bun(
        tmp.path(),
        r#"
import {publish} from './src/link/publish.ts';
const c={home:process.env.TEST_HOME,pacerHome:process.env.TEST_HOME+'/.pacer',now:1760000000,env:{}};
await publish(c,[{type:'entity',data:{kind:'message',id:'turn'}},{type:'entity',data:{kind:'liveness',id:'agent'}}]);
"#,
    );
    let entries = read_outbox_since(&c, 0.0).unwrap();
    assert_eq!(
        entries
            .iter()
            .map(|v| v["seq"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        vec![1, 2, 3, 4]
    );
}

#[test]
fn decimal_json_outbox_sequence_replays_like_bun() {
    let rust = tempfile::tempdir().unwrap();
    let ts = tempfile::tempdir().unwrap();
    let pending = "{\"seq\":1.0,\"at\":1760000000,\"envelope\":{\"type\":\"config\",\"data\":{\"area\":\"pending\",\"at\":1760000000}}}\n";
    for home in [rust.path(), ts.path()] {
        let link = home.join(".pacer/link");
        fs::create_dir_all(&link).unwrap();
        fs::write(link.join("latest.json"), r#"{"v":1,"seq":0,"at":0}"#).unwrap();
        fs::write(link.join("outbox.jsonl"), pending).unwrap();
    }
    let event = json!({"type":"config","data":{"area":"next","at":1760000000}});
    let report = publish(&ctx(rust.path()), &[event]);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(report.seq, 2);
    bun(
        ts.path(),
        r#"
import {publish} from './src/link/publish.ts';
const c={home:process.env.TEST_HOME,pacerHome:process.env.TEST_HOME+'/.pacer',now:1760000000,env:{}};
const report=await publish(c,[{type:'config',data:{area:'next',at:1760000000}}]);
if(report.errors.length || report.seq!==2) throw Error(JSON.stringify(report));
"#,
    );
    for file in ["link/latest.json", "link/outbox.jsonl"] {
        assert_eq!(
            fs::read(rust.path().join(".pacer").join(file)).unwrap(),
            fs::read(ts.path().join(".pacer").join(file)).unwrap(),
            "{file}"
        );
    }
}

#[test]
fn activity_torn_lines_pagination_and_rotation() {
    let tmp = tempfile::tempdir().unwrap();
    let c = ctx(tmp.path());
    let first =
        append_activity(&c, json!({"kind":"message","level":"info","text":"first"})).unwrap();
    fs::OpenOptions::new()
        .append(true)
        .open(c.pacer_home.join("state/activity.jsonl"))
        .unwrap()
        .write_all(b"\xff{torn\n")
        .unwrap();
    append_activity(&c, json!({"kind":"policy","level":"warn","text":"second"})).unwrap();
    let page = read_activity(
        &c,
        &ActivityOptions {
            limit: Some(1),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(page.entries[0]["text"], "second");
    assert_eq!(
        read_activity(
            &c,
            &ActivityOptions {
                before: page.next.as_deref(),
                ..Default::default()
            }
        )
        .unwrap()
        .entries[0]["id"],
        first["id"]
    );
    rotate_activity(&c).unwrap();
    assert_eq!(
        fs::read_to_string(c.pacer_home.join("state/activity.jsonl"))
            .unwrap()
            .lines()
            .count(),
        2
    );
}

#[test]
fn envelope_parser_matches_typescript_for_current_kinds() {
    let inputs = json!([
        {"type":"entity","data":{"kind":"machine","id":"machine-1","value":{"label":"Local"}}},
        {"type":"entity","data":{"kind":"plugin","id":"plug","removed":true}},
        {"type":"entity","data":{"kind":"message","id":"turn","value":{"state":"open"}}},
        {"type":"entity","data":{"kind":"liveness","id":"agent"}},
        {"type":"config","data":{"area":"strategy","at":1}},
        {"type":"config","data":{"area":"x".repeat(129),"at":1}},
        {"type":"config","data":{"area":format!("{}😀", "x".repeat(127)),"at":1}},
        {"type":"budget","data":{"generatedAt":1,"strategy":"s","planner":"p","mode":"normal","providers":[{"id":"p","verdict":"OK","usedPct":null,"pacePct":4.2,"resetsAt":null,"window":null,"stale":false}],"ranked":[]}},
        {"type":"task","data":{"id":"t","state":"running","goal":"g","executor":null,"backend":null,"worktree":null,"updatedAt":1,"progress":{"phase":"working","files":2,"commits":1,"logBytes":300,"lastOutputAt":5}}},
        {"type":"mode","data":{"mode":"normal","previous":null,"strategy":"s","at":1}},
        {"type":"alert","data":{"title":"notice","error":"YAML bad"}},
        {"type":"pause","data":{"until":null,"reason":null,"by":null}},
        {"type":"assistant","data":{"turnId":"t","conversationId":"c","state":"done"}},
        {"type":"assistant","data":{"turnId":"x".repeat(129),"conversationId":"c","state":"done"}},
        {"type":"assistant","data":{"turnId":"t","conversationId":format!("{}😀", "x".repeat(127)),"state":"done"}},
        {"type":"discovery.found","data":{"discoveryId":"abcdefghijklmnopqrstuvwxyz","name":"peer","version":"1"}},
        {"type":"entity","data":{"kind":"machine","id":""}},
        {"type":"budget","data":{"generatedAt":1}}
    ]);
    let script = r#"
import {parseOutboxEvent} from './src/link/envelope.ts';
const items=JSON.parse(process.env.TEST_INPUTS);
process.stdout.write(JSON.stringify(items.map(parseOutboxEvent)));
"#;
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .unwrap();
    let result = Command::new("bun")
        .arg("-e")
        .arg(script)
        .env("TEST_INPUTS", inputs.to_string())
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let expected: Value = serde_json::from_slice(&result.stdout).unwrap();
    let actual: Vec<Value> = inputs
        .as_array()
        .unwrap()
        .iter()
        .map(|v| parse_outbox_event(v).unwrap_or(Value::Null))
        .collect();
    assert_eq!(Value::Array(actual), expected);
}

#[test]
fn structured_publication_parser_cases_match_bun() {
    let templates = [
        json!({"type":"entity","data":{"kind":"activity","id":"e","value":{},"removed":false}}),
        json!({"type":"pause","data":{"until":1,"reason":"r","by":"b"}}),
        json!({"type":"config","data":{"area":"a","at":1}}),
        json!({"type":"budget","data":{"generatedAt":1,"strategy":"s","planner":"p","mode":"m","providers":[{"id":"p","verdict":"OK","agent":"a","account":"x","usedPct":1,"pacePct":2,"resetsAt":3,"window":"w","stale":true,"brokenReason":"b","blockedReason":"b","blockedUntil":4}],"ranked":[{"id":"p","verdict":"OK"}]}}),
        json!({"type":"task","data":{"id":"t","state":"running","updatedAt":1,"title":"title","goal":"goal","executor":"x","backend":"b","worktree":"w","interactionMode":"conversation","conversation":{"activity":"working","agentSessionId":"s","endReason":"user"},"placement":{"mode":"current","why":"w"},"stopPending":{"attempt":1,"requestedAt":1,"providerId":"p","graceMs":1},"session":{"host":"builtin","live":true,"controller":"c","viewers":2},"terminalPresent":true,"resolved":"r","reviewRequest":{"note":"n","at":1},"acceptanceState":"passed","review":{"accepted":true,"kind":"k","note":"n","at":1},"dismissed":true,"retriedBy":"r","retryOf":"r","brokenExecutor":"b","brokenReason":"b","attemptStartedAt":1,"progress":{"phase":"working","lastOutputAt":1,"files":1,"commits":1,"logBytes":1},"runnerAlive":true}}),
        json!({"type":"mode","data":{"mode":"normal","previous":"old","strategy":"s","at":1}}),
        json!({"type":"alert","data":{"key":"k","level":"info","title":"t","body":"b","at":1,"error":"e","notification":{"kind":"failed","fromPanel":true,"near":true,"executor":"x","goal":"g","nextExecutor":"n","strategy":"s","resetsAt":1}}}),
        json!({"type":"assistant","data":{"turnId":"t","conversationId":"c","state":"done"}}),
        json!({"type":"discovery.found","data":{"discoveryId":"abcdefghijklmnopqrstuvwxyz","name":"n","version":"v"}}),
    ];
    let mut inputs: Vec<Value> = templates.to_vec();
    let variants = [
        Value::Null,
        json!(false),
        json!(0),
        json!(-1),
        json!(0.5),
        json!(""),
        json!("x"),
        json!([]),
        json!({}),
        json!("x".repeat(129)),
        json!("x".repeat(1001)),
        json!("😀".repeat(65)),
    ];
    let paths: [&[&str]; 9] = [
        &["/data/kind", "/data/id", "/data/removed"],
        &["/data/until", "/data/reason", "/data/by", "/data/removed"],
        &["/data/area", "/data/at"],
        &[
            "/data/generatedAt",
            "/data/strategy",
            "/data/planner",
            "/data/mode",
            "/data/providers/0/id",
            "/data/providers/0/verdict",
            "/data/providers/0/agent",
            "/data/providers/0/account",
            "/data/providers/0/usedPct",
            "/data/providers/0/pacePct",
            "/data/providers/0/resetsAt",
            "/data/providers/0/window",
            "/data/providers/0/stale",
            "/data/providers/0/brokenReason",
            "/data/providers/0/blockedReason",
            "/data/providers/0/blockedUntil",
            "/data/ranked/0/id",
            "/data/ranked/0/verdict",
        ],
        &[
            "/data/id",
            "/data/state",
            "/data/updatedAt",
            "/data/title",
            "/data/goal",
            "/data/executor",
            "/data/backend",
            "/data/worktree",
            "/data/interactionMode",
            "/data/conversation/activity",
            "/data/conversation/agentSessionId",
            "/data/conversation/endReason",
            "/data/placement/mode",
            "/data/placement/why",
            "/data/stopPending/attempt",
            "/data/stopPending/requestedAt",
            "/data/stopPending/providerId",
            "/data/stopPending/graceMs",
            "/data/session/host",
            "/data/session/live",
            "/data/session/controller",
            "/data/session/viewers",
            "/data/terminalPresent",
            "/data/resolved",
            "/data/reviewRequest/note",
            "/data/reviewRequest/at",
            "/data/acceptanceState",
            "/data/review/accepted",
            "/data/review/kind",
            "/data/review/note",
            "/data/review/at",
            "/data/dismissed",
            "/data/retriedBy",
            "/data/retryOf",
            "/data/brokenExecutor",
            "/data/brokenReason",
            "/data/attemptStartedAt",
            "/data/progress/phase",
            "/data/progress/lastOutputAt",
            "/data/progress/files",
            "/data/progress/commits",
            "/data/progress/logBytes",
            "/data/runnerAlive",
        ],
        &["/data/mode", "/data/previous", "/data/strategy", "/data/at"],
        &[
            "/data/key",
            "/data/level",
            "/data/title",
            "/data/body",
            "/data/at",
            "/data/error",
            "/data/notification/kind",
            "/data/notification/fromPanel",
            "/data/notification/near",
            "/data/notification/executor",
            "/data/notification/goal",
            "/data/notification/nextExecutor",
            "/data/notification/strategy",
            "/data/notification/resetsAt",
        ],
        &["/data/turnId", "/data/conversationId", "/data/state"],
        &["/data/discoveryId", "/data/name", "/data/version"],
    ];
    for (template, fields) in templates.iter().zip(paths) {
        for field in fields {
            for variant in &variants {
                let mut input = template.clone();
                if let Some(slot) = input.pointer_mut(field) {
                    *slot = variant.clone();
                } else {
                    let (parent, key) = field.rsplit_once('/').unwrap();
                    input
                        .pointer_mut(parent)
                        .unwrap()
                        .as_object_mut()
                        .unwrap()
                        .insert(key.to_owned(), variant.clone());
                }
                inputs.push(input);
            }
        }
    }
    let mut seed = 0x553_u64;
    for _ in 0..128 {
        seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
        let template_index = (seed as usize) % templates.len();
        let mut input = templates[template_index].clone();
        for _ in 0..2 {
            seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
            let field = paths[template_index][(seed as usize) % paths[template_index].len()];
            seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
            let variant = variants[(seed as usize) % variants.len()].clone();
            if let Some(slot) = input.pointer_mut(field) {
                *slot = variant;
            } else {
                let (parent, key) = field.rsplit_once('/').unwrap();
                input
                    .pointer_mut(parent)
                    .unwrap()
                    .as_object_mut()
                    .unwrap()
                    .insert(key.to_owned(), variant);
            }
        }
        inputs.push(input);
    }
    for count in [31, 32, 33] {
        let mut budget = templates[3].clone();
        budget["data"]["providers"] = Value::Array(vec![json!({"id":"p","verdict":"OK"}); count]);
        budget["data"]["ranked"] = Value::Array(vec![json!({"id":"p","verdict":"OK"}); count]);
        inputs.push(budget);
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .unwrap();
    let temp = tempfile::tempdir().unwrap();
    let input_file = temp.path().join("inputs.json");
    fs::write(&input_file, Value::Array(inputs.clone()).to_string()).unwrap();
    let result = Command::new("bun").arg("-e").arg("import {readFileSync} from 'node:fs'; import {parseOutboxEvent} from './src/link/envelope.ts'; process.stdout.write(JSON.stringify(JSON.parse(readFileSync(process.env.TEST_INPUT_FILE,'utf8')).map(parseOutboxEvent)));" )
        .env("TEST_INPUT_FILE", input_file).current_dir(root).output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let expected: Vec<Value> = serde_json::from_slice(&result.stdout).unwrap();
    for (index, (input, wanted)) in inputs.iter().zip(expected.iter()).enumerate() {
        let actual = parse_outbox_event(input).unwrap_or(Value::Null);
        assert_eq!(&actual, wanted, "case {index}: {input}");
    }
}

#[test]
fn outbox_rotation_and_torn_lines() {
    let tmp = tempfile::tempdir().unwrap();
    let c = ctx(tmp.path());
    let rows: Vec<Value> = (1..=1010).map(|seq| json!({"seq":seq,"envelope":{"type":"entity","data":{"kind":"message","id":format!("m{seq}")}}})).collect();
    append_outbox(&c, &rows).unwrap();
    assert_eq!(
        fs::read_to_string(c.pacer_home.join("link/outbox.jsonl"))
            .unwrap()
            .lines()
            .count(),
        1000
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(c.pacer_home.join("link/outbox.jsonl"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    fs::OpenOptions::new()
        .append(true)
        .open(c.pacer_home.join("link/outbox.jsonl"))
        .unwrap()
        .write_all(b"\xff{torn\n")
        .unwrap();
    let read = read_outbox_since(&c, 1008.0).unwrap();
    assert_eq!(
        read.iter()
            .map(|v| v["seq"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        vec![1009, 1010]
    );
}

#[test]
fn machine_stamped_activity_and_redaction_match_bun() {
    let rust = tempfile::tempdir().unwrap();
    let ts = tempfile::tempdir().unwrap();
    for home in [rust.path(), ts.path()] {
        let dir = home.join(".pacer/identity");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("machine.json"), r#"{"publicId":"machine-id"}"#).unwrap();
    }
    let c = ctx(rust.path());
    let entry = append_activity(
        &c,
        json!({"kind":"plugin_state","level":"warn","text":format!("Bearer secret-token user{}", "@example.test")}),
    )
    .unwrap();
    assert_eq!(entry["machineId"], "machine-id");
    bun(
        ts.path(),
        r#"
import {appendActivity} from './src/activity/log.ts';
const c={home:process.env.TEST_HOME,pacerHome:process.env.TEST_HOME+'/.pacer',now:1760000000,env:{}};
appendActivity(c,{kind:'plugin_state',level:'warn',text:'Bearer secret-token user'+'@example.test'});
"#,
    );
    let id = Regex::new(r"1760000000-[0-9a-f]{4}").unwrap();
    for file in ["state/activity.jsonl", "link/outbox.jsonl"] {
        let actual = fs::read_to_string(c.pacer_home.join(file)).unwrap();
        let expected = fs::read_to_string(ts.path().join(".pacer").join(file)).unwrap();
        assert_eq!(
            id.replace_all(&actual, "fixed"),
            id.replace_all(&expected, "fixed"),
            "{file}"
        );
    }
}

#[test]
fn activity_rotation_keeps_recent_twenty_thousand() {
    let tmp = tempfile::tempdir().unwrap();
    let c = ctx(tmp.path());
    let dir = c.pacer_home.join("state");
    fs::create_dir_all(&dir).unwrap();
    let mut lines = format!(
        "{{\"id\":\"old\",\"at\":{},\"kind\":\"config\",\"level\":\"info\",\"text\":\"old\"}}\n",
        c.now - 30.0 * 86400.0 - 1.0
    );
    for i in 0..20_050 {
        lines.push_str(&format!("{{\"id\":\"{i}\",\"at\":{},\"kind\":\"config\",\"level\":\"info\",\"text\":\"{i}\"}}\n", c.now));
    }
    fs::write(dir.join("activity.jsonl"), lines).unwrap();
    rotate_activity(&c).unwrap();
    let retained = read_activity(
        &c,
        &ActivityOptions {
            limit: Some(500),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(retained.entries.len(), 500);
    let text = fs::read_to_string(dir.join("activity.jsonl")).unwrap();
    assert_eq!(text.lines().count(), 20_000);
    assert!(text.lines().next().unwrap().contains("\"text\":\"50\""));
    assert!(text.lines().last().unwrap().contains("\"text\":\"20049\""));
}

#[test]
fn snapshot_parser_matches_bun_normalization() {
    let mut inputs = json!([
        {"v":1,"seq":2,"at":100,"serviceInstalled":true,"tasks":[{"id":"t","state":"running","updatedAt":1,"goal":"g","executor":"codex","backend":null,"worktree":null}],"alerts":[{"title":"hello","error":"bad"}],"console":{"pid":12,"startedAt":90,"heartbeatAt":99,"handle":"h","paneKey":null},"strategies":["default",{"name":"alt","active":true,"summary":"s","description":"d"}],"unknown":"discard"},
        {"v":1,"seq":5,"at":10,"budget":{"generatedAt":1,"strategy":"s","planner":"p","mode":"normal"},"mode":{"mode":"normal","strategy":"s","at":1}},
        {"v":1,"seq":0,"at":0,"strategies":["😀".repeat(65),format!("{}😀", "x".repeat(127))]},
        {"v":1,"seq":-1,"at":1},
        {"v":1,"seq":0.5,"at":1},
        {"v":1,"seq":9007199254740992_u64,"at":1},
        {"v":1,"seq":1.0,"at":1},
        {"v":1,"seq":-0.0,"at":1},
        {"v":2,"seq":1,"at":1},
        {"v":1,"seq":"bad","at":1}
    ]);
    let full = json!({"v":1,"seq":1,"at":1,"serviceInstalled":true,"budget":{"generatedAt":1,"strategy":"s","planner":"p","mode":"m","providers":[],"ranked":[]},"mode":{"mode":"m","strategy":"s","at":1},"tasks":[{"id":"t","state":"running","updatedAt":1}],"alerts":[{"key":"a","title":"t","body":"b","at":1}],"console":{"pid":1,"startedAt":1,"heartbeatAt":1},"consoles":[{"pid":1,"startedAt":1,"heartbeatAt":1}],"strategies":[{"name":"s","active":true,"summary":"x","description":"d"}]});
    let variants = [
        Value::Null,
        json!(false),
        json!(-1),
        json!(0.5),
        json!(""),
        json!("x"),
        json!([]),
        json!({}),
        json!("x".repeat(1001)),
    ];
    for field in [
        "/v",
        "/seq",
        "/at",
        "/serviceInstalled",
        "/budget/generatedAt",
        "/budget/strategy",
        "/budget/planner",
        "/budget/mode",
        "/mode/mode",
        "/mode/strategy",
        "/mode/at",
        "/tasks/0/id",
        "/tasks/0/state",
        "/tasks/0/updatedAt",
        "/alerts/0/title",
        "/console/pid",
        "/console/startedAt",
        "/console/heartbeatAt",
        "/consoles/0/pid",
        "/strategies/0/name",
        "/strategies/0/summary",
        "/strategies/0/description",
    ] {
        for variant in &variants {
            let mut input = full.clone();
            *input.pointer_mut(field).unwrap() = variant.clone();
            inputs.as_array_mut().unwrap().push(input);
        }
    }
    for (field, boundary) in [
        ("tasks", 20),
        ("alerts", 10),
        ("consoles", 32),
        ("strategies", 32),
    ] {
        for count in [boundary - 1, boundary, boundary + 1] {
            let mut input = full.clone();
            let item = full[field][0].clone();
            input[field] = Value::Array(vec![item; count]);
            inputs.as_array_mut().unwrap().push(input);
        }
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .unwrap();
    let result = Command::new("bun")
        .arg("-e")
        .arg(
            r#"
import {parseSnapshot} from './src/link/envelope.ts';
process.stdout.write(JSON.stringify(JSON.parse(process.env.TEST_INPUTS).map(parseSnapshot)));
"#,
        )
        .env("TEST_INPUTS", inputs.to_string())
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let expected: Value = serde_json::from_slice(&result.stdout).unwrap();
    let actual = Value::Array(
        inputs
            .as_array()
            .unwrap()
            .iter()
            .map(|v| parse_snapshot(v).unwrap_or(Value::Null))
            .collect(),
    );
    assert_eq!(actual, expected);
    for index in 3..6 {
        assert!(actual[index].is_null(), "invalid sequence case {index}");
    }
}

#[test]
fn reducer_and_jsonl_match_bun_for_snapshot_events() {
    let rust = tempfile::tempdir().unwrap();
    let ts = tempfile::tempdir().unwrap();
    let c = ctx(rust.path());
    let events = json!([
        {"type":"budget","data":{"generatedAt":1,"strategy":"default","planner":"codex","mode":"normal","providers":[],"ranked":[]}},
        {"type":"task","data":{"id":"t1","state":"running","goal":"g","executor":"codex","backend":null,"worktree":null,"updatedAt":2}},
        {"type":"mode","data":{"mode":"normal","previous":null,"strategy":"default","at":1}},
        {"type":"alert","data":{"key":"a","level":"info","title":"hi","body":"there","at":1}}
    ]);
    assert_eq!(publish(&c, events.as_array().unwrap()).seq, 4);
    bun(
        ts.path(),
        r#"
import {publish} from './src/link/publish.ts';
const c={home:process.env.TEST_HOME,pacerHome:process.env.TEST_HOME+'/.pacer',now:1760000000,env:{}};
await publish(c,[
 {type:'budget',data:{generatedAt:1,strategy:'default',planner:'codex',mode:'normal',providers:[],ranked:[]}},
 {type:'task',data:{id:'t1',state:'running',goal:'g',executor:'codex',backend:null,worktree:null,updatedAt:2}},
 {type:'mode',data:{mode:'normal',previous:null,strategy:'default',at:1}},
 {type:'alert',data:{key:'a',level:'info',title:'hi',body:'there',at:1}}
]);
"#,
    );
    for file in ["link/latest.json", "link/outbox.jsonl"] {
        assert_eq!(
            fs::read(c.pacer_home.join(file)).unwrap(),
            fs::read(ts.path().join(".pacer").join(file)).unwrap(),
            "{file}"
        );
    }
}
