#![allow(clippy::unwrap_used)]
use super::*;

#[test]
fn node_join_matches_path_join() {
    for (parts, joined) in [
        (
            &["/h", "strategies", "work.yaml"][..],
            "/h/strategies/work.yaml",
        ),
        (
            &["/h", "strategies", "/etc/x.yaml"],
            "/h/strategies/etc/x.yaml",
        ),
        (
            &["/h", "strategies", "x/../work.yaml"],
            "/h/strategies/work.yaml",
        ),
        (&["/h", "strategies", "../../../../x.yaml"], "/x.yaml"),
        (&["/h/./a//", "strategy.yaml"], "/h/a/strategy.yaml"),
        (&["h", "..", "..", "x.yaml"], "../x.yaml"),
        (&["h", "..", ""], "."),
        (&["/", "strategy.yaml"], "/strategy.yaml"),
    ] {
        assert_eq!(node_join(parts), joined, "{parts:?}");
    }
}

#[test]
fn forwards_runtime_text_other_paths_and_bun_yaml_shapes() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let load = || native_load(home);
    assert!(matches!(load(), Some(Err(StrategyError::Missing(_)))));
    fs::write(home.join("strategy.yaml"), "planner: nobody\n").unwrap();
    assert!(matches!(load(), Some(Err(StrategyError::Invalid { .. }))));
    for text in [
        "planner: [\n",
        "",
        "\tplanner: nobody\n",
        "a: 1\n---\nb: 2\n",
    ] {
        fs::write(home.join("strategy.yaml"), text).unwrap();
        assert!(load().is_none(), "{text:?}");
    }
    fs::write(
        home.join("strategy.yaml"),
        "planner: claude-code\nproviders: {claude-code: {}}\nterminal: {open: \"x {cmd} '\"}\n",
    )
    .unwrap();
    assert!(matches!(load(), Some(Err(StrategyError::Other(_)))));
    fs::remove_file(home.join("strategy.yaml")).unwrap();
    fs::create_dir(home.join("strategy.yaml")).unwrap();
    assert!(load().is_none());
    // `path.join` resolves these active names elsewhere than `Path::join`.
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("work.yaml"), "planner: nobody\n").unwrap();
    let absolute = outside.path().join("work");
    for active in [absolute.to_str().unwrap(), "x/../work", ".//work"] {
        fs::write(home.join("active"), active).unwrap();
        assert!(load().is_none(), "{active:?}");
    }
    fs::write(home.join("active"), "work\n").unwrap();
    assert!(matches!(load(), Some(Err(StrategyError::Missing(_)))));
    assert!(native_load(&home.join("x/../y")).is_none());
}

#[test]
fn yaml_shapes_bun_reads_differently() {
    for text in [
        "\tplanner: x\n",
        "planner: \"a\tb\"\n",
        "a: 1\n---\nb: 2\n",
        "a: 1\r---\rb: 2\r",
        "a: 1\n...\n",
        "---\n---\na: 1\n",
        "%YAML 1.2\n---\na: 1\n",
        "<<: {a: 1}\n",
        "\"<<\": {a: 1}\n",
        "a:\n  __proto__: {}\n",
        "{a: |}\n",
        "a: [>]\n",
        "{a: !}\n",
        "a: &k {b: 1}\nc: *k\n",
    ] {
        assert!(yaml_may_differ(text), "{text:?}");
    }
    for text in [
        "planner: x\n",
        "---\nplanner: x\n",
        "--- # c\nplanner: x\n",
        "---x: 1\n",
        "a: |\n  x\n",
        "a: {k: v}\nb: [c]\n",
        "a: |\n  ---\n",
    ] {
        assert!(!yaml_may_differ(text), "{text:?}");
    }
}

#[test]
fn load_native_answers_every_bun_yaml_shape() {
    let home = tempfile::tempdir().unwrap();
    let cases: &[(&str, &str)] = &[
        ("", "top level must be a mapping"),
        ("# nothing\n", "top level must be a mapping"),
        ("a: 1\n---\nb: 2\n", "top level must be a mapping"),
        ("a: 1\r---\rb: 2\r", "top level must be a mapping"),
        ("---\n---\na: 1\n", "top level must be a mapping"),
        ("%YAML 1.2\n---\nplanner: nobody\n", "runner nobody: invalid runner id or unknown agent"),
        ("planner: [\n", "YAML syntax error: YAML Parse error: Unexpected token"),
        ("\tplanner: x\n", "YAML Parse error: Tab characters cannot be used as indentation"),
        ("{a: |}\n", "YAML Parse error: Unexpected token"),
        ("a: [>]\n", "YAML Parse error: Unexpected token"),
        ("{a: !}\n", "YAML Parse error: Unexpected character"),
        ("base: &b {planner: nobody}\n<<: *b\n", "runner nobody: invalid runner id or unknown agent"),
        ("\"<<\": {planner: nobody}\n", "runner nobody: invalid runner id or unknown agent"),
    ];
    for (text, expected) in cases {
        fs::write(home.path().join("strategy.yaml"), text).unwrap();
        let error = load_native(home.path()).unwrap_err().to_string();
        assert!(error.contains(expected), "{text:?}: {error}");
    }
}

#[test]
fn load_native_uses_node_path_join_and_node_io_text() {
    let home = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("work.yaml"), "planner: nobody\n").unwrap();
    for active in [
        outside.path().join("work").display().to_string(),
        "x/../work".into(),
        ".//work".into(),
    ] {
        fs::write(home.path().join("active"), &active).unwrap();
        let error = load_native(home.path()).unwrap_err().to_string();
        assert!(error.starts_with("no strategy found at "), "{active}: {error}");
        assert!(error.contains("strategies/"), "{active}: {error}");
    }
    fs::remove_file(home.path().join("active")).unwrap();
    fs::create_dir(home.path().join("strategy.yaml")).unwrap();
    assert_eq!(
        load_native(home.path()).unwrap_err().to_string(),
        "EISDIR: illegal operation on a directory, read"
    );
    fs::remove_dir(home.path().join("strategy.yaml")).unwrap();
    fs::write(home.path().join("strategy.yaml"), b"planner: claude-code\n# \xff\n").unwrap();
    assert!(load_native(home.path()).is_err());
}
