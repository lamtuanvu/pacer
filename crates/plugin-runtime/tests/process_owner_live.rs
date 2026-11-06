#![allow(clippy::unwrap_used)]
//! Library-path ProcessOwner holds live PluginProcess children under the native
//! test token without activating serve or setting PACER_HOST_SOCKET.

use pacer_plugin_host::parse_manifest;
use pacer_plugin_runtime::{
    HOST_SOCKET_ENV, OwnerError, PluginProcess, PluginState, ProcessOwner, Registry, SpawnSpec,
};
use serde_json::json;
use std::{env, time::Duration};

fn peer(script: &str) -> SpawnSpec {
    SpawnSpec {
        argv: vec!["bun".into(), "-e".into(), script.into()],
        cwd: env::current_dir().unwrap(),
        env: env::vars().collect(),
    }
}

fn fixture_registry() -> Registry {
    let mut registry = Registry::shadow();
    let manifest = parse_manifest(json!({
        "id": "fx-owner",
        "version": "1.0.0",
        "publisher": "fixture",
        "host": ">=1.6.0",
        "contributes": {"usage": {}}
    }))
    .unwrap();
    registry.insert(manifest, false, true);
    registry
}

#[test]
fn typescript_owner_refuses_spawn_and_keeps_shadow_only() {
    let mut owner = ProcessOwner::typescript();
    let registry = fixture_registry();
    owner.sync_shadow_from(&registry);
    assert_eq!(owner.shadow_len(), 1);
    assert_eq!(owner.shadow_state("fx-owner"), Some(PluginState::Idle));
    assert!(owner.is_empty());
    assert_eq!(
        owner.spawn("fx-owner", &peer("process.exit(0)")),
        Err(OwnerError::TypeScriptOwnsHost)
    );
    assert!(env::var_os(HOST_SOCKET_ENV).is_none());
}

#[test]
fn serve_claim_stays_refused_under_native_test_token() {
    let owner = ProcessOwner::native_for_tests();
    assert_eq!(
        owner.claim_native_supervision(),
        Err(OwnerError::NativeNotActivated)
    );
}

#[tokio::test]
async fn native_test_token_spawns_tracks_and_terminates_fixture() {
    assert!(
        env::var_os(HOST_SOCKET_ENV).is_none(),
        "library path must not rely on PACER_HOST_SOCKET"
    );

    let script = r#"const reader=Bun.stdin.stream().getReader();let text='';for(;;){const {value,done}=await reader.read();if(done)break;text+=new TextDecoder().decode(value);while(text.includes('\n')){const cut=text.indexOf('\n');const line=text.slice(0,cut);text=text.slice(cut+1);const m=JSON.parse(line);if(m.method==='probe')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{ok:true,ppid:process.ppid}}));}}"#;
    let mut owner = ProcessOwner::native_for_tests();
    owner.sync_shadow_from(&fixture_registry());
    assert_eq!(owner.shadow_state("fx-owner"), Some(PluginState::Idle));

    owner.spawn("fx-owner", &peer(script)).unwrap();
    assert_eq!(owner.len(), 1);
    assert_eq!(owner.tracked_ids(), vec!["fx-owner".to_string()]);
    assert!(env::var_os(HOST_SOCKET_ENV).is_none());

    let child = owner.get_mut("fx-owner").unwrap();
    let pid = child.pid().unwrap();
    let result = child
        .request("probe", json!({}), Duration::from_secs(5), None)
        .await
        .unwrap();
    assert_eq!(result["ok"], true);
    assert_eq!(result["ppid"], std::process::id());
    assert_ne!(pid, std::process::id());

    assert_eq!(
        owner.spawn("fx-owner", &peer(script)),
        Err(OwnerError::AlreadyTracked("fx-owner".into()))
    );
    assert!(!owner.ensure("fx-owner", &peer(script)).unwrap());
    assert!(!owner.is_ready("fx-owner"));
    owner.mark_ready("fx-owner");
    assert!(owner.is_ready("fx-owner"));

    owner.terminate("fx-owner").await.unwrap();
    assert!(owner.is_empty());
    assert!(!owner.is_ready("fx-owner"));
    assert_eq!(
        owner.terminate("fx-owner").await.unwrap_err(),
        OwnerError::UnknownPlugin("fx-owner".into())
    );
    assert!(env::var_os(HOST_SOCKET_ENV).is_none());
}

#[tokio::test]
async fn track_adopts_existing_child_under_native_token() {
    let script = r#"const reader=Bun.stdin.stream().getReader();await reader.read();"#;
    let child = PluginProcess::spawn(&peer(script)).unwrap();
    let mut owner = ProcessOwner::native_for_tests();
    owner.track("adopted", child).unwrap();
    assert_eq!(owner.tracked_ids(), vec!["adopted".to_string()]);
    owner.terminate("adopted").await.unwrap();

    let mut ts = ProcessOwner::typescript();
    let orphan = PluginProcess::spawn(&peer("process.exit(0)")).unwrap();
    assert_eq!(
        ts.track("nope", orphan),
        Err(OwnerError::TypeScriptOwnsHost)
    );
}
