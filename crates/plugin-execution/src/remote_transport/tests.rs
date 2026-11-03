#![allow(clippy::unwrap_used)]
use super::start::{self, Issue};
use serde_json::{Map, Value, json};

const ID: &str = "t-20261103-074231-96bf";
const NONCE: &str = "6f1c0d2e-4b5a-4c3d-8e9f-0a1b2c3d4e5f";
const HOST: &str = r#"{"alias":"box","ssh":"fixture-host","repos":{},"maxTasks":2,"accounts":{},"session":"recording","paused":false}"#;

struct Row {
    remote: String,
    workdir: String,
    env: Map<String, Value>,
    argv: Vec<Value>,
    stdin: String,
    attempt: Value,
    id: String,
    host: String,
}
impl Row {
    fn new() -> Self {
        Self {
            remote: format!("/remote/.pacer-remote/runs/{ID}/1"),
            workdir: "/remote/work".into(),
            env: Map::new(),
            argv: vec![json!("agent")],
            stdin: String::new(),
            attempt: json!(1),
            id: ID.into(),
            host: HOST.into(),
        }
    }
    /// Seeds `run` consistently with the issued remoteDir/workdir (finding F1).
    fn issue(&self) -> Result<(), pacer_plugin_capabilities::BrokerError> {
        let local = format!("/home/runs/{}/1", self.id);
        let run = json!({"host":"box","mode":"new","remoteDir":self.remote,"dir":local,
            "workdir":self.workdir,"attempt":self.attempt});
        let args = start::compose(
            &self.remote,
            &self.workdir,
            Some(&self.env),
            &self.id,
            NONCE,
            &self.argv,
        )?;
        let input = start::input(&self.stdin);
        start::issue(
            &Issue {
                alias: "box",
                id: &self.id,
                remote_dir: &self.remote,
                local_dir: &local,
                run: &run,
                args: &args,
                input: &input,
            },
            &self.host,
        )
    }
    fn ok(&self) -> bool {
        self.issue().is_ok()
    }
}
fn env(n: usize) -> Map<String, Value> {
    (0..n).map(|i| (format!("K{i}"), json!("v"))).collect()
}

#[test]
fn node_normalized_matches_node_posix_normalize_identity() {
    for (path, want) in [
        ("/", true),
        ("/a/b", true),
        ("/a/b/", true),
        ("/...", true),
        ("/a//b", false),
        ("//a", false),
        ("/a/./b", false),
        ("/a/../b", false),
        ("/.", false),
        ("/a//", false),
        ("/a/..", false),
    ] {
        assert_eq!(start::node_normalized(path), want, "{path}");
    }
}

#[test]
fn session_blocker_id_and_operation_label_vectors() {
    assert_eq!(
        start::session_blocker_id("box", "/remote/.pacer-remote/runs/t-20261103-074231-96bf/1"),
        "2dc239cf64542dc30c314a40e7d4273f6f68002c2621651b4ad17acf19d083fc"
    );
    assert_eq!(
        start::session_blocker_id(
            "box",
            "/r/\u{1F600}/.pacer-remote/runs/t-20261103-074231-96bf/1"
        ),
        "6557d2b2757c51eddeb1ee955ef25c9ab1498798e02cc177bf73a3f29bc51993"
    );
    assert_eq!(start::operation_label("PREPARE").unwrap(), "prepare");
    assert_eq!(start::operation_label("START").unwrap(), "start");
    assert_eq!(start::operation_label("STOP").unwrap(), "stop");
    for name in ["PREPARE_RECOVER", "REPORT", "start", ""] {
        assert!(start::operation_label(name).is_err(), "{name}");
    }
    assert!(start::env_key("_A1") && start::env_key("a"));
    for key in ["1A", "A-B", "", "A=B", "\u{e9}"] {
        assert!(!start::env_key(key), "{key}");
    }
}

#[test]
fn remote_dir_parts_follow_the_js_regex_oracle() {
    let tail = format!("/.pacer-remote/runs/{ID}/1");
    // regex-oracle.out.json remoteDirRows.
    for (prefix, want) in [
        ("/remote", true),
        ("/re\rmote", false),
        ("/re\u{85}mote", true),
        ("/re\u{2028}mote", false),
        ("/re\u{2029}mote", false),
    ] {
        assert_eq!(
            start::remote_dir_parts(&format!("{prefix}{tail}")).is_some(),
            want,
            "{prefix:?}"
        );
    }
    // digits: Arabic-Indic date, full-width time and upper-case hex are rejected.
    for id in [
        "t-\u{662}\u{660}\u{662}\u{666}\u{661}\u{661}\u{660}\u{663}-074231-96bf",
        "t-20261103-\u{ff10}\u{ff17}\u{ff14}\u{ff12}\u{ff13}\u{ff11}-96bf",
        "t-20261103-074231-96BF",
    ] {
        assert!(start::remote_dir_parts(&format!("/r/.pacer-remote/runs/{id}/1")).is_none());
    }
    for (attempt, want) in [
        ("0", false),
        ("01", false),
        ("\u{ff11}", false),
        ("\u{661}", false),
        ("1", true),
        ("10", true),
    ] {
        assert_eq!(
            start::remote_dir_parts(&format!("/r/.pacer-remote/runs/{ID}/{attempt}")).is_some(),
            want,
            "{attempt}"
        );
    }
    let dir = format!("/a/b{tail}");
    assert_eq!(start::remote_dir_parts(&dir).unwrap(), ("/a/b", ID, "1"));
}

#[test]
fn trusted_direct_non_ascii_task_id_is_rejected_by_the_pattern() {
    let mut row = Row::new();
    row.id = "t-\u{662}\u{660}\u{662}\u{666}\u{661}\u{661}\u{660}\u{663}-074231-96bf".into();
    row.remote = format!("/remote/.pacer-remote/runs/{}/1", row.id);
    assert!(!row.ok());
}

#[test]
fn issue_matches_the_r6_matrix() {
    assert!(Row::new().ok());
    // Count.
    let counted = |n_env: usize, n_argv: usize| {
        let mut row = Row::new();
        row.env = env(n_env);
        row.argv = (0..n_argv).map(|i| json!(format!("a{i}"))).collect();
        row.ok()
    };
    assert!(counted(0, 1));
    assert!(counted(10, 8));
    assert!(!counted(10, 9));
    assert!(!counted(0, 0));
    // Per-arg UTF-16.
    let arg = |a: String| {
        let mut row = Row::new();
        row.argv = vec![json!(a)];
        row.ok()
    };
    assert!(arg("a".repeat(1024)));
    assert!(!arg("a".repeat(1025)));
    assert!(arg("\u{1F600}".repeat(512)));
    assert!(!arg("\u{1F600}".repeat(513)));
    assert!(arg("\u{e9}".repeat(1024)));
    let value = |v: String| {
        let mut row = Row::new();
        row.env = Map::from_iter([("K".to_owned(), json!(v))]);
        row.ok()
    };
    assert!(value("v".repeat(1022)));
    assert!(!value("v".repeat(1023)));
    // Controls; separators and U+0080/U+FEFF are ordinary argv text (argvRows).
    for c in ['\0', '\t', '\n', '\u{1f}', '\u{7f}'] {
        assert!(!arg(format!("a{c}b")), "{c:?}");
        assert!(!value(format!("a{c}b")), "{c:?}");
    }
    for c in ['\u{80}', '\u{85}', '\u{2028}', '\u{2029}', '\u{feff}'] {
        assert!(arg(format!("a{c}b")), "{c:?}");
    }
    // remoteDir, seeded consistently.
    let remote = |r: String, attempt: Value| {
        let mut row = Row::new();
        row.remote = r;
        row.attempt = attempt;
        row.ok()
    };
    let tail = |id: &str, n: &str| format!("/.pacer-remote/runs/{id}/{n}");
    assert!(!remote(
        format!("/remote{}", tail("t-20261103-074231-96be", "1")),
        json!(1)
    ));
    assert!(!remote(format!("/remote{}", tail(ID, "01")), json!(1)));
    assert!(!remote(format!("/remote{}", tail(ID, "2")), json!(1)));
    assert!(!remote(format!("/remote{}", tail(ID, "1")), json!(1.5)));
    assert!(!remote(
        format!("/remote{}", tail(ID, "9007199254740993")),
        json!(9007199254740993u64)
    ));
    assert!(remote(format!("/remote{}", tail(ID, "2")), json!(2)));
    for prefix in [
        "/re\tmote",
        "/re\rmote",
        "/re\u{2028}mote",
        "/re\u{2029}mote",
        "/x/",
    ] {
        assert!(
            !remote(format!("{prefix}{}", tail(ID, "1")), json!(1)),
            "{prefix:?}"
        );
    }
    assert!(remote(format!("/re\u{85}mote{}", tail(ID, "1")), json!(1)));
    // workdir.
    let workdir = |w: &str| {
        let mut row = Row::new();
        row.workdir = w.into();
        row.ok()
    };
    assert!(!workdir("/a//b"));
    assert!(!workdir("relative"));
    assert!(workdir("/a/b/"));
    assert!(workdir("/a\u{2028}b"));
    assert!(workdir("/a\u{2029}b"));
    // Input bound includes the wrapper and the 16-byte stdin marker.
    let stdin = |n: usize| {
        let mut row = Row::new();
        row.stdin = "s".repeat(n);
        row.ok()
    };
    let room = start::MAX_START_INPUT - include_str!("../native_run/wrapper.sh").len() - 16;
    assert_eq!(
        start::input(&"s".repeat(room)).len(),
        start::MAX_START_INPUT
    );
    assert!(stdin(room));
    assert!(!stdin(room + 1));
    // Current host at issuance.
    let host = |h: Value| {
        let mut row = Row::new();
        row.host = h.to_string();
        row.ok()
    };
    let base: Value = serde_json::from_str(HOST).unwrap();
    let mut paused = base.clone();
    paused["paused"] = json!(true);
    let mut full = base.clone();
    full["session"] = json!("full");
    let mut absent = base.clone();
    absent.as_object_mut().unwrap().remove("session");
    assert!(!host(paused));
    assert!(!host(full));
    assert!(host(absent));
    assert!(!host(json!("text")));
}

#[test]
fn issue_rejects_direct_args_that_bypass_composition() {
    let row = Row::new();
    let local = format!("/home/runs/{ID}/1");
    let run = json!({"host":"box","mode":"new","remoteDir":row.remote,"dir":local,
        "workdir":row.workdir,"attempt":1});
    let good = start::compose(&row.remote, &row.workdir, None, ID, NONCE, &row.argv).unwrap();
    let input = start::input("");
    let check = |args: &[String], input: &[u8], run: &Value| {
        start::issue(
            &Issue {
                alias: "box",
                id: ID,
                remote_dir: &row.remote,
                local_dir: &local,
                run,
                args,
                input,
            },
            HOST,
        )
        .is_ok()
    };
    assert!(check(&good, &input, &run));
    let mutate = |f: &dyn Fn(&mut Vec<String>)| {
        let mut args = good.clone();
        f(&mut args);
        check(&args, &input, &run)
    };
    assert!(!mutate(&|a| a[2] = "full".into()));
    assert!(!mutate(&|a| a[2] = "tty".into()));
    assert!(!mutate(&|a| a[0] = "/other".into()));
    assert!(!mutate(&|a| a[3] = "1A=x".into()));
    assert!(!mutate(&|a| {
        a.pop();
    }));
    assert!(!mutate(&|a| a[1] = "/elsewhere".into()));
    assert!(!check(&good, b"no marker", &run));
    assert!(!check(&good, b"", &run));
    let mut other = run.clone();
    other["mode"] = json!("resume");
    assert!(!check(&good, &input, &other));
    let mut other = run.clone();
    other["host"] = json!("other");
    assert!(!check(&good, &input, &other));
    let mut other = run;
    other["dir"] = json!("/home/runs/elsewhere/1");
    assert!(!check(&good, &input, &other));
}

#[test]
fn compose_keeps_existing_order_and_string_checks() {
    let env = Map::from_iter([("A".to_owned(), json!("1")), ("B".to_owned(), json!("2"))]);
    assert_eq!(
        start::compose("/r", "/w", Some(&env), ID, NONCE, &[json!("x"), json!("y")]).unwrap(),
        [
            "/r",
            "/w",
            "pipe",
            "A=1",
            "B=2",
            "PACER_ROLE=executor",
            &format!("PACER_TASK_ID={ID}"),
            &format!("PACER_COMPLETION_NONCE={NONCE}"),
            "--",
            "x",
            "y"
        ]
    );
    let bad = Map::from_iter([("A".to_owned(), json!(7))]);
    assert!(start::compose("/r", "/w", Some(&bad), ID, NONCE, &[json!("x")]).is_err());
    assert!(start::compose("/r", "/w", None, ID, NONCE, &[json!(7)]).is_err());
}
