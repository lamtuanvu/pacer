#![allow(clippy::unwrap_used, clippy::expect_used)]
//! B12-1 cross-runtime lock test: TypeScript `mergeEvidence` and Rust
//! `merge_evidence` share one evidence file under the same `evidence-<identity>`
//! lock and revision counter. The TypeScript side merges 50 availability facts,
//! the Rust side merges 50 more; afterwards the file holds all 100 facts and
//! `revision == 100`. Skips with a printed reason when `bun` is not on PATH
//! (the same pattern as `crates/store/tests/publication.rs`).

use pacer_foundation::Ctx;
use pacer_status::evidence::{evidence_fact, merge_evidence};
use serde_json::{Value, json};
use std::{collections::HashMap, path::Path, process::Command};

const NOW: f64 = 1_000_000.0;

// The identity used by both runtimes is the 64-hex string `a` repeated 64 times.
// `a`.repeat(64) at compile time is not stable, so build it at runtime; both
// the Rust and the TypeScript side derive the identical string.
fn identity() -> String {
    std::iter::repeat_n('a', 64).collect()
}

fn scope() -> Value {
    json!({ "account": "one", "identity": identity() })
}

fn ctx(dir: &Path) -> Ctx {
    let home = dir.to_path_buf();
    Ctx::with(home.clone(), home.join(".pacer"), HashMap::new(), NOW)
}

fn merge_one_fact(ctx: &Ctx, source: &str, valid_until: f64) {
    let scope = scope();
    let fact = evidence_fact(
        &scope,
        source,
        Some(NOW - 1000.0),
        Some(valid_until),
        "cross_runtime",
        json!("ready"),
        None,
    );
    let incoming = json!({ "availability": [fact], "budget": [], "spending": [] });
    futures::executor::block_on(merge_evidence(ctx, &scope, &incoming, None, false)).unwrap();
}

#[test]
fn typescript_and_rust_share_the_evidence_lock_and_revision() {
    let home = tempfile::tempdir().unwrap();
    let bun = Command::new("bun").arg("--version").output();
    if bun.is_err() {
        eprintln!("skipping cross-runtime test: bun is not on PATH");
        return;
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .unwrap();
    let script = format!(
        r#"
import {{mergeEvidence}} from './src/core/evidence.ts';
import {{evidenceFact, emptyEvidence}} from './src/engine/evidence.ts';
const id = 'a'.repeat(64);
const scope = {{account:'one', identity:id}};
const c = {{home:process.env.TEST_HOME, pacerHome:process.env.TEST_HOME+'/.pacer', now:1000000,
  env:{{HOME:process.env.TEST_HOME}}, run:async()=>({{code:127,stdout:'',stderr:''}}), which:()=>null}};
for (let i = 0; i < 50; i++) {{
  const f = evidenceFact(scope, 'ts', 999000, 1000000 + i, 'cross_runtime', 'ready');
  await mergeEvidence(c, scope, {{...emptyEvidence(), availability:[f]}});
}}
process.exit(0);
"#
    );
    let result = Command::new("bun")
        .arg("-e")
        .arg(&script)
        .env("TEST_HOME", home.path())
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "TS merge: {}",
        String::from_utf8_lossy(&result.stderr)
    );

    let c = ctx(home.path());
    let path = c
        .pacer_home
        .join("state/evidence")
        .join(format!("{}.json", identity()));
    let saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["revision"], 50.0);
    assert_eq!(
        saved["evidence"]["facts"]["availability"]
            .as_array()
            .unwrap()
            .len(),
        50
    );

    // Rust merges 50 more onto the TypeScript-written file.
    for i in 0..50 {
        merge_one_fact(&c, "rust", 2_000_000.0 + i as f64);
    }

    let saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["revision"], 100.0, "revision must count every merge");
    let availability = saved["evidence"]["facts"]["availability"]
        .as_array()
        .unwrap();
    assert_eq!(
        availability.len(),
        100,
        "both sides' facts must be retained"
    );
    assert!(
        availability.iter().any(|f| f["source"] == "ts")
            && availability.iter().any(|f| f["source"] == "rust"),
        "facts from both runtimes present"
    );
}
