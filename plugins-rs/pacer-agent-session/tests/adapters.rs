//! Adapter tests for `pacer-agent-session` (M3 C3), transcribed from
//! `test/agent-session-adapters.test.ts`, `test/session-agent-probe.test.ts`
//! (plugin part) and `test/session-agent-reporting.test.ts` (plugin part).
//! Each scenario drives `agentSession.*` through the Rust harness.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use pacer_plugin::testing::{Harness, HelloSpec};
use serde_json::{Value, json};

fn base_value() -> Value {
    json!({
        "request": "--dangerous $(echo hi)\n日本語",
        "workspace": "/tmp/repo",
        "runDir": "/tmp/run",
        "attachments": [],
        "permissionPolicy": "native",
    })
}

const IMAGE: &str = "/tmp/files/image with spaces";
const IDENTITY: &str = "01a15fa2-5a28-7bb0-9b62-6a4434975b55";
const CODEX_HELP: &str =
    "--config --cd --sandbox --add-dir --model --image --dangerously-bypass-hook-trust --no-daemon";

fn image_value() -> Value {
    json!({
        "id": "image",
        "name": "screen.png",
        "mime": "image/png",
        "size": 1,
        "path": IMAGE,
    })
}

async fn call(h: &mut Harness, method: &str, params: Value) -> Value {
    h.call(method, params).await.unwrap()
}

async fn call_err(h: &mut Harness, method: &str, params: Value) -> (String, String) {
    let err = h.call(method, params).await.unwrap_err();
    (err.code, err.message)
}

fn argv(launch: &Value) -> Vec<Value> {
    launch
        .get("argv")
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("expected argv"))
        .clone()
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.chars().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

// TS: test/agent-session-adapters.test.ts:4 "delegation adapters describe native blocking paths"
#[tokio::test]
async fn delegation_adapters_describe_native_blocking_paths() {
    let mut h = Harness::start(pacer_bundled_agent_session::plugin(), HelloSpec::default()).await;
    for (agent, version, expected) in [
        (
            "claude-code",
            "2.1.281",
            json!({"mechanism":"hook","entryPoints":["Agent","Task"]}),
        ),
        (
            "codex",
            "0.164.0",
            json!({"mechanism":"hook","entryPoints":["spawn_agent"]}),
        ),
        (
            "cursor",
            "2026.01.28",
            json!({"mechanism":"hook","entryPoints":["subagentStart"]}),
        ),
        (
            "opencode",
            "2.1.2",
            json!({"mechanism":"permission","entryPoints":["subagent"],"permissionAction":"subagent"}),
        ),
        (
            "opencode",
            "1.4.0",
            json!({"mechanism":"permission","entryPoints":["task"],"permissionAction":"task"}),
        ),
        (
            "unknown",
            "1",
            json!({"mechanism":"unsupported","entryPoints":[],"reason":"No native subagent control adapter for unknown"}),
        ),
    ] {
        let r = call(
            &mut h,
            "agentSession.delegationControl",
            json!({ "agent": agent, "version": version }),
        )
        .await;
        assert_eq!(r, expected, "delegationControl({{agent: {agent}}})");
    }
    h.close().await;
}

// TS: test/agent-session-adapters.test.ts:17 "offers implemented capabilities without an exact version lock"
#[tokio::test]
async fn capabilities_without_an_exact_version_lock() {
    let mut h = Harness::start(pacer_bundled_agent_session::plugin(), HelloSpec::default()).await;
    for (agent, version) in [
        ("codex", "0.164.0"),
        ("codex", "0.165.1"),
        ("claude-code", "2.1.281"),
        ("opencode", "2.1.2"),
    ] {
        let r = call(
            &mut h,
            "agentSession.capabilities",
            json!({ "agent": agent, "version": version }),
        )
        .await;
        assert_eq!(r["interactive"], true, "{agent}");
        assert_eq!(r["resume"], true, "{agent}");
        assert_eq!(r["files"], true, "{agent}");
        assert_eq!(r["liveImages"], false, "{agent}");
        assert_eq!(r["launchImages"], agent == "codex", "{agent}");
    }
    h.close().await;
}

// TS: test/agent-session-adapters.test.ts:20 "resume uses only the stored identity"
#[tokio::test]
async fn resume_uses_only_the_stored_identity() {
    let mut h = Harness::start(pacer_bundled_agent_session::plugin(), HelloSpec::default()).await;
    for (agent, version) in [
        ("codex", "0.164.0"),
        ("codex", "0.165.1"),
        ("claude-code", "2.1.281"),
        ("opencode", "2.1.2"),
    ] {
        let mut params = base_value();
        params["agent"] = json!(agent);
        params["version"] = json!(version);
        params["sessionId"] = json!(IDENTITY);
        params["attachments"] = json!([image_value()]);
        let launch = call(&mut h, "agentSession.prepare", params).await;
        let a = argv(&launch);
        assert!(
            a.contains(&json!(IDENTITY)),
            "{agent} keeps the stored identity"
        );
        assert!(
            !a.contains(&json!(base_value().get("request").unwrap())),
            "{agent} drops the prompt"
        );
        assert!(!a.contains(&json!(IMAGE)), "{agent} drops the image path");
        assert!(!a.contains(&json!("--prompt")), "{agent} no --prompt");
        assert!(
            !a.contains(&json!("--session-id")),
            "{agent} no --session-id"
        );
    }
    h.close().await;
}

// TS: test/agent-session-adapters.test.ts:29 "Codex delivers initial images natively"
#[tokio::test]
async fn codex_delivers_initial_images_natively() {
    let mut h = Harness::start(pacer_bundled_agent_session::plugin(), HelloSpec::default()).await;
    let mut params = base_value();
    params["agent"] = json!("codex");
    params["version"] = json!("0.164.0");
    params["attachments"] = json!([image_value()]);
    params["model"] = json!("chosen");
    let launch = call(&mut h, "agentSession.prepare", params).await;
    let a = argv(&launch);
    let request = base_value()
        .get("request")
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        a,
        json!([
            "codex",
            "--no-daemon",
            "-C",
            "/tmp/repo",
            "-s",
            "workspace-write",
            "--add-dir",
            "/tmp/run",
            "-m",
            "chosen",
            "-i",
            IMAGE,
            "--",
            request
        ])
        .as_array()
        .unwrap()
        .clone()
    );
    h.close().await;
}

// TS: test/agent-session-adapters.test.ts:35 "Codex sessions keep the workspace-write sandbox"
#[tokio::test]
async fn codex_sessions_keep_the_workspace_write_sandbox() {
    let mut h = Harness::start(pacer_bundled_agent_session::plugin(), HelloSpec::default()).await;
    let help_no_daemon = CODEX_HELP.replace(" --no-daemon", "");
    let inputs: Vec<(Value, bool, bool)> = vec![
        (base_value(), false, false),
        (
            {
                let mut p = base_value();
                p["model"] = json!("chosen");
                p["attachmentDir"] = json!("/tmp/files");
                p["attachments"] = json!([image_value()]);
                p
            },
            false,
            true,
        ),
        (
            {
                let mut p = base_value();
                p["sessionId"] = json!(IDENTITY);
                p
            },
            true,
            false,
        ),
        (
            {
                let mut p = base_value();
                p["help"] = json!(CODEX_HELP);
                p["resumeHelp"] = json!(CODEX_HELP);
                p["sessionId"] = json!(IDENTITY);
                p["model"] = json!("chosen");
                p
            },
            true,
            false,
        ),
        (
            {
                let mut p = base_value();
                p["help"] = json!(help_no_daemon.as_str());
                p
            },
            false,
            false,
        ),
    ];
    let valued = ["-C", "-s", "--add-dir", "-m", "-i"];
    let forbidden = [
        "--allow-unix-socket",
        "--sandbox",
        "-c",
        "--config",
        "-P",
        "--profile",
        "--full-auto",
        "--dangerously-bypass-approvals-and-sandbox",
        "--yolo",
        "danger-full-access",
    ];
    for (input, resumed, attachment_dir) in inputs {
        let mut params = input;
        params["agent"] = json!("codex");
        params["version"] = json!("0.166.0");
        let launch_args = argv(&call(&mut h, "agentSession.prepare", params).await);
        let dash = launch_args
            .iter()
            .position(|v| v == &json!("--"))
            .expect("-- present");
        let options: Vec<Value> = launch_args[..dash].to_vec();
        let prefix_len = if options.get(1) == Some(&json!("resume")) {
            2
        } else {
            1
        };
        let prefix: Vec<Value> = options[..prefix_len].to_vec();
        assert_eq!(
            prefix,
            if resumed {
                json!(["codex", "resume"]).as_array().unwrap().clone()
            } else {
                json!(["codex"]).as_array().unwrap().clone()
            }
        );
        let (mut sandboxes, mut writable) = (Vec::new(), Vec::new());
        let mut i = if resumed { 2 } else { 1 };
        while i < options.len() {
            let option = options[i].as_str().unwrap();
            assert!(
                option == "--no-daemon" || valued.contains(&option),
                "unexpected codex option {option}"
            );
            if option == "-s" {
                sandboxes.push(options[i + 1].as_str().unwrap().to_owned());
            }
            if option == "--add-dir" {
                writable.push(options[i + 1].as_str().unwrap().to_owned());
            }
            if valued.contains(&option) {
                i += 1;
            }
            i += 1;
        }
        assert_eq!(sandboxes, vec!["workspace-write"]);
        assert_eq!(
            writable,
            if attachment_dir {
                vec!["/tmp/run", "/tmp/files"]
            } else {
                vec!["/tmp/run"]
            }
        );
        for f in forbidden {
            assert!(!options.contains(&json!(f)), "forbidden {f}");
        }
        let joined = options
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect::<Vec<_>>()
            .join(" ");
        for pat in [
            "unix_socket",
            "network_access",
            "sandbox_workspace_write",
            "sandbox_mode",
        ] {
            assert!(!joined.contains(pat), "forbidden pattern {pat}");
        }
    }
    h.close().await;
}

// TS: test/agent-session-adapters.test.ts:64 "Claude starts with an assigned native UUID"
#[tokio::test]
async fn claude_starts_with_an_assigned_native_uuid() {
    let mut h = Harness::start(pacer_bundled_agent_session::plugin(), HelloSpec::default()).await;
    let mut params = base_value();
    params["agent"] = json!("claude-code");
    params["version"] = json!("2.1.281");
    params["newSessionId"] = json!(IDENTITY);
    params["model"] = json!("sonnet");
    params["attachmentDir"] = json!("/tmp/files");
    params["attachments"] = json!([image_value()]);
    let launch = call(&mut h, "agentSession.prepare", params).await;
    let a = argv(&launch);
    assert_eq!(
        a[..9],
        json!([
            "claude",
            "--add-dir",
            "/tmp/run",
            "--add-dir",
            "/tmp/files",
            "--model",
            "sonnet",
            "--session-id",
            IDENTITY
        ])
        .as_array()
        .unwrap()[..]
    );
    assert_eq!(a[a.len() - 2], json!("--"));
    let last = a.last().unwrap().as_str().unwrap();
    let base = base_value();
    let request = base.get("request").unwrap().as_str().unwrap();
    assert!(last.contains(request));
    assert!(last.contains(IMAGE));
    assert!(!a.contains(&json!("--dangerously-skip-permissions")));
    h.close().await;
}

// TS: test/agent-session-adapters.test.ts:72 "OpenCode uses a private server and explicit identity"
#[tokio::test]
async fn opencode_uses_a_private_server_and_explicit_identity() {
    let mut h = Harness::start(pacer_bundled_agent_session::plugin(), HelloSpec::default()).await;
    let mut params = base_value();
    params["agent"] = json!("opencode");
    params["version"] = json!("2.1.2");
    params["newSessionId"] = json!("ses_native");
    params["model"] = json!("provider/model");
    params["attachments"] = json!([image_value()]);
    let launch = call(&mut h, "agentSession.prepare", params).await;
    let a = argv(&launch);
    assert_eq!(
        a[..5],
        json!([
            "opencode",
            "--standalone",
            "--session",
            "ses_native",
            "--prompt"
        ])
        .as_array()
        .unwrap()[..]
    );
    assert!(a.last().unwrap().as_str().unwrap().contains(IMAGE));
    assert!(!a.contains(&json!("-m")));
    assert!(!a.contains(&json!("--auto")));
    assert_eq!(launch["cwd"], "/tmp/repo");
    assert_eq!(launch["reporting"]["configEnv"], "OPENCODE_CONFIG_CONTENT");
    assert_eq!(launch["reporting"]["configKey"], "plugins");
    assert!(launch["reporting"]["source"].is_string());
    h.close().await;
}

// TS: test/agent-session-adapters.test.ts:80 "unsupported agents report their actual agent name"
#[tokio::test]
async fn unsupported_agents_report_their_actual_name() {
    let mut h = Harness::start(pacer_bundled_agent_session::plugin(), HelloSpec::default()).await;
    let cap = call(
        &mut h,
        "agentSession.capabilities",
        json!({ "agent": "cursor", "version": "1.0.0" }),
    )
    .await;
    assert_eq!(cap["interactive"], false);
    assert!(cap["reason"].as_str().unwrap().contains("cursor"));
    let mut params = base_value();
    params["agent"] = json!("cursor");
    params["version"] = json!("1.0.0");
    let (code, message) = call_err(&mut h, "agentSession.prepare", params).await;
    assert_eq!(code, "not_allowed");
    assert!(message.contains("cursor"));
    h.close().await;
}

// TS: test/agent-session-adapters.test.ts:84 "interface probes reject missing required mechanisms"
#[tokio::test]
async fn interface_probes_reject_missing_mechanisms() {
    let mut h = Harness::start(pacer_bundled_agent_session::plugin(), HelloSpec::default()).await;
    let r = call(
        &mut h,
        "agentSession.capabilities",
        json!({ "agent": "claude-code", "version": "unknown", "help": "--session-id --resume --add-dir --model --settings" }),
    )
    .await;
    assert_eq!(r["interactive"], true);
    let r = call(
        &mut h,
        "agentSession.capabilities",
        json!({ "agent": "claude-code", "version": "2.1.281", "help": "--session-id --add-dir --model --settings" }),
    )
    .await;
    assert_eq!(r["interactive"], false);
    assert!(r["reason"].as_str().unwrap().contains("--resume"));
    let r = call(
        &mut h,
        "agentSession.capabilities",
        json!({ "agent": "codex", "version": "0.164.0", "help": "" }),
    )
    .await;
    assert_eq!(r["interactive"], false);
    h.close().await;
}

// TS: test/agent-session-adapters.test.ts:89 "optional no-daemon is omitted when not advertised"
#[tokio::test]
async fn optional_no_daemon_is_omitted_when_not_advertised() {
    let mut h = Harness::start(pacer_bundled_agent_session::plugin(), HelloSpec::default()).await;
    let help = "--config --cd --sandbox --add-dir --model --image --dangerously-bypass-hook-trust";
    let mut params = base_value();
    params["agent"] = json!("codex");
    params["version"] = json!("0.200.0");
    params["help"] = json!(help);
    params["resumeHelp"] = json!(help);
    let a = argv(&call(&mut h, "agentSession.prepare", params).await);
    assert!(!a.contains(&json!("--no-daemon")));
    h.close().await;
}

// TS: test/agent-session-adapters.test.ts:95 "later attachment is an explicit reference"
#[tokio::test]
async fn later_attachment_is_an_explicit_reference() {
    let mut h = Harness::start(pacer_bundled_agent_session::plugin(), HelloSpec::default()).await;
    for agent in ["codex", "claude-code", "opencode"] {
        let r = call(
            &mut h,
            "agentSession.attachment",
            json!({ "agent": agent, "version": "1.0.0", "workspace": "/tmp/repo", "phase": "live", "attachment": image_value() }),
        )
        .await;
        assert_eq!(
            r,
            json!({
                "kind": "reference",
                "text": format!("Use the attached file \"screen.png\" at \"{}\".", IMAGE),
                "requiresUserSubmit": true,
            }),
            "{agent}"
        );
    }
    h.close().await;
}

// TS: test/agent-session-adapters.test.ts:100 "identity mechanisms belong to the adapter"
#[tokio::test]
async fn identity_mechanisms_belong_to_the_adapter() {
    let mut h = Harness::start(pacer_bundled_agent_session::plugin(), HelloSpec::default()).await;
    let r = call(
        &mut h,
        "agentSession.identity",
        json!({ "agent": "claude-code", "version": "2.1.281", "taskId": "task" }),
    )
    .await;
    assert_eq!(r["kind"], "assigned");
    assert!(is_uuid(r["id"].as_str().unwrap()));

    let r = call(
        &mut h,
        "agentSession.identity",
        json!({ "agent": "opencode", "version": "2.1.2", "taskId": "task" }),
    )
    .await;
    assert_eq!(
        r,
        json!({
            "kind": "command",
            "argv": ["opencode", "api", "--standalone", "session.create", "--data", "{\"title\":\"pacer task\",\"agent\":\"build\"}"],
            "idPath": ["data", "id"],
        })
    );

    let r = call(&mut h, "agentSession.identity", json!({ "agent": "opencode", "version": "2.1.2", "taskId": "task", "sessionId": "ses_exact" })).await;
    assert_eq!(r["kind"], "command");
    assert_eq!(
        r["argv"],
        json!([
            "opencode",
            "api",
            "--standalone",
            "session.get",
            "--param",
            "sessionID=ses_exact"
        ])
    );

    let r = call(
        &mut h,
        "agentSession.identity",
        json!({ "agent": "opencode", "version": "2.1.2", "taskId": "task", "model": "p/m" }),
    )
    .await;
    let data = r["argv"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()
        .as_str()
        .unwrap();
    assert_eq!(
        data,
        "{\"title\":\"pacer task\",\"agent\":\"build\",\"model\":{\"providerID\":\"p\",\"id\":\"m\"}}"
    );

    let (code, _) = call_err(
        &mut h,
        "agentSession.identity",
        json!({ "agent": "opencode", "version": "2.1.2", "taskId": "task", "model": "bad" }),
    )
    .await;
    assert_eq!(code, "invalid_input");

    let r = call(
        &mut h,
        "agentSession.identity",
        json!({ "agent": "codex", "version": "0.164.0" }),
    )
    .await;
    assert_eq!(r, json!({ "kind": "none" }));
    h.close().await;
}

// TS: test/session-agent-probe.test.ts:7 "a newer compatible CLI is supported" (plugin part)
#[tokio::test]
async fn newer_compatible_cli_is_supported() {
    let mut h = Harness::start(pacer_bundled_agent_session::plugin(), HelloSpec::default()).await;
    let r = call(
        &mut h,
        "agentSession.capabilities",
        json!({ "agent": "codex", "version": "0.164.0", "help": CODEX_HELP }),
    )
    .await;
    assert_eq!(r["interactive"], true);
    h.close().await;
}

// TS: test/session-agent-probe.test.ts:31 "unparseable version allowed when interface compatible" (plugin part)
#[tokio::test]
async fn unparseable_version_allowed_when_interface_compatible() {
    let mut h = Harness::start(pacer_bundled_agent_session::plugin(), HelloSpec::default()).await;
    let r = call(
        &mut h,
        "agentSession.capabilities",
        json!({ "agent": "codex", "version": "unknown", "help": CODEX_HELP }),
    )
    .await;
    assert_eq!(r["interactive"], true);
    h.close().await;
}

// Brief: "fresh_and_resume_identity_together_is_refused"
#[tokio::test]
async fn fresh_and_resume_identity_together_is_refused() {
    let mut h = Harness::start(pacer_bundled_agent_session::plugin(), HelloSpec::default()).await;
    let mut params = base_value();
    params["agent"] = json!("codex");
    params["version"] = json!("0.164.0");
    params["sessionId"] = json!(IDENTITY);
    params["newSessionId"] = json!("ses_fresh");
    let (code, message) = call_err(&mut h, "agentSession.prepare", params).await;
    assert_eq!(code, "invalid_input");
    assert_eq!(
        message,
        "Choose a fresh identity or a resume identity, not both."
    );
    h.close().await;
}
