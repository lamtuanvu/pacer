#![allow(clippy::unwrap_used)]
use super::*;
use pacer_foundation::Ctx;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

struct FakePlugin {
    reply: Result<Value, CoreError>,
    calls: std::sync::Mutex<Vec<Value>>,
    active: AtomicUsize,
    max_active: AtomicUsize,
}

impl FakePlugin {
    fn ok() -> Self {
        Self {
            reply: Ok(json!({
                "env": {"OPENCODE_CONFIG": "/fixture/opencode/opencode.json"},
                "secretEnv": {}
            })),
            calls: std::sync::Mutex::new(Vec::new()),
            active: AtomicUsize::new(0),
            max_active: AtomicUsize::new(0),
        }
    }
    fn error(code: Code) -> Self {
        Self {
            reply: Err(CoreError::new(code, "no enabled plugin provides OpenAI-compatible endpoints")),
            ..Self::ok()
        }
    }
}

impl EndpointPlugin for FakePlugin {
    fn launch_env<'a>(&'a self, _ctx: &'a Ctx, params: Value) -> OpFuture<'a> {
        let now = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_active.fetch_max(now, Ordering::SeqCst);
        self.calls.lock().unwrap().push(params);
        let reply = self.reply.clone();
        Box::pin(async move {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            self.active.fetch_sub(1, Ordering::SeqCst);
            reply
        })
    }
}

fn endpoint_home(with_connection: bool) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let account = if with_connection {
        r#"  work: {kind: endpoint, usage: unmetered, connection: {api: openai-compatible, base_url: "https://example.test/v1", key: none, models: [{id: model, context: 128000, output: 16000, tools: true}]}}
"#
    } else {
        ""
    };
    std::fs::write(
        dir.path().join("strategy.yaml"),
        format!(
            "planner: claude-code\naccounts:\n  claude: {{kind: claude}}\n{account}runners:\n  claude-code: {{}}\nrouting:\n  - default: [claude-code]\n"
        ),
    )
    .unwrap();
    dir
}

fn ctx(dir: &tempfile::TempDir) -> Ctx {
    Ctx::with(dir.path().into(), dir.path().into(), Default::default(), 1_700_000_000.0)
}

#[tokio::test]
async fn writes_managed_config_privately_with_placeholder_credentials() {
    let dir = endpoint_home(true);
    let ctx = ctx(&dir);
    // The fake plugin answers with the exact owned destination for this home.
    let plugin = FakePlugin {
        reply: Ok(json!({
            "env": {"OPENCODE_CONFIG": format!("{}/opencode/opencode.json", dir.path().display())},
            "secretEnv": {}
        })),
        ..FakePlugin::ok()
    };
    sync_endpoint_config(&ctx, &plugin).await.unwrap();
    let path = dir.path().join("opencode/opencode.json");
    let bytes = std::fs::read(&path).unwrap();
    let expected = serde_json::to_string_pretty(&json!({
        "$schema": "https://opencode.ai/config.json",
        "provider": {
            "pacer-work": {
                "npm": "@ai-sdk/openai-compatible",
                "name": "work (pacer)",
                "options": {"baseURL": "https://example.test/v1"},
                "models": {"model": {"name": "model", "limit": {"context": 128000, "output": 16000}, "tool_call": true}}
            }
        }
    })).unwrap() + "\n";
    assert_eq!(String::from_utf8(bytes).unwrap(), expected);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
    }
    let calls = plugin.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["accounts"][0]["keyRef"], Value::Null);
}

#[tokio::test]
async fn plugin_unavailable_is_a_warning_when_a_connection_is_configured() {
    let dir = endpoint_home(true);
    let ctx = ctx(&dir);
    sync_endpoint_config(&ctx, &FakePlugin::error(Code::PluginUnavailable))
        .await
        .unwrap();
    assert!(!dir.path().join("opencode/opencode.json").exists());
    let log = std::fs::read_to_string(dir.path().join("state/activity.jsonl")).unwrap_or_default();
    assert!(log.contains("Settings saved, but the OpenCode endpoint configuration was not updated"));
}

#[tokio::test]
async fn plugin_unavailable_is_silent_without_a_connection() {
    let dir = endpoint_home(false);
    let ctx = ctx(&dir);
    sync_endpoint_config(&ctx, &FakePlugin::error(Code::PluginUnavailable))
        .await
        .unwrap();
    let log = std::fs::read_to_string(dir.path().join("state/activity.jsonl")).unwrap_or_default();
    assert!(!log.contains("endpoint configuration was not updated"));
}

#[tokio::test]
async fn unowned_launch_settings_are_refused() {
    let dir = endpoint_home(true);
    let ctx = ctx(&dir);
    let plugin = FakePlugin {
        reply: Ok(json!({"env": {"OPENCODE_CONFIG": "/outside"}, "secretEnv": {}})),
        ..FakePlugin::ok()
    };
    let error = sync_endpoint_config(&ctx, &plugin).await.unwrap_err();
    assert_eq!(error.code, Code::PluginRefused);
    assert_eq!(error.message, "endpoint plugin returned unowned launch settings");
}

#[tokio::test]
async fn writes_for_one_home_are_serialized() {
    let dir = endpoint_home(true);
    let ctx = ctx(&dir);
    let plugin = Arc::new(FakePlugin {
        reply: Ok(json!({
            "env": {"OPENCODE_CONFIG": format!("{}/opencode/opencode.json", dir.path().display())},
            "secretEnv": {}
        })),
        ..FakePlugin::ok()
    });
    let a = plugin.clone();
    let b = plugin.clone();
    let first = ctx.clone();
    let (_, _) = tokio::join!(
        async move { sync_endpoint_config(&first, &*a).await.unwrap() },
        async move { sync_endpoint_config(&ctx, &*b).await.unwrap() }
    );
    assert_eq!(plugin.max_active.load(Ordering::SeqCst), 1);
    assert_eq!(plugin.calls.lock().unwrap().len(), 2);
}
