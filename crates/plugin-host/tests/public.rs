#![allow(clippy::unwrap_used)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_plugin_host::{
    public::{Entry, OPERATIONS, PublicOperations, Runtime},
    settings,
};
use serde_json::{Value, json};
use std::{fs, os::unix::fs::PermissionsExt};
struct Host {
    pending: bool,
    entries: Vec<Entry>,
    calls: Vec<String>,
    veto: Vec<Value>,
    document: Value,
    ttl: Value,
}
impl Runtime for Host {
    fn refresh(&mut self, ctx: &Ctx) -> Result<Vec<Entry>, CoreError> {
        let cfg = pacer_plugin_host::public_config(ctx)?;
        for e in &mut self.entries {
            if cfg["disabled"]
                .as_array()
                .is_some_and(|a| a.contains(&json!(e.id)))
            {
                e.state = "disabled".into();
            } else if !e.bundled && cfg["installed"].get(&e.id).is_none() {
                e.state = "needs_grant".into();
            } else if !["ready", "failing"].contains(&e.state.as_str()) {
                e.state = "idle".into();
            }
        }
        self.entries
            .retain(|e| e.bundled || ctx.pacer_home.join("plugins").join(&e.id).exists());
        Ok(self.entries.clone())
    }
    fn call<'a>(&'a mut self, _: &'a Ctx, id: &'a str, method: &'a str, _: Value) -> OpFuture<'a> {
        Box::pin(async move {
            self.calls.push(method.into());
            if self.pending {
                std::future::pending::<()>().await;
            }
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
            Ok(match method {
                "ui.render" => json!({"document":self.document,"ttlS":self.ttl}),
                "ui.action" => json!({"result":"refresh","message":"done"}),
                "ui.settings.validate" => {
                    if self.veto.is_empty() {
                        json!({"ok":true})
                    } else {
                        json!({"ok":false,"errors":self.veto})
                    }
                }
                _ => json!({}),
            })
        })
    }
    fn stop<'a>(&'a mut self, _: &'a Ctx, id: &'a str) -> OpFuture<'a> {
        Box::pin(async move {
            if let Some(e) = self.entries.iter_mut().find(|e| e.id == id) {
                e.pid = None;
                e.state = "idle".into();
            }
            Ok(Value::Null)
        })
    }
    fn reset(&mut self, id: &str) {
        if let Some(e) = self.entries.iter_mut().find(|e| e.id == id) {
            e.state = "idle".into();
        }
    }
    fn changed<'a>(&'a mut self, _: &'a Ctx, _: &'a str, _: bool) -> OpFuture<'a> {
        Box::pin(async { Ok(Value::Null) })
    }
    fn log(&mut self, _: &Ctx, _: &str, _: &str) {}
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
        pending: false,
        entries: vec![Entry {
            id: "fx-ui".into(),
            manifest: Some(manifest),
            bundled: false,
            state: "needs_grant".into(),
            error: None,
            pid: None,
            served: vec![],
            protocol: None,
            restarts: 0,
        }],
        calls: vec![],
        veto: vec![],
        ttl: json!(60),
        document: json!({"type":"text","text":"Ready"}),
    };
    (dir, ctx, host, PublicOperations::default())
}
#[tokio::test]
async fn whole_public_sequence_and_revision_errors() {
    let (_dir, ctx, mut host, ops) = fixture();
    assert_eq!(OPERATIONS.len(), 12);
    assert_eq!(
        ops.call(&ctx, &mut host, "plugin.ui.list", json!({}))
            .await
            .unwrap(),
        json!({"surfaces":[]})
    );
    assert_eq!(
        ops.call(&ctx, &mut host, "plugin.enable", json!({"id":"fx-ui"}))
            .await
            .unwrap(),
        json!({"id":"fx-ui","state":"needs_grant","needs":["config.get"],"surfaces":["activity","panelTabs","settings","status"]})
    );
    assert!(host.calls.is_empty());
    assert_eq!(
        ops.call(
            &ctx,
            &mut host,
            "plugin.enable",
            json!({"id":"fx-ui","grant":true})
        )
        .await
        .unwrap()["state"],
        "idle"
    );
    let surfaces = ops
        .call(&ctx, &mut host, "plugin.ui.list", json!({}))
        .await
        .unwrap();
    assert_eq!(surfaces["surfaces"].as_array().unwrap().len(), 4);
    assert!(host.calls.is_empty());
    let first = ops
        .call(
            &ctx,
            &mut host,
            "plugin.settings.get",
            json!({"plugin":"fx-ui"}),
        )
        .await
        .unwrap();
    assert_eq!(first["rev"], 0);
    let p = json!({"plugin":"fx-ui","values":{"required":true,"items":["a","b"]},"expect_rev":0.0});
    let saved = ops
        .call(&ctx, &mut host, "plugin.settings.set", p.clone())
        .await
        .unwrap();
    assert_eq!(saved["rev"].as_f64(), Some(1.0));
    let err = ops
        .call(&ctx, &mut host, "plugin.settings.set", p)
        .await
        .unwrap_err();
    assert_eq!(
        err.body(),
        json!({"error":{"code":"conflict","message":"plugin fx-ui settings are at revision 1, not 0","hint":"Reload the page and try again."}})
    );
    let p = json!({"plugin":"fx-ui","surface":"activity","id":"checklist","visible":false,"expect_rev":1});
    assert_eq!(
        ops.call(&ctx, &mut host, "plugin.ui.visibility", p.clone())
            .await
            .unwrap()["rev"]
            .as_f64(),
        Some(2.0)
    );
    let err = ops
        .call(&ctx, &mut host, "plugin.ui.visibility", p)
        .await
        .unwrap_err();
    assert_eq!(err.message, "plugin fx-ui is at revision 2, not 1");
    assert_eq!(err.hint.as_deref(), Some("Reload and try again."));
    assert_eq!(
        fs::metadata(ctx.pacer_home.join("plugin-settings.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let context = json!({"route":"overview","theme":"light"});
    let render = json!({"plugin":"fx-ui","surface":"activity","id":"checklist","context":context});
    assert_eq!(
        ops.call(&ctx, &mut host, "plugin.ui.render", render.clone())
            .await
            .unwrap()["document"],
        host.document
    );
    host.veto = vec![json!({"path":"items","message":"too vague"})];
    let err = ops
        .call(
            &ctx,
            &mut host,
            "plugin.settings.set",
            json!({"plugin":"fx-ui","values":{"items":["x"]},"expect_rev":2}),
        )
        .await
        .unwrap_err();
    assert!(err.message.contains("too vague"));
    assert_eq!(
        settings::read(&ctx, "fx-ui").unwrap()["rev"].as_f64(),
        Some(2.0)
    );
    assert_eq!(ops.call(&ctx,&mut host,"plugin.ui.action",json!({"plugin":"fx-ui","surface":"activity","id":"checklist","action":"run","context":context,"requestId":"r1"})).await.unwrap(),json!({"result":"refresh","message":"done"}));
    assert!(
        ops.call(&ctx, &mut host, "plugin.doctor", json!({"id":"fx-ui"}))
            .await
            .unwrap()["reports"][0]["ok"]
            == true
    );
    ops.call(&ctx, &mut host, "plugin.disable", json!({"id":"fx-ui"}))
        .await
        .unwrap();
    assert_eq!(
        ops.call(&ctx, &mut host, "plugin.ui.render", render)
            .await
            .unwrap_err()
            .code,
        Code::PluginUnavailable
    );
    ops.call(&ctx, &mut host, "plugin.remove", json!({"id":"fx-ui"}))
        .await
        .unwrap();
    assert!(!ctx.pacer_home.join("plugins/fx-ui").exists());
    assert_eq!(settings::read(&ctx, "fx-ui").unwrap()["values"], json!({}));
    assert_eq!(
        ops.call(&ctx, &mut host, "plugin.enable", json!({"id":"fx-ui"}))
            .await
            .unwrap_err()
            .code,
        Code::UnknownPlugin
    );
    assert!(
        fs::read_to_string(ctx.pacer_home.join("strategy.yaml"))
            .unwrap()
            .contains("# keep me")
    );
}
#[tokio::test]
async fn static_surface_checks_precede_runtime_and_status_never_starts() {
    let (_dir, ctx, mut host, ops) = fixture();
    ops.call(
        &ctx,
        &mut host,
        "plugin.enable",
        json!({"id":"fx-ui","grant":true}),
    )
    .await
    .unwrap();
    let context = json!({"route":"overview","theme":"light"});
    for op in [
        "plugin.ui.render",
        "plugin.ui.action",
        "plugin.ui.visibility",
    ] {
        let p = json!({"plugin":"fx-ui","surface":"activity","id":"nope","context":context,"action":"run","requestId":"r","visible":true,"expect_rev":0});
        assert_eq!(
            ops.call(&ctx, &mut host, op, p).await.unwrap_err().code,
            Code::NotFound
        );
    }
    assert!(host.calls.is_empty());
    let err = ops
        .call(
            &ctx,
            &mut host,
            "plugin.ui.render",
            json!({"plugin":"fx-ui","surface":"status","id":"open-items","context":context}),
        )
        .await
        .unwrap_err();
    assert_eq!(err.message, "plugin fx-ui is not running");
    assert!(host.calls.is_empty());
}
#[test]
fn typescript_parity_matrix() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/plugin-public-parity.json"
    ))
    .unwrap();
    for c in cases["settings"].as_array().unwrap() {
        assert_eq!(
            settings::validate(&c["schema"], &c["values"]),
            c["errors"].as_array().unwrap().clone(),
            "{}",
            c["values"]
        );
    }
    for c in cases["documents"].as_array().unwrap() {
        let result = pacer_plugin_host::ui::parse(c["raw"].clone(), c["status"] == true);
        assert_eq!(result.is_ok(), c["result"]["ok"] == true, "{c}");
        if let Ok(doc) = result {
            assert_eq!(doc, c["result"]["document"]);
        }
    }
}
#[test]
fn javascript_trim_and_utf16() {
    assert_eq!(settings::js_length("😀"), 2);
    assert_eq!(settings::js_trim("\u{feff} hi \u{a0}"), "hi");
    assert_eq!(settings::js_trim("\u{85}hi\u{85}"), "\u{85}hi\u{85}");
}

#[tokio::test]
async fn registry_falls_back_until_the_single_owner_is_installed() {
    let (_dir, ctx, host, _) = fixture();
    let mut fallback = pacer_plugin_host::public::PublicRegistry::default();
    assert_eq!(fallback.native_names(), vec!["plugin.install"]);
    for op in OPERATIONS.iter().filter(|op| **op != "plugin.install") {
        assert!(fallback.dispatch(&ctx, op, json!({})).await.is_none());
    }
    assert_eq!(
        fallback
            .dispatch(&ctx, "plugin.install", json!({}))
            .await
            .unwrap()
            .unwrap_err()
            .code,
        Code::NotAllowed
    );
    let mut native = pacer_plugin_host::public::PublicRegistry::with_runtime(Box::new(host));
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
    assert_eq!(
        pacer_plugin_host::public::retired_install(Value::Null)
            .unwrap_err()
            .code,
        Code::NotAllowed
    );
}
#[test]
fn settings_corruption_and_ecmascript_revision_rendering() {
    let (_dir, ctx, _, _) = fixture();
    fs::write(ctx.pacer_home.join("plugin-settings.json"), "{broken").unwrap();
    assert_eq!(settings::read(&ctx, "fx-ui").unwrap()["rev"], 0);
    assert!(fs::read_dir(&ctx.pacer_home).unwrap().any(|e| {
        e.unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("plugin-settings.json.corrupt-")
    }));
    let record = json!({"fx-ui":{"rev":1e21,"values":{},"hidden":[]}});
    fs::write(
        ctx.pacer_home.join("plugin-settings.json"),
        record.to_string(),
    )
    .unwrap();
    let error = settings::save(&ctx, "fx-ui", json!({}), 0.0).unwrap_err();
    assert_eq!(
        error.message,
        "plugin fx-ui settings are at revision 1e+21, not 0"
    );
    assert_eq!(settings::js_number(-0.0), "0");
}

#[tokio::test]
async fn cancelled_action_releases_its_inflight_slot() {
    let (_dir, ctx, mut host, ops) = fixture();
    ops.call(
        &ctx,
        &mut host,
        "plugin.enable",
        json!({"id":"fx-ui","grant":true}),
    )
    .await
    .unwrap();
    let p = json!({"plugin":"fx-ui","surface":"activity","id":"checklist","action":"run","context":{"route":"overview","theme":"light"},"requestId":"cancelled"});
    host.pending = true;
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_millis(10),
            ops.call(&ctx, &mut host, "plugin.ui.action", p.clone())
        )
        .await
        .is_err()
    );
    host.pending = false;
    assert_eq!(
        ops.call(&ctx, &mut host, "plugin.ui.action", p)
            .await
            .unwrap()["result"],
        "refresh"
    );
}
#[test]
fn settings_veto_is_validated_and_normalized() {
    assert!(pacer_plugin_host::ui::validate_result(json!({"ok":false})).is_err());
    assert!(
        pacer_plugin_host::ui::validate_result(
            json!({"ok":false,"errors":[{"path":3,"message":"invalid"}]})
        )
        .is_err()
    );
    assert_eq!(pacer_plugin_host::ui::validate_result(json!({"ok":false,"errors":[{"path":"items","message":"e\u{301}\u{202e}","extra":"ignored"}]})).unwrap(),vec![json!({"path":"items","message":"é"})]);
}

#[tokio::test]
async fn shared_operation_number_matrix() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/plugin-operation-number-parity.json"
    ))
    .unwrap();
    for row in cases.as_array().unwrap() {
        let value: Value =
            serde_json::from_str(row["wire"].as_str().unwrap()).unwrap_or(Value::Null);
        let accepted = row["accepted"].as_bool().unwrap();
        let field = row["field"].as_str().unwrap();
        if field == "settingsInteger" {
            let schema = json!({"fields":{"Budget":{"type":"integer","title":"Budget","minimum":row["minimum"],"maximum":row["maximum"]}}});
            let errors = settings::validate(&schema, &json!({"Budget":value}));
            assert_eq!(
                errors,
                if accepted {
                    vec![]
                } else {
                    vec![json!({"path":"Budget","message":row["error"]})]
                },
                "{row}"
            );
        } else if field == "actionScalar" {
            let (_dir, ctx, mut host, ops) = fixture();
            ops.call(
                &ctx,
                &mut host,
                "plugin.enable",
                json!({"id":"fx-ui","grant":true}),
            )
            .await
            .unwrap();
            // Overflowing JSON numbers are rejected by the HTTP JSON decoder;
            // do not substitute null (a valid scalar) for a decoding error.
            let value = serde_json::from_str::<Value>(row["wire"].as_str().unwrap());
            if let Ok(value) = value {
                if accepted {
                    assert_eq!(
                        settings::js_json(&value),
                        row["normalized"].as_str().unwrap(),
                        "{row}"
                    );
                }
                let result = ops.call(&ctx, &mut host, "plugin.ui.action", json!({"plugin":"fx-ui","surface":"activity","id":"checklist","context":{"route":"overview","theme":"light"},"action":"run","requestId":"matrix","values":{"Budget":value}})).await;
                assert_eq!(result.is_ok(), accepted, "{row}");
                assert_eq!(
                    host.calls.contains(&"ui.action".to_owned()),
                    accepted,
                    "{row}"
                );
            } else {
                assert!(!accepted, "{row}");
            }
        } else if field == "expect_rev" {
            for op in ["plugin.settings.set", "plugin.ui.visibility"] {
                let (_dir, ctx, mut host, ops) = fixture();
                ops.call(
                    &ctx,
                    &mut host,
                    "plugin.enable",
                    json!({"id":"fx-ui","grant":true}),
                )
                .await
                .unwrap();
                let params = json!({"plugin":"fx-ui","values":{},"expect_rev":value,"surface":"activity","id":"checklist","visible":true});
                let result = ops.call(&ctx, &mut host, op, params).await;
                // A valid nonzero revision reaches the CAS check; invalid wire numbers must fail validation.
                let valid = result
                    .as_ref()
                    .map_or_else(|e| e.code == Code::Conflict, |_| true);
                assert_eq!(valid, accepted, "{op}: {row}");
            }
        } else if field == "ttlS" {
            let (_dir, ctx, mut host, ops) = fixture();
            ops.call(
                &ctx,
                &mut host,
                "plugin.enable",
                json!({"id":"fx-ui","grant":true}),
            )
            .await
            .unwrap();
            host.ttl = value;
            let result = ops.call(&ctx, &mut host, "plugin.ui.render", json!({"plugin":"fx-ui","surface":"activity","id":"checklist","context":{"route":"overview","theme":"light"}})).await;
            assert_eq!(result.is_ok(), accepted, "{row}");
            if accepted {
                assert_eq!(result.unwrap()["ttlS"].as_f64(), host.ttl.as_f64(), "{row}");
            }
        } else {
            let node = if field == "level" {
                json!({"type":"heading","text":"Ready","level":value})
            } else {
                let mut n = json!({"type":"meter","label":"Ready","usedPct":50});
                n[field] = value.clone();
                n
            };
            let result = pacer_plugin_host::ui::parse(node, false);
            assert_eq!(result.is_ok(), accepted, "{row}");
            if accepted {
                assert_eq!(result.unwrap()[field].as_f64(), value.as_f64(), "{row}");
            }
        }
    }
}

#[tokio::test]
async fn snapshot_ui_text_is_normalized_before_client_output_and_validation() {
    let (_dir, ctx, mut host, ops) = fixture();
    host.entries[0].bundled = true;
    host.entries[0].manifest.as_mut().unwrap()["contributes"]["ui"]["activity"][0]["title"] =
        json!("Pay\u{202e}lp\u{7} Cafe\u{301}");
    host.entries[0].manifest.as_mut().unwrap()["contributes"]["ui"]["settings"][0]["schema"]["fields"]
        ["choice"] = json!({"type":"string","title":"Choice","enum":["a\u{200b}b"]});
    let list = ops
        .call(&ctx, &mut host, "plugin.ui.list", json!({}))
        .await
        .unwrap();
    assert_eq!(list["surfaces"][0]["title"], "Paylp Café");
    let page = ops
        .call(
            &ctx,
            &mut host,
            "plugin.settings.get",
            json!({"plugin":"fx-ui"}),
        )
        .await
        .unwrap();
    assert_eq!(page["schema"]["fields"]["choice"]["enum"][0], "ab");
}

#[tokio::test]
async fn plugin_disable_accepts_linked_valid_strategy() {
    use std::os::unix::fs::symlink;
    let (_dir, ctx, mut host, ops) = fixture();
    host.entries[0].bundled = true;
    let strategy = ctx.pacer_home.join("strategy.yaml");
    let target = ctx.pacer_home.join("linked.yaml");
    fs::rename(&strategy, &target).unwrap();
    symlink(&target, &strategy).unwrap();
    ops.call(&ctx, &mut host, "plugin.disable", json!({"id":"fx-ui"}))
        .await
        .unwrap();
    assert!(
        !fs::symlink_metadata(strategy)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert!(!fs::read_to_string(target).unwrap().contains("disabled"));
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
