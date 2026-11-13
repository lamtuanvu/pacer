//! `opencode models` against `test/fixtures/bin/opencode`, the listing cache it
//! writes and the catalog facts it attaches.
use super::{NOW, strategy};
use crate::*;
use pacer_js_json::quoted;
use serde_json::{Value, json};
use std::{
    ffi::OsString,
    fs,
    os::unix::fs::PermissionsExt as _,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

/// A temp home with the fake on PATH and a working directory below it.
struct Fake {
    dir: tempfile::TempDir,
}

impl Fake {
    fn new(mode: &str, models: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join(".fake-opencode");
        fs::create_dir_all(&state).unwrap();
        fs::write(state.join("mode"), mode).unwrap();
        fs::write(state.join("models"), models).unwrap();
        fs::create_dir_all(dir.path().join("work")).unwrap();
        Self { dir }
    }
    fn home(&self) -> &Path {
        self.dir.path()
    }
    fn pacer_home(&self) -> PathBuf {
        self.home().join(".pacer")
    }
    fn process(&self) -> CoreProcess {
        let bin = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/bin");
        let path = format!("{}:/usr/bin:/bin", bin.display());
        let env = [
            ("PATH", path.as_str()),
            ("HOME", self.home().to_str().unwrap()),
            ("PACER_FAKE_OPENCODE_PROBE", "core-env"),
        ];
        CoreProcess {
            env: env
                .iter()
                .map(|(k, v)| (OsString::from(k), OsString::from(v)))
                .collect(),
            cwd: self.home().join("work").canonicalize().unwrap(),
        }
    }
    fn calls(&self) -> String {
        fs::read_to_string(self.home().join(".fake-opencode/calls.log")).unwrap_or_default()
    }
    async fn discover(&self) -> Listing {
        let Listing::NeedsDiscovery(found) =
            available_models(&self.pacer_home(), NOW, &strategy(), "opencode#oc")
        else {
            panic!("opencode#oc needs discovery");
        };
        discover(&self.pacer_home(), found, &self.process()).await
    }
    fn cache(&self) -> PathBuf {
        cache_file(&self.pacer_home(), "opencode#oc")
    }
}

fn known(listing: Listing) -> AvailableModels {
    match listing {
        Listing::Known(list) => list,
        other => panic!("not a known listing: {other:?}"),
    }
}

fn alive(pid: i32) -> bool {
    rustix::process::Pid::from_raw(pid)
        .is_some_and(|pid| rustix::process::test_kill_process(pid).is_ok())
}

#[test]
fn model_ids_read_lines_like_text_decoder_split_and_trim() {
    let out = b"\xef\xbb\xbfacme/a\r\n  acme/b \nother/x\nacme/\nacmex/y\n\tacme/c\xff\n";
    assert_eq!(model_ids(out, "acme"), vec!["a", "b", "", "c\u{fffd}"]);
    assert!(model_ids(b"", "acme").is_empty());
}

#[tokio::test]
async fn runs_opencode_models_with_the_core_env_and_cwd() {
    let fake = Fake::new("list", "acme/a\nother/b\n");
    let mut process = fake.process();
    // A shell keeps an inherited PWD that names its directory, so the override must replace it.
    let link = fake.home().join("link");
    std::os::unix::fs::symlink(&process.cwd, &link).unwrap();
    process.env.push(("PWD".into(), link.into()));
    let out = run_models(&process, Duration::from_secs(30)).await;
    assert_eq!(out.as_deref(), Some(&b"acme/a\nother/b\n"[..]));
    let cwd = process.cwd.display();
    assert_eq!(
        fake.calls(),
        format!("args=models pwd={cwd} cwd={cwd} probe=core-env\n")
    );
}

#[tokio::test]
async fn a_failing_or_missing_cli_lists_nothing() {
    let fake = Fake::new("fail", "acme/a\n");
    assert_eq!(
        run_models(&fake.process(), Duration::from_secs(30)).await,
        None
    );
    let mut process = fake.process();
    process.env.retain(|(k, _)| k != "PATH");
    process.env.push(("PATH".into(), "/nonexistent".into()));
    assert_eq!(run_models(&process, Duration::from_secs(30)).await, None);
}

#[tokio::test]
async fn a_timeout_kills_the_whole_process_group() {
    let fake = Fake::new("hang", "");
    let started = Instant::now();
    assert_eq!(
        run_models(&fake.process(), Duration::from_secs(1)).await,
        None
    );
    assert!(started.elapsed() < Duration::from_secs(10));
    let pid: i32 = fs::read_to_string(fake.home().join(".fake-opencode/grandchild.pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while alive(pid) && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(!alive(pid), "grandchild {pid} survived the timeout");
}

#[tokio::test]
async fn the_child_gets_only_the_recorded_env() {
    let fake = Fake::new("env", "");
    let process = fake.process();
    let out = run_models(&process, Duration::from_secs(30)).await.unwrap();
    let text = String::from_utf8(out).unwrap();
    let child: Vec<&str> = text
        .lines()
        .filter_map(|l| l.split_once('='))
        .map(|(k, _)| k)
        .collect();
    let recorded: Vec<&OsString> = process.env.iter().map(|(k, _)| k).collect();
    for key in recorded.iter().map(|k| k.to_str().unwrap()).chain(["PWD"]) {
        assert!(child.contains(&key), "{key} missing from {child:?}");
    }
    // `sh` sets these itself.
    let shell = ["PWD", "OLDPWD", "SHLVL", "_"];
    let only_here: Vec<String> = std::env::vars_os()
        .map(|(k, _)| k)
        .filter(|k| !k.to_str().is_some_and(|k| shell.contains(&k)) && !recorded.contains(&k))
        .filter_map(|k| k.into_string().ok())
        .collect();
    assert!(!only_here.is_empty());
    let leaked: Vec<&String> = only_here
        .iter()
        .filter(|k| child.contains(&k.as_str()))
        .collect();
    assert!(
        leaked.is_empty(),
        "test-process env reached the child: {leaked:?}"
    );
}

#[tokio::test]
async fn stdout_past_the_cap_kills_the_group_and_lists_nothing() {
    let fake = Fake::new("flood", "");
    let state = fake.home().join(".fake-opencode");
    fs::write(state.join("flood"), (STDOUT_CAP + 1).to_string()).unwrap();
    assert_eq!(
        run_models(&fake.process(), Duration::from_secs(60)).await,
        None
    );
    fs::write(state.join("flood"), "8").unwrap();
    assert_eq!(
        crate::discover::run_capped(&fake.process(), Duration::from_secs(30), 8).await,
        Some(vec![0; 8])
    );
    // Past the cap a CLI that keeps running is killed at once, not at the timeout.
    fs::write(state.join("flood"), "9").unwrap();
    fs::write(state.join("hang"), "").unwrap();
    let started = Instant::now();
    assert_eq!(
        crate::discover::run_capped(&fake.process(), Duration::from_secs(60), 8).await,
        None
    );
    assert!(started.elapsed() < Duration::from_secs(10));
    let pid: i32 = fs::read_to_string(state.join("flood.pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while alive(pid) && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(!alive(pid), "flooding CLI {pid} survived the cap");
}

#[tokio::test]
async fn a_listing_is_cached_with_private_modes_and_exact_bytes() {
    let fake = Fake::new("list", "acme/a\nacme/b\nother/x\n");
    let list = known(fake.discover().await);
    assert_eq!(
        list.models
            .as_ref()
            .map(|m| m.iter().map(|m| m.id.as_str()).collect::<Vec<_>>()),
        Some(vec!["acme/a", "acme/b"])
    );
    assert_eq!(list.note, None);
    let text = fs::read_to_string(fake.cache()).unwrap();
    assert_eq!(
        text,
        r#"{"runner":"opencode#oc","source":"opencode","models":[{"id":"acme/a"},{"id":"acme/b"}],"fetchedAt":1700000000.5,"provider":"acme"}"#
    );
    let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&fake.cache()), 0o600);
    assert_eq!(mode(fake.cache().parent().unwrap()), 0o700);
    let leftovers: Vec<_> = fs::read_dir(fake.cache().parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(leftovers.len(), 1, "{leftovers:?}");
}

#[tokio::test]
async fn failed_and_empty_listings_carry_notes_and_are_never_cached() {
    for (mode, models, note) in [
        (
            "fail",
            "acme/a\n",
            "opencode could not list models for acme",
        ),
        (
            "empty",
            "",
            "opencode lists no models for acme; check opencode auth list",
        ),
        (
            "list",
            "other/x\n",
            "opencode lists no models for acme; check opencode auth list",
        ),
    ] {
        let fake = Fake::new(mode, models);
        let list = known(fake.discover().await);
        assert_eq!(list.models, None, "{mode}");
        assert_eq!(list.note.as_deref(), Some(note), "{mode}");
        assert!(!fake.cache().exists(), "{mode}");
        assert!(!fake.cache().parent().unwrap().exists(), "{mode}");
    }
}

#[tokio::test]
async fn catalog_facts_follow_the_typescript_fact_rules() {
    let fake = Fake::new("list", "acme/a\nacme/b\nacme/c\n");
    let catalog = json!({"fetchedAt": 1, "providers": {"acme": {"models": [
        {"id": "a", "name": "Model A", "context": 128000, "outputLimit": null, "toolCall": null,
         "costIn": null, "costOut": 1.5, "release": "2026-01-01", "extra": true},
        {"id": "b", "name": null, "toolCall": false},
        7,
    ]}}});
    fs::create_dir_all(fake.pacer_home().join("cache")).unwrap();
    fs::write(
        fake.pacer_home().join("cache/models.json"),
        catalog.to_string(),
    )
    .unwrap();
    known(fake.discover().await);
    assert_eq!(
        fs::read_to_string(fake.cache()).unwrap(),
        concat!(
            r#"{"runner":"opencode#oc","source":"opencode","models":["#,
            r#"{"id":"acme/a","name":"Model A","context":128000,"tools":null,"costIn":null,"costOut":1.5,"release":"2026-01-01"},"#,
            r#"{"id":"acme/b","name":null,"tools":false},{"id":"acme/c"}],"fetchedAt":1700000000.5,"provider":"acme"}"#
        )
    );
}

#[tokio::test]
async fn catalogs_typescript_throws_on_stay_with_typescript() {
    for providers in [
        json!({"acme": {"models": [null, {"id": "a"}]}}),
        json!({"acme": {"models": "a"}}),
        json!({"acme": "entry"}),
    ] {
        let fake = Fake::new("list", "acme/a\n");
        fs::create_dir_all(fake.pacer_home().join("cache")).unwrap();
        let catalog = json!({"fetchedAt": 1, "providers": providers});
        fs::write(
            fake.pacer_home().join("cache/models.json"),
            catalog.to_string(),
        )
        .unwrap();
        assert!(listing_needs_core(
            &fake.pacer_home(),
            NOW,
            &strategy(),
            "opencode#oc"
        ));
        assert!(
            matches!(fake.discover().await, Listing::Unsupported),
            "{providers}"
        );
        assert!(!fake.cache().exists());
    }
}

#[tokio::test]
async fn fresh_caches_are_echoed_as_parsed_and_refresh_skips_them() {
    let dir = tempfile::tempdir().unwrap();
    let s = strategy();
    let odd = r#"{"runner":"opencode#named","source":"opencode","models":["a",{"id":"b","x":[1,2]}],"fetchedAt":1700000000,"provider":"vendor","extra":{"2":0,"1":1}}"#;
    super::seed(dir.path(), "opencode#named", odd);
    let reply = available_reply(dir.path(), NOW, &s, "opencode#named", false)
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_string(&reply).unwrap(),
        r#"{"runner":"opencode#named","source":"opencode","models":["a",{"id":"b","x":[1,2]}],"fetchedAt":1700000000,"provider":"vendor","extra":{"1":1,"2":0}}"#
    );
    assert!(!available_needs_core(
        dir.path(),
        NOW,
        &s,
        "opencode#named",
        false
    ));
    let fresh = available_reply(dir.path(), NOW, &s, "opencode#named", true)
        .await
        .unwrap();
    assert_eq!(fresh["source"], "connection");
    assert_eq!(
        fresh["models"],
        json!([{"id": "pacer-named/a"}, {"id": "pacer-named/b"}])
    );
    // A cached lone surrogate has no serde_json spelling.
    let lone = r#"{"runner":"opencode#named","source":"opencode","models":[{"id":"\ud800"}],"fetchedAt":1700000000}"#;
    super::seed(dir.path(), "opencode#named", lone);
    assert!(available_needs_core(
        dir.path(),
        NOW,
        &s,
        "opencode#named",
        false
    ));
    assert_eq!(
        available_reply(dir.path(), NOW, &s, "opencode#named", false).await,
        None
    );
}

#[test]
fn wire_values_match_json_stringify_or_are_absent() {
    let parsed = |text: &str| quoted::parse(text.as_bytes()).unwrap();
    let value = parsed(r#"{"b":1.0,"a":[2e0,-0,1.5],"10":null,"2":"x"}"#);
    assert_eq!(
        serde_json::to_string(&wire_value(&value).unwrap()).unwrap(),
        quoted::stringify(&value)
    );
    assert_eq!(wire_value(&parsed(r#"["\udc00"]"#)), None);
    assert_eq!(wire_value(&Value::Null), Some(Value::Null));
}
