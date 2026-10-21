#![allow(clippy::unwrap_used, clippy::expect_used)]
use xtask::deps::{Edge, Policy, check};

#[test]
fn checks_layers_heavy_dependencies_and_unknown_crates() {
    let policy = Policy::from_toml(include_str!("../crates.toml")).unwrap();
    for (from, to) in [
        ("pacer", "pacer-cli"),
        ("pacer-cli", "pacer-server"),
        ("pacer-plugin", "pacer-plugin-protocol"),
        ("pacer-fixtures", "pacer-plugin"),
    ] {
        assert!(check(&policy, &[Edge::internal(from, to)]).is_empty());
    }
    for (from, to) in [
        ("pacer-foundation", "pacer-server"),
        ("pacer-plugin", "pacer-foundation"),
        ("pacer-unknown", "pacer-foundation"),
        ("pacer-server", "pacer"),
        ("pacer-client-protocol", "pacer-plugin-protocol"),
    ] {
        assert!(!check(&policy, &[Edge::internal(from, to)]).is_empty());
    }
    assert!(!check(&policy, &[Edge::external("pacer-foundation", "axum")]).is_empty());
    assert!(!check(&policy, &[Edge::external("pacer-foundation", "reqwest")]).is_empty());
    assert!(check(&policy, &[Edge::external("pacer-server", "axum")]).is_empty());
}

#[test]
fn checks_unused_members_dev_edges_renames_and_default_features() {
    use xtask::deps::{Metadata, check_metadata};
    let policy = Policy::from_toml(include_str!("../crates.toml")).unwrap();
    let metadata: Metadata = serde_json::from_value(serde_json::json!({
        "workspace_members": ["foundation", "unknown", "server", "cli"],
        "packages": [
            {"id":"foundation", "name":"pacer-foundation", "manifest_path":"/workspace/crates/foundation/Cargo.toml",
             "dependencies":[
                {"name":"tokio", "optional":true, "kind":null},
                {"name":"pacer-server", "path":"/workspace/crates/server", "optional":false, "kind":"dev"}
             ], "features":{"default":["runtime"], "runtime":["tokio"]}},
            {"id":"unknown", "name":"unlisted", "manifest_path":"/workspace/crates/new/Cargo.toml", "dependencies":[], "features":{}},
            {"id":"server", "name":"pacer-server", "manifest_path":"/workspace/crates/server/Cargo.toml",
             "dependencies":[{"name":"axum", "rename":"http", "optional":true, "kind":null}],
             "features":{"default":["transport"], "transport":["dep:http"]}},
            {"id":"cli", "name":"pacer-cli", "manifest_path":"/workspace/crates/cli/Cargo.toml",
             "dependencies":[], "features":{"default":["extra"], "extra":["wasm"]}}
        ]
    })).unwrap();
    let errors = check_metadata(&policy, &metadata);
    for expected in [
        "unknown workspace crate unlisted",
        "foundation tokio",
        "composition crate pacer-server",
        "optional subsystem axum",
        "enables wasm by default",
    ] {
        assert!(
            errors.iter().any(|error| error.contains(expected)),
            "missing {expected}: {errors:?}"
        );
    }
}

#[test]
fn sdk_plugin_tool_and_dev_dependency_boundaries() {
    let policy = Policy::from_toml(&format!(
        "{}\n[crates.example-plugin]\nlayer = \"plugin\"\n",
        include_str!("../crates.toml")
    ))
    .unwrap();
    assert!(check(&policy, &[Edge::internal("example-plugin", "pacer-plugin")]).is_empty());
    assert!(
        !check(
            &policy,
            &[Edge::internal("example-plugin", "pacer-client-protocol")]
        )
        .is_empty()
    );
    assert!(check(&policy, &[Edge::internal("xtask", "pacer-foundation")]).is_empty());
    let mut edge = Edge::internal("pacer-client-protocol", "pacer-foundation");
    edge.dev = true;
    assert!(check(&policy, &[edge]).is_empty());
    let mut edge = Edge::internal("xtask", "pacer");
    edge.dev = true;
    assert!(!check(&policy, &[edge]).is_empty());
}
