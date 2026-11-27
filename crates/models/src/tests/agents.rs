//! Codex, Cursor and Antigravity listings for the pick list, against
//! `test/fixtures/codex/models_cache.json` and the stand-ins in
//! `test/fixtures/agent-bin` (state in `$HOME/.fake-<name>`). Mirrors
//! `test/models-agent-listings.test.ts`.
use super::NOW;
use crate::{
    agent_listings::{AgentListing, agent_listing, list_cli},
    available::cache_file,
    *,
};
use serde_json::{Value, json};
use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

const CURSOR_OUT: &str = "Available models\n\nauto - Auto (current, default)\ngpt-5.3-codex - Codex 5.3\ncomposer-2.5 - Composer 2.5\n\nTip: use --model <id> (or /model <id> in interactive mode) to switch.\n";
const AGY_OUT: &str = "Fetching available models...\ngemini-4-hydrogen-high\tGemini 4 Hydrogen (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n";

fn fixture(path: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures")
        .join(path)
}

fn strategy() -> Value {
    let account = |name: &str, kind: &str, source: &str, home: Value| {
        json!({"name": name, "kind": kind, "source": source, "provider": null, "home": home, "orcaAccount": null})
    };
    json!({
        "accounts": {
            "codex": account("codex", "codex", "default", Value::Null),
            "work": account("work", "codex", "pacer", json!("~/codex-work")),
            "rel": account("rel", "codex", "pacer", json!("codex-rel")),
            "orca": account("orca", "codex", "orca", Value::Null),
            "cursor": account("cursor", "cursor", "default", Value::Null),
            "agy": account("agy", "agy", "default", Value::Null),
        },
        "runners": {
            "codex": {"id": "codex", "agent": "codex", "account": "codex", "host": null},
            "codex#work": {"id": "codex#work", "agent": "codex", "account": "work", "host": null},
            "codex#rel": {"id": "codex#rel", "agent": "codex", "account": "rel", "host": null},
            "codex#orca": {"id": "codex#orca", "agent": "codex", "account": "orca", "host": null},
            "codex@box": {"id": "codex@box", "agent": "codex", "account": "codex", "host": "box"},
            "cursor": {"id": "cursor", "agent": "cursor", "account": "cursor", "host": null},
            "agy": {"id": "agy", "agent": "agy", "account": "agy", "host": null},
        },
    })
}

fn base(runner: &str) -> AvailableModels {
    AvailableModels {
        runner: runner.into(),
        source: ModelSource::None,
        models: None,
        fetched_at: NOW,
        note: None,
        provider: None,
    }
}

fn models(list: &[AvailableModel]) -> Value {
    Value::Array(
        list.iter()
            .map(|m| {
                let mut list = AvailableModels {
                    models: Some(vec![m.clone()]),
                    ..base("x")
                }
                .to_json();
                list["models"][0].take()
            })
            .collect(),
    )
}

#[test]
fn cursor_lines_become_ids_and_names() {
    assert_eq!(
        models(&parse_cursor_models(CURSOR_OUT)),
        json!([{"id": "auto", "name": "Auto"}, {"id": "gpt-5.3-codex", "name": "Codex 5.3"}, {"id": "composer-2.5", "name": "Composer 2.5"}])
    );
    assert_eq!(
        models(&parse_cursor_models(
            "a - A (current)\r\nb - B (beta)\nb - again\n\u{feff}c - \n has space - X\n"
        )),
        json!([{"id": "a", "name": "A"}, {"id": "b", "name": "B (beta)"}])
    );
    assert!(parse_cursor_models("garbage\n{\"json\":true}\n").is_empty());
}

#[test]
fn agy_lines_split_at_the_first_tab() {
    assert_eq!(
        models(&parse_agy_models(AGY_OUT)),
        json!([{"id": "gemini-4-hydrogen-high", "name": "Gemini 4 Hydrogen (High)"}, {"id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6 (Thinking)"}])
    );
    assert_eq!(
        models(&parse_agy_models(
            "x\t\r\n y \tY\tmore\nno tab here\n\tnameless\n"
        )),
        json!([{"id": "x"}, {"id": "y", "name": "Y\tmore"}])
    );
}

#[test]
fn the_codex_cache_lists_only_listed_models() {
    let parse = |text: &str| {
        pacer_js_json::quoted::parse_file(text.as_bytes())
            .ok()
            .and_then(|v| parse_codex_cache(&v))
            .map(|m| models(&m))
    };
    let text = fs::read_to_string(fixture("codex/models_cache.json")).unwrap();
    assert_eq!(
        parse(&text),
        Some(json!([
            {"id": "gpt-6-luna", "name": "GPT-6-Luna", "context": 272000},
            {"id": "gpt-5.6-terra", "name": "GPT-5.6-Terra", "context": 400000},
            {"id": "gpt-5.6-luna", "name": "GPT-5.6-Luna", "context": 272000},
        ]))
    );
    assert_eq!(
        parse(
            r#"{"models":[{"slug":"old"},{"slug":"x","visibility":null},{"slug":""},null,"s",{"slug":"y","display_name":3,"context_window":-1},{"slug":"z","display_name":"","context_window":1e400}]}"#
        ),
        Some(json!([{"id": "old"}, {"id": "y"}, {"id": "z"}]))
    );
    assert_eq!(parse("not json"), None);
    assert_eq!(parse(r#"{"models":{}}"#), None);
}

fn known(listing: Option<AgentListing>) -> AvailableModels {
    match listing {
        Some(AgentListing::Known(list)) => list,
        other => panic!("not a known listing: {other:?}"),
    }
}

#[test]
fn codex_reads_models_cache_json_from_its_folder() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let s = strategy();
    let listing = |runner: &str| agent_listing(home, &s, runner, &base(runner));
    fs::create_dir_all(home.join(".codex")).unwrap();
    fs::copy(
        fixture("codex/models_cache.json"),
        home.join(".codex/models_cache.json"),
    )
    .unwrap();
    let list = known(listing("codex"));
    assert_eq!(
        list.to_json(),
        json!({"runner": "codex", "source": "codex", "models": [
            {"id": "gpt-6-luna", "name": "GPT-6-Luna", "context": 272000},
            {"id": "gpt-5.6-terra", "name": "GPT-5.6-Terra", "context": 400000},
            {"id": "gpt-5.6-luna", "name": "GPT-5.6-Luna", "context": 272000},
        ], "fetchedAt": NOW, "provider": "codex"})
    );
    let note = |runner: &str| known(listing(runner)).note;
    assert_eq!(
        note("codex#work").as_deref(),
        Some("Codex has not saved a model list yet; start Codex once with this account")
    );
    let work = home.join("codex-work");
    fs::create_dir_all(&work).unwrap();
    fs::write(work.join("models_cache.json"), "{garbage").unwrap();
    assert_eq!(
        note("codex#work").as_deref(),
        Some("Codex's saved model list could not be read")
    );
    fs::write(
        work.join("models_cache.json"),
        r#"{"models":[{"slug":"h","visibility":"hide"}]}"#,
    )
    .unwrap();
    assert_eq!(
        note("codex#work").as_deref(),
        Some("Codex's saved model list has no models; start Codex once to refresh it")
    );
    // Folders only TypeScript resolves; remote runners have no local listing.
    assert!(matches!(listing("codex#rel"), Some(AgentListing::Unsupported)));
    assert!(matches!(listing("codex#orca"), Some(AgentListing::Unsupported)));
    assert!(listing("codex@box").is_none());
    // The model checks keep no listing for native agents.
    assert!(matches!(
        available_models(&home.join(".pacer"), NOW, &s, "codex"),
        Listing::Known(AvailableModels { source: ModelSource::None, models: None, .. })
    ));
}

#[tokio::test]
async fn the_codex_reply_is_native_and_never_cached() {
    let dir = tempfile::tempdir().unwrap();
    let (home, pacer) = (dir.path(), dir.path().join(".pacer"));
    let s = strategy();
    fs::create_dir_all(home.join(".codex")).unwrap();
    fs::copy(
        fixture("codex/models_cache.json"),
        home.join(".codex/models_cache.json"),
    )
    .unwrap();
    assert!(!available_needs_core(&pacer, home, NOW, &s, "codex", false));
    let reply = available_reply(&pacer, home, NOW, &s, "codex", false)
        .await
        .unwrap();
    assert_eq!(reply["source"], "codex");
    assert_eq!(reply["models"].as_array().unwrap().len(), 3);
    assert!(!cache_file(&pacer, "codex").exists());
    assert!(available_needs_core(
        &pacer,
        home,
        NOW,
        &s,
        "codex#orca",
        false
    ));
}

struct Fake {
    dir: tempfile::TempDir,
}

impl Fake {
    fn new(name: &str, mode: &str, models: &str) -> Self {
        let fake = Self {
            dir: tempfile::tempdir().unwrap(),
        };
        fake.set(name, mode, models);
        fs::create_dir_all(fake.home().join("work")).unwrap();
        fake
    }
    fn set(&self, name: &str, mode: &str, models: &str) {
        let state = self.home().join(format!(".fake-{name}"));
        fs::create_dir_all(&state).unwrap();
        fs::write(state.join("mode"), mode).unwrap();
        fs::write(state.join("models"), models).unwrap();
    }
    fn home(&self) -> &Path {
        self.dir.path()
    }
    fn pacer_home(&self) -> PathBuf {
        self.home().join(".pacer")
    }
    fn process(&self, bin: &Path) -> discover::CoreProcess {
        let path = format!("{}:/usr/bin:/bin", bin.display());
        let env = [("PATH", path.as_str()), ("HOME", self.home().to_str().unwrap())];
        discover::CoreProcess {
            env: env
                .iter()
                .map(|(k, v)| (OsString::from(k), OsString::from(v)))
                .collect(),
            cwd: self.home().join("work"),
        }
    }
    fn calls(&self, name: &str) -> usize {
        fs::read_to_string(self.home().join(format!(".fake-{name}/calls.log")))
            .unwrap_or_default()
            .lines()
            .count()
    }
    async fn list(&self, runner: &str, bin: &Path) -> AvailableModels {
        let Some(AgentListing::Cli(base, agent)) =
            agent_listing(self.home(), &strategy(), runner, &base(runner))
        else {
            panic!("{runner} runs a CLI");
        };
        list_cli(&self.pacer_home(), base, agent, &self.process(bin)).await
    }
}

#[tokio::test]
async fn cursor_and_agy_list_through_their_cli_and_cache_a_listing() {
    let bin = fixture("agent-bin");
    for (runner, name, out, first, label) in [
        ("cursor", "cursor-agent", CURSOR_OUT, json!({"id": "auto", "name": "Auto"}), "Cursor"),
        ("agy", "agy", AGY_OUT, json!({"id": "gemini-4-hydrogen-high", "name": "Gemini 4 Hydrogen (High)"}), "Antigravity"),
    ] {
        let fake = Fake::new(name, "list", out);
        let list = fake.list(runner, &bin).await.to_json();
        assert_eq!(list["source"], runner);
        assert_eq!(list["provider"], runner);
        assert_eq!(list["models"][0], first);
        assert_eq!(fake.calls(name), 1);
        let cache = cache_file(&fake.pacer_home(), runner);
        assert_eq!(
            fs::read_to_string(&cache).unwrap(),
            pacer_js_json::quoted::stringify(&list)
        );
        // The pick list serves the cache; the model checks do not.
        let s = strategy();
        let served = available_reply(&fake.pacer_home(), fake.home(), NOW, &s, runner, false)
            .await
            .unwrap();
        assert_eq!(served, list);
        assert!(matches!(
            available_models(&fake.pacer_home(), NOW, &s, runner),
            Listing::Known(AvailableModels { source: ModelSource::None, .. })
        ));
        fs::remove_file(&cache).unwrap();
        for (mode, models, note) in [
            ("fail", "", format!("{label} could not list its models")),
            ("empty", "", format!("{label} lists no models; check that it is signed in")),
            ("list", "Available models\n\nnot a model line\n", format!("{label} lists no models; check that it is signed in")),
        ] {
            fake.set(name, mode, models);
            let list = fake.list(runner, &bin).await;
            assert_eq!((list.models, list.note.as_deref()), (None, Some(note.as_str())), "{runner} {mode}");
            assert!(!cache.exists(), "{runner} {mode}");
        }
        // A missing binary is unknown too.
        let empty = tempfile::tempdir().unwrap();
        let list = fake.list(runner, empty.path()).await;
        assert_eq!(list.note, Some(format!("{label} could not list its models")));
    }
}

#[tokio::test]
async fn a_hung_cli_is_killed_at_the_timeout() {
    let fake = Fake::new("cursor-agent", "hang", "");
    let started = std::time::Instant::now();
    let out = discover::run_program(
        &fake.process(&fixture("agent-bin")),
        &["cursor-agent", "models"],
        Duration::from_millis(500),
        discover::STDOUT_CAP,
    )
    .await;
    assert_eq!(out, None);
    assert!(started.elapsed() < Duration::from_secs(10));
}
