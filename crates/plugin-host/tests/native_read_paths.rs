#![allow(clippy::unwrap_used)]
use pacer_plugin_host::{
    AuthorityError, BrokerError, CallAuthority, CallResources, CapabilityBroker, CapabilityEffect,
    NativeRead, ReadResource, parse_manifest,
};
use serde_json::{Value, json};
use std::{
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

struct Fixture {
    home: PathBuf,
    resource: ReadResource,
    file: String,
}
impl Fixture {
    fn new() -> Self {
        let home = std::env::temp_dir().join(format!("pacer-read-paths-{}", uuid::Uuid::new_v4()));
        let logs = home.join("logs");
        std::fs::create_dir_all(logs.join("🦀")).unwrap();
        let file = logs.join("🦀/rollout-owned.jsonl");
        std::fs::write(&file, "aλz").unwrap();
        Self {
            home,
            resource: ReadResource {
                path: logs.to_string_lossy().into_owned(),
                kind: "codex-logs".into(),
            },
            file: file.to_string_lossy().into_owned(),
        }
    }

    fn broker(&self, grants: bool) -> CapabilityBroker {
        let manifest = parse_manifest(json!({
            "id":"fixture", "version":"1.0.0", "publisher":"fixture", "host":">=1.10.0",
            "capabilities":[{"name":"fs.read", "scopes":[format!("{}/**", self.resource.path)]}]
        }))
        .unwrap();
        CapabilityBroker::new(
            manifest,
            CallAuthority::new(
                CallResources {
                    reads: vec![self.resource.clone()],
                    ..Default::default()
                },
                if grants {
                    vec!["fs.read".into()]
                } else {
                    vec![]
                },
                Instant::now() + Duration::from_secs(60),
            ),
            vec![],
        )
    }

    fn reader(&self) -> NativeRead {
        NativeRead::prepare(std::slice::from_ref(&self.resource)).unwrap()
    }

    fn paths(&self) -> Vec<(&'static str, String)> {
        let root = &self.resource.path;
        let units = self.file.encode_utf16().count();
        vec![
            ("ordinary", self.file.clone()),
            (
                "redundant separators",
                format!("{root}///🦀//rollout-owned.jsonl///"),
            ),
            (
                "4096 UTF-16 units",
                format!("{}{}", self.file, "/".repeat(4096 - units)),
            ),
            ("dot", format!("{root}/./🦀/rollout-owned.jsonl")),
            ("parent", format!("{root}/🦀/../🦀/rollout-owned.jsonl")),
            (
                "backslash dot",
                format!("{root}/🦀\\.\\rollout-owned.jsonl"),
            ),
            (
                "backslash parent",
                format!("{root}/🦀\\..\\rollout-owned.jsonl"),
            ),
            (
                "4097 UTF-16 units",
                format!("{}{}", self.file, "/".repeat(4097 - units)),
            ),
            (
                "astral length",
                format!("{root}/{}/rollout-owned.jsonl", "🦀".repeat(2048)),
            ),
            ("NUL", format!("{}\0", self.file)),
            ("relative", "logs/rollout-owned.jsonl".into()),
            ("empty", String::new()),
        ]
    }

    fn oracle(&self, paths: &[(&str, String)]) -> Vec<Value> {
        let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        let mut child = Command::new("bun")
            .arg(repository.join("test/fixtures/native-read-path-oracle.ts"))
            .env("HOME", &self.home)
            .env("PACER_HOME", self.home.join("pacer"))
            .env("PACER", "off")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(
                &serde_json::to_vec(&paths.iter().map(|(_, path)| path).collect::<Vec<_>>())
                    .unwrap(),
            )
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let results: Vec<Value> = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(results.len(), paths.len());
        results
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.home).unwrap();
    }
}

#[derive(Default)]
struct RecordingEffect {
    paths: Vec<Value>,
}
impl CapabilityEffect for RecordingEffect {
    async fn call(&mut self, _: &str, params: Value) -> Result<Value, BrokerError> {
        self.paths.push(params["path"].clone());
        Ok(json!({}))
    }
}
const METHODS: [&str; 3] = [
    "capability.fs.read",
    "capability.fs.stat",
    "capability.fs.readRange",
];

fn params(method: &str, path: &str, expected: &Value) -> Value {
    if method == "capability.fs.readRange" {
        json!({"path":path, "offset":1, "length":1, "expected":expected})
    } else {
        json!({"path":path})
    }
}
fn invalid_path(result: &Result<Value, BrokerError>) -> bool {
    matches!(result, Err(BrokerError::Authority(AuthorityError::Denied(message))) if message == "invalid absolute path")
}

#[tokio::test]
async fn broker_validates_raw_paths_against_typescript_before_any_effect() {
    let fixture = Fixture::new();
    let paths = fixture.paths();
    let oracle = fixture.oracle(&paths);
    let mut failures = vec![];
    for method in METHODS {
        let mut broker = fixture.broker(true);
        let mut effect = RecordingEffect::default();
        for ((label, path), expected) in paths.iter().zip(&oracle) {
            let before = effect.paths.len();
            let result = broker
                .handle(method, params(method, path, &json!({})), &mut effect)
                .await;
            let matches = if expected["error"] == "capability_denied" {
                invalid_path(&result) && effect.paths.len() == before
            } else {
                result.is_ok()
                    && effect.paths.len() == before + 1
                    && effect.paths.last() == Some(&expected["path"])
            };
            if !matches {
                failures.push(format!(
                    "{method} {label}: result={result:?}, effect calls={}",
                    effect.paths.len() - before
                ));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn standalone_reader_validates_raw_paths_against_typescript_before_reading() {
    let fixture = Fixture::new();
    let paths = fixture.paths();
    let oracle = fixture.oracle(&paths);
    let mut reader = fixture.reader();
    let stat = reader
        .answer("capability.fs.stat", &json!({"path":fixture.file}))
        .unwrap();
    let mut failures = vec![];
    for method in METHODS {
        for ((label, path), expected) in paths.iter().zip(&oracle) {
            let result = reader.answer(method, &params(method, path, &stat["info"]));
            let matches = if expected["error"] == "capability_denied" {
                invalid_path(&result)
            } else {
                match (&result, method) {
                    (Ok(value), "capability.fs.read") => value["text"] == "aλz",
                    (Ok(value), "capability.fs.stat") => value["info"] == stat["info"],
                    (Ok(value), "capability.fs.readRange") => value["base64"] == "zg==",
                    _ => false,
                }
            };
            if !matches {
                failures.push(format!("{method} {label}: {result:?}"));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn missing_or_nonstring_paths_keep_existing_errors_and_grants_precede_validation() {
    let fixture = Fixture::new();
    let mut reader = fixture.reader();
    let mut broker = fixture.broker(true);
    let mut ungranted = fixture.broker(false);
    let mut effect = RecordingEffect::default();
    for method in METHODS {
        for input in [
            json!({}),
            json!({"path":null}),
            json!({"path":42}),
            json!({"path":[]}),
        ] {
            assert!(matches!(
                reader.answer(method, &input),
                Err(BrokerError::Invalid("path"))
            ));
            assert!(matches!(
                broker.handle(method, input.clone(), &mut effect).await,
                Err(BrokerError::Invalid("missing string field"))
            ));
            assert!(matches!(
                ungranted.handle(method, input, &mut effect).await,
                Err(BrokerError::Authority(AuthorityError::Denied(capability))) if capability == "fs.read"
            ));
        }
        assert!(matches!(
            ungranted.handle(method, json!({"path":"/./invalid"}), &mut effect).await,
            Err(BrokerError::Authority(AuthorityError::Denied(capability))) if capability == "fs.read"
        ));
    }
    assert!(effect.paths.is_empty());
}
