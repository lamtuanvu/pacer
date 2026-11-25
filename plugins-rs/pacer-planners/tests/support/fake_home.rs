//! In-memory host for the planner handlers: serves `capability.fs.*`,
//! `capability.planner.run` and `capability.process.*` from a tree, then applies
//! the host-side commit of the returned file lists (M3 C12b test support).

#![allow(clippy::unwrap_used, clippy::expect_used)]

use base64::Engine;
use pacer_plugin::install::{
    PendingFile, PlannerCommandResult, PlannerRecord, PreparedPlannerPlan,
    PreparedPlannerUninstall,
};
use pacer_plugin::testing::Harness;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

const CHUNK: usize = 262144;

#[derive(Clone, Debug)]
pub struct Entry {
    pub text: String,
    pub mode: u32,
}

#[derive(Clone, Debug, Default)]
pub struct FakeHome {
    pub files: Arc<Mutex<BTreeMap<String, Entry>>>,
    pub runs: Arc<Mutex<Vec<Vec<String>>>>,
    pub run_results: Arc<Mutex<BTreeMap<String, PlannerCommandResult>>>,
    pub spawn_result: Arc<Mutex<Option<PlannerCommandResult>>>,
}

/// A standard `planner.install` / `planner.plan` parameter set.
pub fn params(agent: &str, folder: &str, home: &str, mcp: Option<bool>) -> Value {
    let mut env = json!({
        "now": 1700000000,
        "pacerArgv": ["/usr/local/bin/pacer"],
        "folder": folder,
        "plannerKey": format!("{agent}-key"),
        "configEnv": {},
    });
    if let Some(mcp) = mcp {
        env["mcp"] = json!(mcp);
    }
    json!({
        "agent": agent,
        "home": home,
        "binary": format!("/usr/local/bin/{agent}"),
        "env": env,
    })
}

pub fn ok() -> PlannerCommandResult {
    PlannerCommandResult {
        code: 0,
        stdout: String::new(),
        stderr: String::new(),
    }
}

impl FakeHome {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn put(&self, path: impl Into<String>, text: impl Into<String>) -> &Self {
        self.files.lock().unwrap().insert(
            path.into(),
            Entry {
                text: text.into(),
                mode: 0o644,
            },
        );
        self
    }

    pub fn get(&self, path: &str) -> Option<String> {
        self.files.lock().unwrap().get(path).map(|e| e.text.clone())
    }

    pub fn has(&self, path: &str) -> bool {
        self.files.lock().unwrap().contains_key(path)
    }

    pub fn paths(&self) -> Vec<String> {
        self.files.lock().unwrap().keys().cloned().collect()
    }

    /// Simulate the host committing a `PreparedPlannerPlan` / uninstall result.
    pub fn apply(&self, files: &[PendingFile]) {
        let mut tree = self.files.lock().unwrap();
        for file in files {
            match &file.after {
                Some(text) => {
                    tree.insert(
                        file.path.clone(),
                        Entry {
                            text: text.clone(),
                            mode: file.mode.or(file.before_mode).unwrap_or(0o644),
                        },
                    );
                }
                None => {
                    tree.remove(&file.path);
                }
            }
        }
    }

    /// Call `planner.install`, apply the host commit, and return the plan.
    pub async fn install(&self, params: Value) -> PreparedPlannerPlan {
        let mut harness = self.start().await;
        let value = harness
            .call("planner.install", params)
            .await
            .expect("install succeeds");
        harness.close().await;
        let plan: PreparedPlannerPlan = serde_json::from_value(value).expect("valid install plan");
        self.apply(&plan.files);
        plan
    }

    /// Call `planner.uninstall`, apply the host commit, and return the result.
    pub async fn uninstall(&self, agent: &str, prior: PlannerRecord) -> PreparedPlannerUninstall {
        let mut harness = self.start().await;
        let value = harness
            .call(
                "planner.uninstall",
                json!({ "agent": agent, "prior": prior, "env": { "plannerKey": prior.planner } }),
            )
            .await
            .expect("uninstall succeeds");
        harness.close().await;
        let result: PreparedPlannerUninstall =
            serde_json::from_value(value).expect("valid uninstall result");
        self.apply(&result.files);
        result
    }

    pub fn result_for(argv: &[String]) -> PlannerCommandResult {
        let key = argv.get(1).map(String::as_str).unwrap_or_default();
        let _ = key;
        ok()
    }

    /// Start the plugin against this home, registering all capability answers.
    pub async fn start(&self) -> Harness {
        let mut harness = Harness::start(pacer_bundled_planners::plugin(), Default::default()).await;
        self.register(&mut harness);
        harness
    }

    fn register(&self, h: &mut Harness) {
        let files = self.files.clone();
        h.on_capability("capability.fs.read", move |params| {
            let path = params
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let tree = files.lock().unwrap();
            let Some(entry) = tree.get(&path) else {
                return Ok(json!({ "missing": true }));
            };
            if entry.text.len() > CHUNK {
                Ok(json!({
                    "ranged": {
                        "path": path,
                        "size": entry.text.len(),
                        "inode": 1,
                        "device": 1,
                        "mtimeMs": 0.0,
                        "mode": entry.mode,
                    }
                }))
            } else {
                Ok(json!({ "text": entry.text, "mode": entry.mode }))
            }
        });

        let files = self.files.clone();
        h.on_capability("capability.fs.readRange", move |params| {
            let path = params
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let offset = params.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
            let length = params
                .get("length")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
            let expected = params.get("expected").cloned().unwrap_or(Value::Null);
            let tree = files.lock().unwrap();
            let bytes = tree.get(path).map(|e| e.text.as_bytes()).unwrap_or(&[]);
            let end = (offset + length).min(bytes.len());
            let part = if offset <= end { &bytes[offset..end] } else { &[] };
            Ok(json!({
                "base64": base64::engine::general_purpose::STANDARD.encode(part),
                "info": expected,
            }))
        });

        let files = self.files.clone();
        h.on_capability("capability.fs.list", move |params| {
            let dir = params
                .get("dir")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let glob = params
                .get("glob")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let tree = files.lock().unwrap();
            let prefix = format!("{}/", dir.trim_end_matches('/'));
            let listed: Vec<Value> = tree
                .keys()
                .filter(|path| path.starts_with(&prefix))
                .filter(|path| {
                    if glob == "*.md" {
                        path.ends_with(".md")
                    } else {
                        true
                    }
                })
                .map(|path| json!({ "path": path }))
                .collect();
            Ok(json!({ "files": listed }))
        });

        let runs = self.runs.clone();
        let results = self.run_results.clone();
        h.on_capability("capability.planner.run", move |params| {
            let argv: Vec<String> = params
                .get("argv")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            runs.lock().unwrap().push(argv.clone());
            let key = argv.get(1).cloned().unwrap_or_default();
            let result = results
                .lock()
                .unwrap()
                .get(&key)
                .cloned()
                .unwrap_or_else(|| Self::result_for(&argv));
            Ok(serde_json::to_value(result).unwrap())
        });

        let spawn = self.spawn_result.clone();
        h.on_capability("capability.process.spawn", move |_| {
            let result = spawn.lock().unwrap().clone().unwrap_or_else(ok);
            Ok(json!({
                "code": result.code,
                "stdout": result.stdout,
                "stderr": result.stderr,
            }))
        });

        h.on_capability("capability.process.outputChunk", |params| {
            let handle = params
                .get("handle")
                .and_then(Value::as_str)
                .unwrap_or_default();
            Ok(json!({
                "base64": base64::engine::general_purpose::STANDARD.encode(handle.as_bytes()),
            }))
        });
    }
}
