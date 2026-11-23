#![allow(clippy::unwrap_used)]
use std::{fs, os::unix::fs::PermissionsExt, process::Command};

fn pacer() -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_pacer"));
    c.env_remove("PACER_BIN").env_remove("PACER_CORE_ARGV");
    c
}

/// A fake core that echoes its argv and exits 7, passed through PACER_CORE_ARGV
/// so the front door execs it instead of a real pacer-core.
fn fake_core(dir: &tempfile::TempDir) -> String {
    let fake = dir.path().join("core.sh");
    fs::write(
        &fake,
        "#!/bin/sh\nprintf '%s|' \"$@\"; printf 'BIN=%s|' \"$PACER_BIN\"\nexit 7\n",
    )
    .unwrap();
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
    fake.to_string_lossy().into_owned()
}

fn expected_bin() -> String {
    fs::canonicalize(env!("CARGO_BIN_EXE_pacer"))
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

#[test]
fn plugin_run_runs_in_rust_and_hands_the_id_to_core() {
    let dir = tempfile::tempdir().unwrap();
    let mut cmd = pacer();
    cmd.env(
        "PACER_CORE_ARGV",
        serde_json::to_string(&[fake_core(&dir), "prefix".to_string()]).unwrap(),
    );
    // pacer-planners is still TypeScript; the Rust front door must hand it to
    // pacer-core, which the fake core here stubs out (exit 7).
    let o = cmd
        .args(["plugin", "run", "pacer-planners"])
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(7));
    assert_eq!(
        String::from_utf8(o.stdout).unwrap(),
        format!("prefix|plugin|run|pacer-planners|BIN={}|", expected_bin())
    );
}

#[test]
fn plugin_run_without_an_id_is_a_usage_error() {
    let dir = tempfile::tempdir().unwrap();
    for bad in [vec!["plugin", "run"], vec!["plugin", "run", "a", "b"]] {
        let mut cmd = pacer();
        cmd.env(
            "PACER_CORE_ARGV",
            serde_json::to_string(&[fake_core(&dir), "prefix".to_string()]).unwrap(),
        );
        let o = cmd.args(bad).output().unwrap();
        assert_eq!(o.status.code(), Some(2));
        assert!(
            String::from_utf8(o.stderr)
                .unwrap()
                .contains("usage: pacer plugin run <id>")
        );
        // The fake core never ran for the malformed forms.
        assert_eq!(String::from_utf8(o.stdout).unwrap(), "");
    }
}

#[test]
fn other_plugin_commands_pass_through_to_core() {
    let dir = tempfile::tempdir().unwrap();
    let mut cmd = pacer();
    cmd.env(
        "PACER_CORE_ARGV",
        serde_json::to_string(&[fake_core(&dir), "prefix".to_string()]).unwrap(),
    );
    let o = cmd.args(["plugin", "list"]).output().unwrap();
    assert_eq!(o.status.code(), Some(7));
    assert_eq!(
        String::from_utf8(o.stdout).unwrap(),
        format!("prefix|plugin|list|BIN={}|", expected_bin())
    );
}

/// The native front door answers `plugin.hello` for `pacer-notify` with no
/// pacer-core argv: it is served by the bundled Rust plugin. (M3 C1)
#[test]
fn pacer_notify_answers_hello_natively_without_core() {
    let manifest: serde_json::Value = serde_json::from_str(include_str!(
        "../../../plugins-rs/pacer-notify/manifest.json"
    ))
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let offer = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "plugin.hello",
        "params": {
            "protocol": "1.11.0",
            "features": [
                "chunkedResults", "httpBodyChunks", "fileWriteChunks",
                "plannerInstallTransactions", "policyObservations", "policyRedactionMetadata"
            ],
            "pacer": "0.0.0-test",
            "manifest": manifest,
            "config": {},
            "grants": []
        }
    });
    let mut child = Command::new(env!("CARGO_BIN_EXE_pacer"))
        .env_clear()
        .env("HOME", dir.path())
        .env("PACER_HOME", dir.path().join(".pacer"))
        .env("PATH", "/usr/bin:/bin")
        .args(["plugin", "run", "pacer-notify"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    {
        use std::io::Write;
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(offer.to_string().as_bytes()).unwrap();
        stdin.write_all(b"\n").unwrap();
        drop(stdin); // close stdin → the plugin serves hello and exits 0.
    }
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(0));
    let stdout = String::from_utf8(output.stdout).unwrap();
    let line = stdout
        .lines()
        .find(|l| l.contains("\"id\":\"pacer-notify\""))
        .unwrap_or_else(|| panic!("hello reply missing; stdout:\n{stdout}"));
    let reply: serde_json::Value = serde_json::from_str(line).unwrap();
    let result = &reply["result"];
    assert_eq!(result["id"], "pacer-notify");
    assert_eq!(result["version"], "0.1.0");
    assert_eq!(result["contributes"], serde_json::json!(["notifier"]));
    assert_eq!(
        result["features"],
        serde_json::json!([
            "chunkedResults",
            "httpBodyChunks",
            "fileWriteChunks",
            "plannerInstallTransactions",
            "policyObservations",
            "policyRedactionMetadata"
        ])
    );
}

/// The native front door answers `plugin.hello` for `pacer-remote-caller`
/// with no pacer-core argv: it is served by the bundled Rust plugin. (M3 C2)
#[test]
fn pacer_remote_caller_answers_hello_natively_without_core() {
    let manifest: serde_json::Value = serde_json::from_str(include_str!(
        "../../../plugins-rs/pacer-remote-caller/manifest.json"
    ))
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let offer = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "plugin.hello",
        "params": {
            "protocol": "1.11.0",
            "features": [
                "chunkedResults", "httpBodyChunks", "fileWriteChunks",
                "plannerInstallTransactions", "policyObservations", "policyRedactionMetadata"
            ],
            "pacer": "0.0.0-test",
            "manifest": manifest,
            "config": {},
            "grants": []
        }
    });
    let mut child = Command::new(env!("CARGO_BIN_EXE_pacer"))
        .env_clear()
        .env("HOME", dir.path())
        .env("PACER_HOME", dir.path().join(".pacer"))
        .env("PATH", "/usr/bin:/bin")
        .args(["plugin", "run", "pacer-remote-caller"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    {
        use std::io::Write;
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(offer.to_string().as_bytes()).unwrap();
        stdin.write_all(b"\n").unwrap();
        drop(stdin); // close stdin → the plugin serves hello and exits 0.
    }
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(0));
    let stdout = String::from_utf8(output.stdout).unwrap();
    let line = stdout
        .lines()
        .find(|l| l.contains("\"id\":\"pacer-remote-caller\""))
        .unwrap_or_else(|| panic!("hello reply missing; stdout:\n{stdout}"));
    let reply: serde_json::Value = serde_json::from_str(line).unwrap();
    let result = &reply["result"];
    assert_eq!(result["id"], "pacer-remote-caller");
    assert_eq!(result["version"], "0.1.0");
    assert_eq!(result["contributes"], serde_json::json!(["remoteCaller"]));
    assert_eq!(
        result["features"],
        serde_json::json!([
            "chunkedResults",
            "httpBodyChunks",
            "fileWriteChunks",
            "plannerInstallTransactions",
            "policyObservations",
            "policyRedactionMetadata"
        ])
    );
}

/// The native front door answers `plugin.hello` for `pacer-agent-session`
/// with no pacer-core argv: it is served by the bundled Rust plugin. (M3 C3)
#[test]
fn pacer_agent_session_answers_hello_natively_without_core() {
    let manifest: serde_json::Value = serde_json::from_str(include_str!(
        "../../../plugins-rs/pacer-agent-session/manifest.json"
    ))
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let offer = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "plugin.hello",
        "params": {
            "protocol": "1.11.0",
            "features": [
                "chunkedResults", "httpBodyChunks", "fileWriteChunks",
                "plannerInstallTransactions", "policyObservations", "policyRedactionMetadata"
            ],
            "pacer": "0.0.0-test",
            "manifest": manifest,
            "config": {},
            "grants": []
        }
    });
    let mut child = Command::new(env!("CARGO_BIN_EXE_pacer"))
        .env_clear()
        .env("HOME", dir.path())
        .env("PACER_HOME", dir.path().join(".pacer"))
        .env("PATH", "/usr/bin:/bin")
        .args(["plugin", "run", "pacer-agent-session"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    {
        use std::io::Write;
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(offer.to_string().as_bytes()).unwrap();
        stdin.write_all(b"\n").unwrap();
        drop(stdin); // close stdin → the plugin serves hello and exits 0.
    }
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(0));
    let stdout = String::from_utf8(output.stdout).unwrap();
    let line = stdout
        .lines()
        .find(|l| l.contains("\"id\":\"pacer-agent-session\""))
        .unwrap_or_else(|| panic!("hello reply missing; stdout:\n{stdout}"));
    let reply: serde_json::Value = serde_json::from_str(line).unwrap();
    let result = &reply["result"];
    assert_eq!(result["id"], "pacer-agent-session");
    assert_eq!(result["version"], "1.0.0");
    assert_eq!(result["contributes"], serde_json::json!(["agentSession"]));
    assert_eq!(
        result["features"],
        serde_json::json!([
            "chunkedResults",
            "httpBodyChunks",
            "fileWriteChunks",
            "plannerInstallTransactions",
            "policyObservations",
            "policyRedactionMetadata"
        ])
    );
}

/// The native front door answers `plugin.hello` for `pacer-assistant`
/// with no pacer-core argv: it is served by the bundled Rust plugin. (M3 C4)
#[test]
fn pacer_assistant_answers_hello_natively_without_core() {
    let manifest: serde_json::Value = serde_json::from_str(include_str!(
        "../../../plugins-rs/pacer-assistant/manifest.json"
    ))
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let offer = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "plugin.hello",
        "params": {
            "protocol": "1.11.0",
            "features": [
                "chunkedResults", "httpBodyChunks", "fileWriteChunks",
                "plannerInstallTransactions", "policyObservations", "policyRedactionMetadata"
            ],
            "pacer": "0.0.0-test",
            "manifest": manifest,
            "config": {},
            "grants": []
        }
    });
    let mut child = Command::new(env!("CARGO_BIN_EXE_pacer"))
        .env_clear()
        .env("HOME", dir.path())
        .env("PACER_HOME", dir.path().join(".pacer"))
        .env("PATH", "/usr/bin:/bin")
        .args(["plugin", "run", "pacer-assistant"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    {
        use std::io::Write;
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(offer.to_string().as_bytes()).unwrap();
        stdin.write_all(b"\n").unwrap();
        drop(stdin); // close stdin → the plugin serves hello and exits 0.
    }
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(0));
    let stdout = String::from_utf8(output.stdout).unwrap();
    let line = stdout
        .lines()
        .find(|l| l.contains("\"id\":\"pacer-assistant\""))
        .unwrap_or_else(|| panic!("hello reply missing; stdout:\n{stdout}"));
    let reply: serde_json::Value = serde_json::from_str(line).unwrap();
    let result = &reply["result"];
    assert_eq!(result["id"], "pacer-assistant");
    assert_eq!(result["version"], "1.0.0");
    assert_eq!(result["contributes"], serde_json::json!(["assistant"]));
    assert_eq!(
        result["features"],
        serde_json::json!([
            "chunkedResults",
            "httpBodyChunks",
            "fileWriteChunks",
            "plannerInstallTransactions",
            "policyObservations",
            "policyRedactionMetadata"
        ])
    );
}

/// The native front door answers `plugin.hello` for `pacer-exec-orca`
/// with no pacer-core argv: it is served by the bundled Rust plugin. (M3 C5)
#[test]
fn pacer_exec_orca_answers_hello_natively_without_core() {
    let manifest: serde_json::Value = serde_json::from_str(include_str!(
        "../../../plugins-rs/pacer-exec-orca/manifest.json"
    ))
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let offer = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "plugin.hello",
        "params": {
            "protocol": "1.11.0",
            "features": [
                "chunkedResults", "httpBodyChunks", "fileWriteChunks",
                "plannerInstallTransactions", "policyObservations", "policyRedactionMetadata"
            ],
            "pacer": "0.0.0-test",
            "manifest": manifest,
            "config": {},
            "grants": []
        }
    });
    let mut child = Command::new(env!("CARGO_BIN_EXE_pacer"))
        .env_clear()
        .env("HOME", dir.path())
        .env("PACER_HOME", dir.path().join(".pacer"))
        .env("PATH", "/usr/bin:/bin")
        .args(["plugin", "run", "pacer-exec-orca"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    {
        use std::io::Write;
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(offer.to_string().as_bytes()).unwrap();
        stdin.write_all(b"\n").unwrap();
        drop(stdin); // close stdin → the plugin serves hello and exits 0.
    }
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(0));
    let stdout = String::from_utf8(output.stdout).unwrap();
    let line = stdout
        .lines()
        .find(|l| l.contains("\"id\":\"pacer-exec-orca\""))
        .unwrap_or_else(|| panic!("hello reply missing; stdout:\n{stdout}"));
    let reply: serde_json::Value = serde_json::from_str(line).unwrap();
    let result = &reply["result"];
    assert_eq!(result["id"], "pacer-exec-orca");
    assert_eq!(result["version"], "0.1.0");
    assert_eq!(result["contributes"], serde_json::json!(["executor"]));
    assert_eq!(
        result["features"],
        serde_json::json!([
            "chunkedResults",
            "httpBodyChunks",
            "fileWriteChunks",
            "plannerInstallTransactions",
            "policyObservations",
            "policyRedactionMetadata"
        ])
    );
}

/// The native front door answers `plugin.hello` for `pacer-classify`
/// with no pacer-core argv: it is served by the bundled Rust plugin. (M3 C6)
#[test]
fn pacer_classify_answers_hello_natively_without_core() {
    let manifest: serde_json::Value = serde_json::from_str(include_str!(
        "../../../plugins-rs/pacer-classify/manifest.json"
    ))
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let offer = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "plugin.hello",
        "params": {
            "protocol": "1.11.0",
            "features": [
                "chunkedResults", "httpBodyChunks", "fileWriteChunks",
                "plannerInstallTransactions", "policyObservations", "policyRedactionMetadata"
            ],
            "pacer": "0.0.0-test",
            "manifest": manifest,
            "config": {},
            "grants": []
        }
    });
    let mut child = Command::new(env!("CARGO_BIN_EXE_pacer"))
        .env_clear()
        .env("HOME", dir.path())
        .env("PACER_HOME", dir.path().join(".pacer"))
        .env("PATH", "/usr/bin:/bin")
        .args(["plugin", "run", "pacer-classify"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    {
        use std::io::Write;
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(offer.to_string().as_bytes()).unwrap();
        stdin.write_all(b"\n").unwrap();
        drop(stdin); // close stdin → the plugin serves hello and exits 0.
    }
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(0));
    let stdout = String::from_utf8(output.stdout).unwrap();
    let line = stdout
        .lines()
        .find(|l| l.contains("\"id\":\"pacer-classify\""))
        .unwrap_or_else(|| panic!("hello reply missing; stdout:\n{stdout}"));
    let reply: serde_json::Value = serde_json::from_str(line).unwrap();
    let result = &reply["result"];
    assert_eq!(result["id"], "pacer-classify");
    assert_eq!(result["version"], "0.2.0");
    assert_eq!(result["contributes"], serde_json::json!(["classifier"]));
    assert_eq!(
        result["features"],
        serde_json::json!([
            "chunkedResults",
            "httpBodyChunks",
            "fileWriteChunks",
            "plannerInstallTransactions",
            "policyObservations",
            "policyRedactionMetadata"
        ])
    );
}

/// The native front door answers `plugin.hello` for `pacer-usage` with no
/// pacer-core argv: it is served by the bundled Rust plugin. (M3 C7)
#[test]
fn pacer_usage_answers_hello_natively_without_core() {
    let manifest: serde_json::Value = serde_json::from_str(include_str!(
        "../../../plugins-rs/pacer-usage/manifest.json"
    ))
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let offer = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "plugin.hello",
        "params": {
            "protocol": "1.11.0",
            "features": [
                "chunkedResults", "httpBodyChunks", "fileWriteChunks",
                "plannerInstallTransactions", "policyObservations", "policyRedactionMetadata"
            ],
            "pacer": "0.0.0-test",
            "manifest": manifest,
            "config": {},
            "grants": []
        }
    });
    let mut child = Command::new(env!("CARGO_BIN_EXE_pacer"))
        .env_clear()
        .env("HOME", dir.path())
        .env("PACER_HOME", dir.path().join(".pacer"))
        .env("PATH", "/usr/bin:/bin")
        .args(["plugin", "run", "pacer-usage"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    {
        use std::io::Write;
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(offer.to_string().as_bytes()).unwrap();
        stdin.write_all(b"\n").unwrap();
        drop(stdin); // close stdin → the plugin serves hello and exits 0.
    }
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(0));
    let stdout = String::from_utf8(output.stdout).unwrap();
    let line = stdout
        .lines()
        .find(|l| l.contains("\"id\":\"pacer-usage\""))
        .unwrap_or_else(|| panic!("hello reply missing; stdout:\n{stdout}"));
    let reply: serde_json::Value = serde_json::from_str(line).unwrap();
    let result = &reply["result"];
    assert_eq!(result["id"], "pacer-usage");
    assert_eq!(result["version"], "0.2.0");
    assert_eq!(result["contributes"], serde_json::json!(["usage"]));
    assert_eq!(
        result["features"],
        serde_json::json!([
            "chunkedResults",
            "httpBodyChunks",
            "fileWriteChunks",
            "plannerInstallTransactions",
            "policyObservations",
            "policyRedactionMetadata"
        ])
    );
}

/// The native front door answers `plugin.hello` for `pacer-endpoints` with no
/// pacer-core argv: it is served by the bundled Rust plugin. (M3 C8)
#[test]
fn pacer_endpoints_answers_hello_natively_without_core() {
    let manifest: serde_json::Value = serde_json::from_str(include_str!(
        "../../../plugins-rs/pacer-endpoints/manifest.json"
    ))
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let offer = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "plugin.hello",
        "params": {
            "protocol": "1.11.0",
            "features": [
                "chunkedResults", "httpBodyChunks", "fileWriteChunks",
                "plannerInstallTransactions", "policyObservations", "policyRedactionMetadata"
            ],
            "pacer": "0.0.0-test",
            "manifest": manifest,
            "config": {},
            "grants": []
        }
    });
    let mut child = Command::new(env!("CARGO_BIN_EXE_pacer"))
        .env_clear()
        .env("HOME", dir.path())
        .env("PACER_HOME", dir.path().join(".pacer"))
        .env("PATH", "/usr/bin:/bin")
        .args(["plugin", "run", "pacer-endpoints"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    {
        use std::io::Write;
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(offer.to_string().as_bytes()).unwrap();
        stdin.write_all(b"\n").unwrap();
        drop(stdin); // close stdin → the plugin serves hello and exits 0.
    }
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(0));
    let stdout = String::from_utf8(output.stdout).unwrap();
    let line = stdout
        .lines()
        .find(|l| l.contains("\"id\":\"pacer-endpoints\""))
        .unwrap_or_else(|| panic!("hello reply missing; stdout:\n{stdout}"));
    let reply: serde_json::Value = serde_json::from_str(line).unwrap();
    let result = &reply["result"];
    assert_eq!(result["id"], "pacer-endpoints");
    assert_eq!(result["version"], "0.2.0");
    assert_eq!(result["contributes"], serde_json::json!(["endpoint"]));
    assert_eq!(
        result["features"],
        serde_json::json!([
            "chunkedResults",
            "httpBodyChunks",
            "fileWriteChunks",
            "plannerInstallTransactions",
            "policyObservations",
            "policyRedactionMetadata"
        ])
    );
}
