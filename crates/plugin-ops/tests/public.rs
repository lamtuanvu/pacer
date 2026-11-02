#![allow(clippy::unwrap_used)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_plugin_ops::public::{Entry, OPERATIONS, PublicOperations, Runtime};
use serde_json::{Value, json};
use std::fs;
struct Host {
    entries: Vec<Entry>,
    calls: Vec<String>,
}
impl Runtime for Host {
    fn refresh(&mut self, ctx: &Ctx) -> Result<Vec<Entry>, CoreError> {
        self.entries
            .retain(|e| e.bundled || ctx.pacer_home.join("plugins").join(&e.id).exists());
        Ok(self.entries.clone())
    }
    fn call<'a>(&'a mut self, _: &'a Ctx, id: &'a str, method: &'a str, _: Value) -> OpFuture<'a> {
        Box::pin(async move {
            self.calls.push(method.into());
            let e = self.entries.iter_mut().find(|e| e.id == id).unwrap();
            if !["idle", "starting", "ready"].contains(&e.state.as_str()) {
                return Err(CoreError::new(
                    Code::PluginUnavailable,
                    format!("plugin {id} is {}", e.state),
                ));
            }
            e.state = "ready".into();
            e.pid = Some(123);
            e.protocol = Some("1.10.0".into());
            e.served = vec!["diagnostic".into(), "ui".into()];
            Ok(json!({}))
        })
    }
}
fn fixture() -> (tempfile::TempDir, Ctx, Host, PublicOperations) {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().canonicalize().unwrap();
    let ctx = Ctx::with(home.clone(), home, Default::default(), 0.0);
    fs::write(
        ctx.pacer_home.join("strategy.yaml"),
        "planner: claude-code\nproviders:\n  claude-code: {}\n# keep me\n",
    )
    .unwrap();
    fs::create_dir_all(ctx.pacer_home.join("plugins/fx-ui")).unwrap();
    let manifest = json!({"id":"fx-ui","version":"1.0.0","publisher":"fixture","host":"*","capabilities":[{"name":"config.get"}],"contributes":{"ui":{"activity":[{"id":"checklist","title":"Checklist","icon":"list","view":"main"}],"panelTabs":[{"id":"checklist-tab","title":"Checklist","icon":"list","view":"main","context":"task"}],"status":[{"id":"open-items","title":"Items","view":"status"}],"settings":[{"id":"settings","title":"Settings","schema":{"fields":{"required":{"type":"boolean","title":"Required"},"items":{"type":"array","title":"Items","items":{"type":"string"},"maxItems":10}}}}]}}});
    let host = Host {
        entries: vec![Entry {
            id: "fx-ui".into(),
            manifest: Some(manifest),
            bundled: false,
            grant: Value::Null,
            state: "needs_grant".into(),
            error: None,
            pid: None,
            served: vec![],
            protocol: None,
            restarts: 0,
        }],
        calls: vec![],
    };
    (dir, ctx, host, PublicOperations::default())
}
#[tokio::test]
async fn registry_falls_back_until_the_single_owner_is_installed() {
    let (_dir, ctx, host, _) = fixture();
    let mut fallback = pacer_plugin_ops::public::PublicRegistry::default();
    assert!(fallback.native_names().is_empty());
    for op in OPERATIONS {
        assert!(fallback.dispatch(&ctx, op, json!({})).await.is_none());
    }
    let mut native = pacer_plugin_ops::public::PublicRegistry::with_runtime(Box::new(host));
    assert_eq!(native.native_names(), OPERATIONS);
    assert!(
        native
            .dispatch(&ctx, "plugin.list", json!({}))
            .await
            .unwrap()
            .is_ok()
    );
    assert!(
        native
            .dispatch(&ctx, "plugin.list", Value::Null)
            .await
            .unwrap()
            .is_ok()
    );
    for op in [
        "plugin.install",
        "plugin.enable",
        "plugin.disable",
        "plugin.remove",
        "plugin.ui.action",
        "plugin.ui.visibility",
        "plugin.settings.set",
    ] {
        assert!(native.dispatch(&ctx, op, json!({})).await.is_none(), "{op}");
    }
}
#[tokio::test]
async fn plugin_list_uses_javascript_locale_order() {
    let (_dir, ctx, mut host, ops) = fixture();
    for id in ["Zeta", "alpha", "a_b", "a-b"] {
        let mut entry = host.entries[0].clone();
        entry.id = id.into();
        entry.bundled = true;
        host.entries.push(entry);
    }
    host.entries[0].bundled = true;
    let result = ops
        .call(&ctx, &mut host, "plugin.list", json!({}))
        .await
        .unwrap();
    let ids: Vec<_> = result["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["a_b", "a-b", "alpha", "fx-ui", "Zeta"]);
}

#[tokio::test]
async fn ui_list_does_not_read_or_quarantine_settings_for_plugins_without_ui() {
    let (_dir, ctx, mut host, ops) = fixture();
    host.entries[0].state = "idle".into();
    host.entries[0].manifest.as_mut().unwrap()["contributes"] = json!({});
    let path = ctx.pacer_home.join("plugin-settings.json");
    fs::write(&path, "{broken").unwrap();
    let result = ops
        .call(&ctx, &mut host, "plugin.ui.list", json!({}))
        .await
        .unwrap();
    assert_eq!(result, json!({"surfaces":[]}));
    assert_eq!(fs::read_to_string(path).unwrap(), "{broken");
}
