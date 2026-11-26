//! Golden replay of `src/api/dispatch-parts-bridge.ts` answers, recorded by
//! `bun scripts/golden/dispatch-parts.ts`. Each fixture holds a disposable
//! home's files, the fake executables' `--version` answers and the exact JSON
//! the TypeScript bridge returned.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use pacer_foundation::Ctx;
use serde_json::{Value, json};
use std::{collections::HashMap, path::Path};

use super::dispatch_parts;
use crate::version_cache::VersionCache;

fn fixture(name: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/dispatch-parts")
        .join(format!("{name}.json"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn replace_home(value: &mut Value, home: &str) {
    match value {
        Value::String(text) => *text = text.replace("<HOME>", home),
        Value::Array(items) => items.iter_mut().for_each(|item| replace_home(item, home)),
        Value::Object(map) => {
            let renamed = std::mem::take(map)
                .into_iter()
                .map(|(key, mut item)| {
                    replace_home(&mut item, home);
                    (key.replace("<HOME>", home), item)
                })
                .collect();
            *map = renamed;
        }
        _ => {}
    }
}

fn sh_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

/// Rebuild the fixture home with executable `--version` stubs and run one case.
async fn replay(name: &str) -> (Value, Value) {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().to_string_lossy().into_owned();
    let mut case = fixture(name);
    replace_home(&mut case, &home);
    let pacer_home = Path::new(&home).join(".pacer");
    for (path, content) in case["files"].as_object().unwrap() {
        let target = pacer_home.join(path);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(target, content.as_str().unwrap()).unwrap();
    }
    std::fs::create_dir_all(pacer_home.join("state")).unwrap();
    for (name, binary) in case["ctx"]["which"].as_object().unwrap() {
        let binary = binary.as_str().unwrap();
        std::fs::create_dir_all(Path::new(binary).parent().unwrap()).unwrap();
        let answer = &case["ctx"]["run"][binary];
        let script = format!(
            "#!/bin/sh\nprintf %s {}\nprintf %s {} >&2\nexit {}\n",
            sh_quote(answer["stdout"].as_str().unwrap_or("")),
            sh_quote(answer["stderr"].as_str().unwrap_or("")),
            answer["code"].as_u64().unwrap_or(0)
        );
        std::fs::write(binary, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let _ = name;
    }
    let env: HashMap<String, String> = case["ctx"]["env"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_owned()))
        .collect();
    let ctx = Ctx::with(
        Path::new(&home).to_path_buf(),
        pacer_home,
        env,
        case["ctx"]["now"].as_f64().unwrap(),
    );
    let cache = VersionCache::default();
    if case["prime"] == true {
        let mut params = case["params"].clone();
        params["cached"] = json!(false);
        dispatch_parts(&ctx, &params, &cache).await.unwrap();
    }
    let got = dispatch_parts(&ctx, &case["params"], &cache).await.unwrap();
    (got, case["expected"].clone())
}

#[tokio::test]
async fn every_recorded_dispatch_part_matches_typescript() {
    for name in [
        "guards-basic",
        "guards-blocked",
        "guards-draft",
        "exclusions-uncached",
        "exclusions-cached",
        "exclusions-cached-after-probe",
        "diagnostics",
    ] {
        let (got, expected) = replay(name).await;
        assert_eq!(got, expected, "fixture {name}");
    }
}

#[test]
fn the_version_cache_is_per_process_and_keyed_by_binary() {
    let cache = VersionCache::default();
    assert!(cache.get("/nonexistent/bin").is_none());
    cache.insert("/x/claude".into(), "2.1.281".into());
    assert_eq!(cache.get("/x/claude").as_deref(), Some("2.1.281"));
    assert!(cache.get("/y/claude").is_none());
}
