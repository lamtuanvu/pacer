use super::resolve;
use serde_json::json;

#[test]
fn resolves_every_runner_reference_form() {
    let strategy = json!({
        "accounts": {
            "work": {"name":"work","kind":"codex","home":null,"orcaAccount":null},
            "named": {"name":"named","kind":"codex","home":"/sandbox/named","orcaAccount":null},
            "api": {"name":"api","kind":"endpoint","home":null,"orcaAccount":null}
        },
        "runners": {
            "codex": {"id":"codex"},
            "codex#named": {"id":"codex#named"},
            "codex@remote": {"id":"codex@remote"},
            "opencode#api": {"id":"opencode#api"}
        },
        "runnerAliases": {"fast":"codex#named"}
    });
    for (reference, canonical) in [
        ("codex", "codex"),
        ("codex#work", "codex"),
        ("codex#work@local", "codex"),
        ("codex@remote", "codex@remote"),
        ("codex#work@remote", "codex@remote"),
        ("fast", "codex#named"),
        ("api", "opencode#api"),
        ("opencode#api", "opencode#api"),
    ] {
        assert_eq!(
            resolve(&strategy, reference),
            strategy["runners"].get(canonical)
        );
    }
    for reference in [
        "missing",
        "codex@missing",
        "codex#other",
        "codex##work",
        "CODEX",
        "codex@remote@other",
        "opencode",
    ] {
        assert!(resolve(&strategy, reference).is_none(), "{reference}");
    }
}
