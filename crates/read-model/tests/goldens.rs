#![allow(clippy::unwrap_used)]
use pacer_foundation::{Ctx, fsutil::write_json_atomic};
use pacer_read_model::{Probes, ReadModel, SnapshotInput, StatusInput, js::*};
use serde_json::Value;
use std::{collections::HashMap, fs};
fn normalized(v: &Value, home: &str) -> String {
    let mut s = stringify(v).replace(home, "$HOME");
    let name = std::path::Path::new(home)
        .file_name()
        .unwrap()
        .to_str()
        .unwrap();
    s = s.replace(name, "FIXTURE_HOME");
    let re = regex::Regex::new("local:[0-9a-f]{12}").unwrap();
    re.replace_all(&s, "local:FIXTURE").into_owned()
}
#[test]
fn complete_typescript_snapshots_from_sqlite_and_old_release_homes() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/read-model/rust-cases.json"
    ))
    .unwrap();
    let root = tempfile::tempdir().unwrap();
    let mut model = ReadModel::new();
    for case in cases.as_array().unwrap() {
        let home = root.path().join(format!("fixture-{}", case["group"]));
        fs::create_dir_all(&home).unwrap();
        let home = fs::canonicalize(home).unwrap();
        let home = home.to_str().unwrap();
        let input: Value =
            serde_json::from_str(&stringify(&case["input"]).replace("$HOME", home)).unwrap();
        let ctx = Ctx::with(
            home.into(),
            input["pacerHome"].as_str().unwrap().into(),
            HashMap::new(),
            num(&input["now"]),
        );
        for (path, contents) in case["files"].as_object().unwrap() {
            let path = ctx.pacer_home.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents.as_str().unwrap().replace("$HOME", home)).unwrap();
        }
        for t in array(&case["tasks"]) {
            let t: Value = serde_json::from_str(&stringify(t).replace("$HOME", home)).unwrap();
            write_json_atomic(
                &ctx.pacer_home
                    .join("tasks")
                    .join(format!("{}.json", text(&t["id"]))),
                &t,
            )
            .unwrap();
        }
        let db = model.store(&ctx).unwrap().connection().unwrap();
        db.execute_batch("CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,task_id TEXT,root_id TEXT,sender TEXT,recipient TEXT,kind TEXT,body TEXT,reply_to TEXT,request_id TEXT,status TEXT,created_at REAL,delivered_at REAL,read_at REAL,turn_id TEXT,fingerprint TEXT); CREATE TABLE IF NOT EXISTS msg_liveness(node TEXT PRIMARY KEY,reason TEXT,since REAL,attempts INTEGER,nudges INTEGER,next_at REAL,progress_mark TEXT,stalled_at REAL,escalated_at REAL,hook_set TEXT,hook_blocks INTEGER);").unwrap();
        for (table, rows) in case["tables"].as_object().unwrap() {
            db.execute(&format!("DELETE FROM {table}"), []).unwrap();
            for row in rows.as_array().unwrap() {
                let fields = row.as_object().unwrap();
                let columns = fields.keys().cloned().collect::<Vec<_>>().join(",");
                let marks = vec!["?"; fields.len()].join(",");
                let values: Vec<rusqlite::types::Value> = fields
                    .values()
                    .map(|v| match v {
                        Value::Null => rusqlite::types::Value::Null,
                        Value::Number(_) => rusqlite::types::Value::Real(num(v)),
                        Value::String(s) => rusqlite::types::Value::Text(s.clone()),
                        _ => panic!("unexpected fixture cell"),
                    })
                    .collect();
                db.execute(
                    &format!("INSERT INTO {table}({columns}) VALUES({marks})"),
                    rusqlite::params_from_iter(values),
                )
                .unwrap();
            }
        }
        let p = Probes {
            setup: input["setup"].clone(),
            policy: input["policy"].clone(),
            machine: input["machine"].clone(),
            service: input["service"].clone(),
            desktop_updates: vec![],
            service_installed: false,
            can_pair: false,
        };
        let status = if input["useCache"] == true {
            StatusInput::Cached
        } else if let Some(error) = input["statusError"].as_str() {
            StatusInput::Failure(error.into())
        } else {
            StatusInput::Provided(input["status"].clone())
        };
        let result = model
            .snapshot(
                &ctx,
                SnapshotInput::new(&p, status),
                chrono_tz::Asia::Ho_Chi_Minh,
                &|pid| pid == 0,
            )
            .unwrap();
        let wire = result.wire(input["protocol"].as_u64().unwrap() as u8);
        assert_eq!(
            result.json(input["protocol"].as_u64().unwrap() as u8),
            stringify(&wire)
        );
        assert_eq!(
            normalized(&wire, home),
            stringify(&case["expected"]),
            "case group={}, now={}, protocol={}",
            case["group"],
            input["now"],
            input["protocol"]
        );
    }
    // These stored cases complement the unchanged #570 golden, whose fixture driver
    // also compares each TS and Rust snapshot byte for byte before asserting it.
    assert_eq!(array(&cases).len(), 11);
}
