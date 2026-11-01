#![allow(clippy::unwrap_used, clippy::expect_used)]
use pacer_foundation::Ctx;
use pacer_store::outbox::{append_outbox, parse_outbox_event, parse_snapshot};
use pacer_store::{
    ActivityOptions, append_activity, publish, publish_config_change, read_activity,
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
    let rust_log = fs::read_to_string(c.pacer_home.join("state/activity.jsonl")).unwrap();
    let ts_log = fs::read_to_string(ts.path().join(".pacer/state/activity.jsonl")).unwrap();
    let mut a: Value = serde_json::from_str(rust_log.trim()).unwrap();
    let mut b: Value = serde_json::from_str(ts_log.trim()).unwrap();
    a["id"] = json!("fixed");
    b["id"] = json!("fixed");
    assert_eq!(a, b);
    assert_eq!(read_outbox_since(&c, 0.0).unwrap().len(), 2);
}

#[cfg(unix)]
#[test]
fn publication_modes_match_bun_without_chmodding_existing_link_dir() {
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
    for path in ["link", "link/outbox.jsonl", "link/latest.json"] {
        let mode = |root: &Path| {
            fs::metadata(root.join(".pacer").join(path))
                .unwrap()
                .permissions()
                .mode()
                & 0o777
        };
        assert_eq!(mode(rust.path()), mode(ts.path()), "{path}");
    }
    let link = ts.path().join(".pacer/link");
    let original = fs::metadata(&link).unwrap().permissions().mode() & 0o777;
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
        original
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
        {"type":"budget","data":{"generatedAt":1,"strategy":"s","planner":"p","mode":"normal","providers":[{"id":"p","verdict":"OK","usedPct":null,"pacePct":4.2,"resetsAt":null,"window":null,"stale":false}],"ranked":[]}},
        {"type":"task","data":{"id":"t","state":"running","goal":"g","executor":null,"backend":null,"worktree":null,"updatedAt":1,"progress":{"phase":"working","files":2,"commits":1,"logBytes":300,"lastOutputAt":5}}},
        {"type":"mode","data":{"mode":"normal","previous":null,"strategy":"s","at":1}},
        {"type":"alert","data":{"title":"notice","error":"YAML bad"}},
        {"type":"pause","data":{"until":null,"reason":null,"by":null}},
        {"type":"assistant","data":{"turnId":"t","conversationId":"c","state":"done"}},
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
    let inputs = json!([
        {"v":1,"seq":2,"at":100,"serviceInstalled":true,"tasks":[{"id":"t","state":"running","updatedAt":1,"goal":"g","executor":"codex","backend":null,"worktree":null}],"alerts":[{"title":"hello","error":"bad"}],"console":{"pid":12,"startedAt":90,"heartbeatAt":99,"handle":"h","paneKey":null},"strategies":["default",{"name":"alt","active":true,"summary":"s","description":"d"}],"unknown":"discard"},
        {"v":1,"seq":5,"at":10,"budget":{"generatedAt":1,"strategy":"s","planner":"p","mode":"normal"},"mode":{"mode":"normal","strategy":"s","at":1}},
        {"v":2,"seq":1,"at":1},
        {"v":1,"seq":"bad","at":1}
    ]);
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
