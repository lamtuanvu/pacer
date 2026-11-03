#![allow(clippy::unwrap_used)]
use super::super::*;
use std::{fs, os::unix::fs::PermissionsExt, time::Duration};

const TASK: &str = "t-20261102-175253-93d8";
fn fixture() -> (PathBuf, OrcaAttempt) {
    let home = std::env::temp_dir().join(format!("pacer-orca-paths-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&home).unwrap();
    fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
    TaskStore::open(&home).unwrap().insert(&json!({"id":TASK,"rev":1,"createdAt":1,"state":"running","attempts":[],"brief":{"repo":home},"timeoutS":0}), 1.0).unwrap();
    let spec = OrcaAttemptSpec {
        executor: "codex#work@host".into(),
        agent: "codex".into(),
        model: None,
        coordinator: "coordinator".into(),
        run: "run".into(),
        top: home.to_str().unwrap().into(),
        base: "HEAD".into(),
        sub: String::new(),
        placement: OrcaPlacement::Existing {
            path: home.to_str().unwrap().into(),
        },
        notes: vec![],
        prompt: "task".into(),
        launch: vec!["codex".into()],
        account_env: HashMap::new(),
    };
    let attempt = OrcaAttempt::issue(
        &home,
        TASK,
        spec,
        "/usr/bin/true",
        HashMap::new(),
        Instant::now() + Duration::from_secs(5),
    )
    .unwrap();
    (home, attempt)
}
fn unsafe_ids() -> Vec<String> {
    [
        "",
        "../../orca",
        "../../tasks/victim",
        "/absolute",
        "a/b",
        "a\\b",
        "a\0b",
        "a∕b",
        "a／b",
        "a\u{2028}b",
        " dispatch",
        "dispatch\n",
    ]
    .into_iter()
    .map(str::to_owned)
    .chain(["a".repeat(101)])
    .collect()
}
#[tokio::test]
async fn bind_rejects_unsafe_ids_before_mutating_the_attempt_or_journal() {
    for dispatch in unsafe_ids() {
        let (home, mut attempt) = fixture();
        let before = attempt.journal.read().unwrap();
        assert!(
            attempt
                .bind(json!({"dispatchId":dispatch,"state":"ready"}))
                .await
                .is_err(),
            "{dispatch:?}"
        );
        assert!(attempt.dispatch.is_none());
        assert_eq!(attempt.phase, Phase::New);
        assert_eq!(attempt.journal.read().unwrap(), before);
        fs::remove_dir_all(home).unwrap();
    }
}
#[tokio::test]
async fn wait_rejects_unsafe_ids_without_reading_or_deleting_outside_mail() {
    for dispatch in unsafe_ids() {
        let (home, mut attempt) = fixture();
        fs::create_dir_all(home.join("orca/inbox")).unwrap();
        let sentinel = home.join("tasks/victim.json");
        fs::write(&sentinel, br#"{"outcome":"succeeded"}"#).unwrap();
        let journal = home.join("orca.json");
        fs::write(&journal, br#"{"workers":{}}"#).unwrap();
        attempt.dispatch = Some(dispatch.clone());
        attempt.terminal = Some("terminal".into());
        attempt.phase = Phase::Started;
        attempt.start = json!({"state":"ready"});
        assert!(attempt.wait().await.is_err(), "{dispatch:?}");
        assert_eq!(fs::read(&sentinel).unwrap(), br#"{"outcome":"succeeded"}"#);
        assert_eq!(fs::read(&journal).unwrap(), br#"{"workers":{}}"#);
        fs::remove_dir_all(home).unwrap();
    }
}
#[tokio::test]
async fn live_answer_rejects_unsafe_worker_before_reattachment() {
    for dispatch in unsafe_ids() {
        let (home, mut attempt) = fixture();
        attempt.edit(|task| {
            task.put("/interactionMode", WireReply::new(json!("conversation")))?;
            task.put("/interactive", WireReply::new(json!(true)))?;
            task.put("/brief/qa", WireReply::new(json!([{"q":"question","a":"answer"}])))?;
            task.put("/live", WireReply::new(json!({"backend":"orca","worker":dispatch,"terminal":"terminal","executor":"codex#work@host"})))
        }).unwrap();
        assert!(attempt.live_answer().await.is_err(), "{dispatch:?}");
        assert!(!attempt.reattach);
        assert!(attempt.dispatch.is_none());
        fs::remove_dir_all(home).unwrap();
    }
}
#[tokio::test]
async fn bind_only_writes_live_when_the_task_is_unfalsely_interactive() {
    // Worker live-bind writes `/live` when `interactive` is absent or true (post-#643), even
    // without `interactionMode == "conversation"`; an explicit `false` suppresses it.
    for (interactive, mode, expect_live) in [
        (Some(true), None, true),
        (None, None, true),
        (Some(false), Some("conversation"), false),
    ] {
        let (home, mut attempt) = fixture();
        attempt.terminal = Some("terminal".into());
        attempt
            .edit(|task| {
                if let Some(v) = interactive {
                    task.put("/interactive", WireReply::new(json!(v)))?;
                }
                if let Some(m) = mode {
                    task.put("/interactionMode", WireReply::new(json!(m)))?;
                }
                Ok(())
            })
            .unwrap();
        attempt
            .bind(json!({"dispatchId":"dispatch","state":"ready"}))
            .await
            .unwrap();
        let task = attempt.task().unwrap();
        assert_eq!(
            task.get("live").is_some(),
            expect_live,
            "interactive={interactive:?} mode={mode:?}"
        );
        fs::remove_dir_all(home).unwrap();
    }
}
#[tokio::test]
async fn safe_id_limits_and_mail_write_read_round_trip_match_ts() {
    for dispatch in ["a".into(), "A0_-".into(), "z".repeat(100)] {
        let (home, mut attempt) = fixture();
        let mail = json!({"messages":[{"type":"worker_done","payload":json!({"dispatchId":dispatch,"outcome":"succeeded"}).to_string()}]});
        attempt
            .process_batch(&mail, &mut Default::default())
            .await
            .unwrap();
        let file = home.join("orca/inbox").join(format!("{dispatch}.json"));
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(file.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        attempt.dispatch = Some(dispatch);
        attempt.terminal = Some("terminal".into());
        attempt.phase = Phase::Started;
        attempt.start = json!({"state":"ready"});
        assert_eq!(attempt.wait().await.unwrap()["kind"], "done");
        assert!(!file.exists());
        fs::remove_dir_all(home).unwrap();
    }
}

#[test]
fn dispatch_validation_matches_the_typescript_safe_id_for_the_adversarial_corpus() {
    let mut ids = unsafe_ids();
    ids.extend(["a".into(), "Z_0-".into(), "a".repeat(100), "😀".repeat(50)]);
    ids.extend((0..=127).map(|code| format!("a{}b", char::from(code))));
    ids.extend(["a⁄b", "a⧸b", "a＼b", "a∖b"].map(str::to_owned));
    let source = fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/exec/orca/state.ts"),
    )
    .unwrap();
    let input = json!({"source":source,"ids":ids});
    let script = r#"const {source,ids}=JSON.parse(Bun.argv.at(-1)); const re=new RegExp(source.match(/const SAFE_ID = \/(.*)\/;/)[1]); console.log(JSON.stringify(ids.map(id=>re.test(id))));"#;
    let output = std::process::Command::new("bun")
        .args(["-e", script, &input.to_string()])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Vec<bool> = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        ids.iter().map(|s| safe_dispatch_id(s)).collect::<Vec<_>>(),
        expected
    );
}

#[test]
fn idle_and_working_match_actual_non_unicode_javascript_patterns() {
    let source = fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/exec/orca/wait.ts"),
    )
    .unwrap();
    let spaces = [
        "", " ", "\t", "\r", "\n", "\u{b}", "\u{c}", "\u{a0}", "\u{feff}", "\u{0085}", "\u{1680}",
        "\u{2000}", "\u{200a}", "\u{2028}", "\u{2029}", "\u{202f}", "\u{205f}", "\u{3000}",
    ];
    let mut texts = Vec::new();
    for space in spaces {
        for word in [
            "›",
            "❯",
            ">",
            "> Try ",
            "> IMPLEMENT ",
            "codex>",
            "CLAUDE>",
            "Ask anything",
            "Aſk anything",
            "What would you like",
            "Type a message",
        ] {
            for suffix in ["", "\n", "\r", "\r\n", "\u{2028}", "\u{2029}", "\nnot idle"] {
                texts.push(format!("{space}{word}{suffix}"));
            }
        }
        for prefix in ["esc", "ESC", "eſc", "ctrl", "CTRL"] {
            texts.push(format!("{prefix}{space}to{space}interrupt"));
            texts.push(format!("{prefix}{space}+{space}c{space}to{space}stop"));
        }
    }
    let script = r#"const {source,texts}=JSON.parse(await Bun.stdin.text());const re=name=>{const m=source.match(new RegExp('(?:export )?const '+name+' = /(.*)/([a-z]*);'));return new RegExp(m[1],m[2])};const a=re('IDLE_PROMPT'),b=re('WORKING_INDICATOR');console.log(JSON.stringify(texts.map(s=>[a.test(s),b.test(s)])));"#;
    let mut child = std::process::Command::new("bun")
        .args(["-e", script])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    std::io::Write::write_all(
        &mut child.stdin.take().unwrap(),
        json!({"source":source,"texts":texts})
            .to_string()
            .as_bytes(),
    )
    .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    let expected: Vec<(bool, bool)> = serde_json::from_slice(&out.stdout).unwrap();
    for (text, expected) in texts.iter().zip(expected) {
        assert_eq!(
            (super::idle(text), super::working(text)),
            expected,
            "{text:?}"
        );
    }
}

#[test]
fn recent_output_does_not_pull_old_limits_across_prompt_echo_slots() {
    let mut lines = vec!["old usage limit"; 25];
    lines.extend(["echo prompt"; 15]);
    let (full, recent) = super::wait_output(&lines, "prompt");
    assert!(full.contains("usage limit"));
    assert_eq!(recent, "");
    let (full, recent) = super::wait_output(&["old", "prompt", "provider busy"], "prompt");
    assert_eq!(
        (full, recent),
        ("old\nprovider busy".into(), "old\nprovider busy".into())
    );
    let long = "x".repeat(9000);
    assert_eq!(super::wait_output(&[&long], "").1.len(), 9000);
}

#[test]
fn exact_task_snapshots_keep_legacy_missing_and_null_revision_defaults() {
    for rev in [None, Some(Value::Null)] {
        let (home, mut attempt) = fixture();
        let mut task = attempt.task().unwrap();
        task.as_object_mut().unwrap().remove("rev");
        if let Some(rev) = rev {
            task["rev"] = rev;
        }
        attempt
            .store
            .connection()
            .unwrap()
            .execute(
                "UPDATE tasks SET record=? WHERE id=?",
                rusqlite::params![task.to_string(), TASK],
            )
            .unwrap();
        attempt
            .edit(|edit| edit.put("/baseBranch", WireReply::new(json!("main"))))
            .unwrap();
        assert_eq!(attempt.task().unwrap()["rev"], 2);
        fs::remove_dir_all(home).unwrap();
    }
}
