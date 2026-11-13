#![allow(clippy::unwrap_used)]
//! ProcessOwner answers capability.* through the plugin-capabilities broker (P4d-6/7).

use pacer_plugin_host::OrcaAttemptResource;
use pacer_plugin_runtime::{
    CallAuthority, CallResources, CapabilityBroker, FixtureHostProvider, FixtureOrcaSession,
    LocalHostEffect, OrcaCallContext, PluginCapabilitySession, ProcessOwner, ProviderSnapshot,
    ReadResource, SpawnSpec, call_resources_from_value, executor_context_from_value,
    host_snapshots_from_value, observation_bootstrap_from_value, parse_manifest, session_for_call,
    session_from_hello, worktree_context_from_value,
};
use pacer_store::TaskStore;
use serde_json::json;
use std::{
    collections::HashMap,
    env, fs,
    process::Command,
    time::{Duration, Instant},
};
use tempfile::TempDir;

fn peer_script(dir: &std::path::Path, source: &str) -> SpawnSpec {
    let path = dir.join("plugin.js");
    fs::write(&path, source).unwrap();
    SpawnSpec {
        argv: vec!["bun".into(), path.to_str().unwrap().into()],
        cwd: dir.to_path_buf(),
        env: env::vars().collect(),
    }
}

fn peer_inline(script: &str) -> SpawnSpec {
    SpawnSpec {
        argv: vec!["bun".into(), "-e".into(), script.into()],
        cwd: env::current_dir().unwrap(),
        env: env::vars().collect(),
    }
}

#[tokio::test]
async fn process_owner_answers_capability_log_under_broker() {
    let script = r#"const r=Bun.stdin.stream().getReader();let b='',pending;const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));for(;;){const {value,done}=await r.read();if(done)break;b+=new TextDecoder().decode(value);while(b.includes('\n')){const i=b.indexOf('\n'),m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='plugin.hello')send({id:m.id,result:{ok:true,protocol:'1.10.0',id:'fx-log',version:'1.0.0',contributes:['diagnostic']}});else if(m.method==='diagnostic.ping'){pending=m.id;send({id:7,method:'capability.log',params:{level:'info',message:'from fixture'}});}else if(m.id===7){if(m.result?.ok!==true)process.exit(2);send({id:pending,result:{ok:true}});}}}"#;
    let manifest = parse_manifest(json!({
        "id":"fx-log","version":"1.0.0","publisher":"fixture","host":">=1.10.0",
        "capabilities":[{"name":"log"}],
        "contributes":{"diagnostic":{}}
    }))
    .unwrap();
    let authority = CallAuthority::new(
        CallResources::default(),
        ["log".into()],
        Instant::now() + Duration::from_secs(10),
    );
    let session = PluginCapabilitySession::new(
        CapabilityBroker::new(manifest, authority, vec![]),
        LocalHostEffect::new(json!({})),
    );
    let mut owner = ProcessOwner::native_for_tests();
    owner.spawn("fx-log", &peer_inline(script)).unwrap();
    owner.install_capability_session("fx-log", session).unwrap();
    owner
        .call_plugin(
            "fx-log",
            "plugin.hello",
            json!({
                "protocol":"1.10.0","pacer":"0.2.0",
                "manifest":{"id":"fx-log","version":"1.0.0","publisher":"fixture","host":">=1.10.0","capabilities":[{"name":"log"}],"contributes":{"diagnostic":{}}},
                "config":{},"grants":["log"],"features":[]
            }),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    let ping = owner
        .call_plugin(
            "fx-log",
            "diagnostic.ping",
            json!({}),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    assert_eq!(ping["ok"], true);
    let logs = owner
        .capability_session("fx-log")
        .unwrap()
        .lock()
        .await
        .take_logs();
    assert_eq!(logs, vec![("info".into(), "from fixture".into())]);
    owner.terminate("fx-log").await.unwrap();
}

#[tokio::test]
async fn process_owner_answers_native_fs_read_under_broker() {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("note.txt");
    fs::write(&file, "hello-native-read").unwrap();
    let path = file.to_str().unwrap().to_owned();

    let source = format!(
        r#"const path = {path:?};
const r = Bun.stdin.stream().getReader();
let b = "";
let pending;
const send = (x) => console.log(JSON.stringify({{ jsonrpc: "2.0", ...x }}));
for (;;) {{
  const {{ value, done }} = await r.read();
  if (done) break;
  b += new TextDecoder().decode(value);
  while (b.includes("\n")) {{
    const i = b.indexOf("\n");
    const m = JSON.parse(b.slice(0, i));
    b = b.slice(i + 1);
    if (m.method === "plugin.hello") {{
      send({{
        id: m.id,
        result: {{
          ok: true,
          protocol: "1.10.0",
          id: "fx-read",
          version: "1.0.0",
          contributes: ["diagnostic"],
        }},
      }});
    }} else if (m.method === "diagnostic.ping") {{
      pending = m.id;
      send({{ id: 7, method: "capability.fs.read", params: {{ path }} }});
    }} else if (m.id === 7) {{
      if (typeof m.result?.text !== "string") {{
        send({{ id: pending, result: {{ ok: false, err: m.error ?? m.result }} }});
      }} else {{
        send({{ id: pending, result: {{ ok: true, text: m.result.text }} }});
      }}
    }}
  }}
}}
"#
    );

    let manifest = parse_manifest(json!({
        "id":"fx-read","version":"1.0.0","publisher":"fixture","host":">=1.10.0",
        "capabilities":[{"name":"fs.read","scopes":[path]}],
        "contributes":{"diagnostic":{}}
    }))
    .unwrap();
    let resources = CallResources {
        reads: vec![ReadResource {
            path: path.clone(),
            kind: "file".into(),
        }],
        ..CallResources::default()
    };
    let authority = CallAuthority::new(
        resources.clone(),
        ["fs.read".into()],
        Instant::now() + Duration::from_secs(10),
    );
    let broker = CapabilityBroker::new(manifest, authority, vec![])
        .with_native_read(&resources.reads)
        .unwrap();
    let session = PluginCapabilitySession::new(broker, LocalHostEffect::new(json!({})));

    let mut owner = ProcessOwner::native_for_tests();
    owner
        .spawn("fx-read", &peer_script(dir.path(), &source))
        .unwrap();
    owner
        .install_capability_session("fx-read", session)
        .unwrap();
    owner
        .call_plugin(
            "fx-read",
            "plugin.hello",
            json!({
                "protocol":"1.10.0","pacer":"0.2.0",
                "manifest":{
                    "id":"fx-read","version":"1.0.0","publisher":"fixture","host":">=1.10.0",
                    "capabilities":[{"name":"fs.read","scopes":[path]}],
                    "contributes":{"diagnostic":{}}
                },
                "config":{},"grants":["fs.read"],"features":[]
            }),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    let ping = owner
        .call_plugin(
            "fx-read",
            "diagnostic.ping",
            json!({}),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    assert_eq!(
        ping,
        json!({"ok": true, "text": "hello-native-read"}),
        "capability.fs.read under ProcessOwner must use NativeRead"
    );
    owner.terminate("fx-read").await.unwrap();
}

#[test]
fn session_from_hello_seals_grants_and_config() {
    let hello = json!({
        "protocol":"1.10.0","pacer":"0.2.0",
        "manifest":{
            "id":"fx-hello","version":"1.0.0","publisher":"fixture","host":">=1.10.0",
            "capabilities":[{"name":"log"},{"name":"config.get"}],
            "contributes":{"diagnostic":{}}
        },
        "config":{"tone":"quiet"},
        "grants":["log","config.get"],
        "features":[]
    });
    let mut session = session_from_hello(&hello, Duration::from_secs(5)).unwrap();
    assert_eq!(session.effect_mut().config()["tone"], "quiet");
}

#[tokio::test]
async fn process_owner_uses_core_sealed_call_resources_for_fs_read() {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("note.txt");
    fs::write(&file, "from-core-authority").unwrap();
    let path = file.to_str().unwrap().to_owned();

    let source = format!(
        r#"const path = {path:?};
const r = Bun.stdin.stream().getReader();
let b = "";
let pending;
const send = (x) => console.log(JSON.stringify({{ jsonrpc: "2.0", ...x }}));
for (;;) {{
  const {{ value, done }} = await r.read();
  if (done) break;
  b += new TextDecoder().decode(value);
  while (b.includes("\n")) {{
    const i = b.indexOf("\n");
    const m = JSON.parse(b.slice(0, i));
    b = b.slice(i + 1);
    if (m.method === "plugin.hello") {{
      send({{ id: m.id, result: {{ ok: true, protocol: "1.10.0", id: "fx-core", version: "1.0.0", contributes: ["diagnostic"] }} }});
    }} else if (m.method === "diagnostic.ping") {{
      pending = m.id;
      send({{ id: 7, method: "capability.fs.read", params: {{ path }} }});
    }} else if (m.id === 7) {{
      if (typeof m.result?.text !== "string") {{
        send({{ id: pending, result: {{ ok: false, err: m.error ?? m.result }} }});
      }} else {{
        send({{ id: pending, result: {{ ok: true, text: m.result.text }} }});
      }}
    }}
  }}
}}
"#
    );

    let hello = json!({
        "protocol":"1.10.0","pacer":"0.2.0",
        "manifest":{
            "id":"fx-core","version":"1.0.0","publisher":"fixture","host":">=1.10.0",
            "capabilities":[{"name":"fs.read","scopes":[path]}],
            "contributes":{"diagnostic":{}}
        },
        "config":{},"grants":["fs.read"],"features":[]
    });
    // Shape matches Core `/_internal/plugins` kind:call_authority response.
    let sealed = json!({
        "reads":[{"path":path,"kind":"file"}],
        "writes":[],
        "commands":[],
        "hosts":[]
    });
    let resources = call_resources_from_value(&sealed).unwrap();
    let mut session = session_for_call(
        &hello,
        resources,
        Some(vec!["fs.read".into()]),
        Duration::from_secs(10),
        None,
        None,
        None,
        None,
        None,
    )
    .unwrap();
    session.seal_call_authority(&json!({"owning": true}));

    let mut owner = ProcessOwner::native_for_tests();
    owner
        .spawn("fx-core", &peer_script(dir.path(), &source))
        .unwrap();
    owner
        .install_capability_session("fx-core", session)
        .unwrap();
    owner
        .call_plugin("fx-core", "plugin.hello", hello, Duration::from_secs(5))
        .await
        .unwrap();
    let ping = owner
        .call_plugin(
            "fx-core",
            "diagnostic.ping",
            json!({}),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    assert_eq!(
        ping,
        json!({"ok": true, "text": "from-core-authority"}),
        "Core-sealed CallResources must attach NativeRead under ProcessOwner"
    );
    owner.terminate("fx-core").await.unwrap();
}

#[tokio::test]
async fn process_owner_uses_core_sealed_command_for_process_spawn() {
    let dir = TempDir::new().unwrap();
    let script = dir.path().join("echo.sh");
    fs::write(&script, "#!/bin/sh\nprintf 'spawned-ok'\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script, perms).unwrap();
    }
    let exe = script.to_str().unwrap().to_owned();
    let name = "echo.sh";

    let source = format!(
        r#"const name = {name:?};
const r = Bun.stdin.stream().getReader();
let b = "";
let pending;
const send = (x) => console.log(JSON.stringify({{ jsonrpc: "2.0", ...x }}));
for (;;) {{
  const {{ value, done }} = await r.read();
  if (done) break;
  b += new TextDecoder().decode(value);
  while (b.includes("\n")) {{
    const i = b.indexOf("\n");
    const m = JSON.parse(b.slice(0, i));
    b = b.slice(i + 1);
    if (m.method === "plugin.hello") {{
      send({{ id: m.id, result: {{ ok: true, protocol: "1.10.0", id: "fx-spawn", version: "1.0.0", contributes: ["diagnostic"] }} }});
    }} else if (m.method === "diagnostic.ping") {{
      pending = m.id;
      send({{ id: 7, method: "capability.process.spawn", params: {{ argv: [name], timeoutMs: 5000 }} }});
    }} else if (m.id === 7) {{
      if (m.error || m.result?.code !== 0) {{
        send({{ id: pending, result: {{ ok: false, err: m.error ?? m.result }} }});
      }} else {{
        send({{ id: pending, result: {{ ok: true, stdout: m.result.stdout ?? "" }} }});
      }}
    }}
  }}
}}
"#
    );

    let hello = json!({
        "protocol":"1.10.0","pacer":"0.2.0",
        "manifest":{
            "id":"fx-spawn","version":"1.0.0","publisher":"fixture","host":">=1.10.0",
            "capabilities":[{"name":"process.spawn","scopes":[name]}],
            "contributes":{"diagnostic":{}}
        },
        "config":{},"grants":["process.spawn"],"features":[]
    });
    // Core seals the absolute executable; Rust rewrites to bare name + pin.
    let sealed = json!({
        "reads":[],
        "writes":[],
        "commands":[{"argv":[exe],"timeoutMs":5000}],
        "hosts":[]
    });
    let resources = call_resources_from_value(&sealed).unwrap();
    let mut session = session_for_call(
        &hello,
        resources,
        Some(vec!["process.spawn".into()]),
        Duration::from_secs(10),
        None,
        None,
        None,
        None,
        None,
    )
    .unwrap();
    session.seal_call_authority(&json!({"owning": true}));

    let mut owner = ProcessOwner::native_for_tests();
    owner
        .spawn("fx-spawn", &peer_script(dir.path(), &source))
        .unwrap();
    owner
        .install_capability_session("fx-spawn", session)
        .unwrap();
    owner
        .call_plugin("fx-spawn", "plugin.hello", hello, Duration::from_secs(5))
        .await
        .unwrap();
    let ping = owner
        .call_plugin(
            "fx-spawn",
            "diagnostic.ping",
            json!({}),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    assert_eq!(
        ping["ok"], true,
        "spawn under Core-sealed command must succeed: {ping}"
    );
    assert!(
        ping["stdout"].as_str().unwrap_or("").contains("spawned-ok"),
        "unexpected spawn stdout: {ping}"
    );
    owner.terminate("fx-spawn").await.unwrap();
}

#[tokio::test]
async fn process_owner_refuses_observation_reads_outside_a_lane_generation() {
    let dir = TempDir::new().unwrap();
    let home = dir.path().to_str().unwrap().to_owned();
    let pacer_home = dir.path().join("state");
    fs::create_dir_all(&pacer_home).unwrap();
    let state = pacer_home.to_str().unwrap().to_owned();
    let token = "obs-call-token-fixture";

    let source = format!(
        r#"const token = {token:?};
const r = Bun.stdin.stream().getReader();
let b = "";
let pending;
const send = (x) => console.log(JSON.stringify({{ jsonrpc: "2.0", ...x }}));
for (;;) {{
  const {{ value, done }} = await r.read();
  if (done) break;
  b += new TextDecoder().decode(value);
  while (b.includes("\n")) {{
    const i = b.indexOf("\n");
    const m = JSON.parse(b.slice(0, i));
    b = b.slice(i + 1);
    if (m.method === "plugin.hello") {{
      send({{ id: m.id, result: {{ ok: true, protocol: "1.10.0", id: "fx-obs", version: "1.0.0", contributes: ["diagnostic"] }} }});
    }} else if (m.method === "diagnostic.ping") {{
      pending = m.id;
      send({{ id: 7, method: "capability.tasks.list", params: {{}}, _meta: {{ capabilityCall: token }} }});
    }} else if (m.id === 7) {{
      send({{ id: pending, result: {{ ok: true, tasks: m.result?.tasks ?? null, error: m.error?.message }} }});
    }}
  }}
}}
"#
    );

    let hello = json!({
        "protocol":"1.10.0","pacer":"0.2.0",
        "manifest":{
            "id":"fx-obs","version":"1.0.0","publisher":"fixture","host":">=1.10.0",
            "capabilities":[{"name":"tasks.read"},{"name":"events.subscribe"}],
            "contributes":{"policy":{}}
        },
        "config":{},"grants":["tasks.read","events.subscribe"],"features":["policyObservations"]
    });
    let sealed = json!({
        "reads":[],
        "writes":[],
        "commands":[],
        "hosts":[],
        "observation":{
            "callToken":token,
            "bootstrap":true,
            "readContext":{"home":home,"pacerHome":state,"now":1.0}
        }
    });
    let observation = observation_bootstrap_from_value(&sealed).unwrap();
    let resources = call_resources_from_value(&sealed).unwrap();
    let mut session = session_for_call(
        &hello,
        resources,
        Some(vec!["tasks.read".into(), "events.subscribe".into()]),
        Duration::from_secs(10),
        observation,
        None,
        None,
        None,
        None,
    )
    .unwrap();
    session.seal_call_authority(&json!({"owning": true}));

    let mut owner = ProcessOwner::native_for_tests();
    owner
        .spawn("fx-obs", &peer_script(dir.path(), &source))
        .unwrap();
    owner.install_capability_session("fx-obs", session).unwrap();
    owner
        .call_plugin("fx-obs", "plugin.hello", hello, Duration::from_secs(5))
        .await
        .unwrap();
    let ping = owner
        .call_plugin(
            "fx-obs",
            "diagnostic.ping",
            json!({}),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    // Task reads come from the owning door's Core under the lane's generation; a session
    // installed outside a sealed door call has neither, so it must not answer from anywhere else.
    assert_eq!(
        ping,
        json!({"ok": true, "tasks": null, "error": "observation owner or transport was not issued"}),
        "a sealed observation token without a lane generation must not read tasks"
    );
    owner.terminate("fx-obs").await.unwrap();
}

#[tokio::test]
async fn process_owner_answers_hosts_probe_when_core_seals_snapshots() {
    let alias = "box";
    let fingerprint = "host-one";
    let snapshot = ProviderSnapshot {
        alias: alias.into(),
        host_fingerprint: fingerprint.into(),
        caller_generation: "caller-fixture".into(),
        provider_generation: "provider-fixture".into(),
        provider_process: 9,
    };

    let source = r#"const r = Bun.stdin.stream().getReader();
let b = "";
let pending;
const send = (x) => console.log(JSON.stringify({ jsonrpc: "2.0", ...x }));
for (;;) {
  const { value, done } = await r.read();
  if (done) break;
  b += new TextDecoder().decode(value);
  while (b.includes("\n")) {
    const i = b.indexOf("\n");
    const m = JSON.parse(b.slice(0, i));
    b = b.slice(i + 1);
    if (m.method === "plugin.hello") {
      send({ id: m.id, result: { ok: true, protocol: "1.10.0", id: "fx-host", version: "1.0.0", contributes: ["diagnostic"] } });
    } else if (m.method === "diagnostic.ping") {
      pending = m.id;
      send({ id: 7, method: "capability.hosts.open", params: { alias: "box" } });
    } else if (m.id === 7 && m.result?.session) {
      send({ id: 8, method: "capability.hosts.run", params: { session: m.result.session, script: "PROBE", args: [], timeoutMs: 1000, maxBytes: 1024 } });
    } else if (m.id === 8) {
      send({ id: pending, result: { ok: true, stdout: m.result?.stdout ?? "" } });
    }
  }
}"#;

    let hello = json!({
        "protocol":"1.10.0","pacer":"0.2.0",
        "manifest":{
            "id":"fx-host","version":"1.0.0","publisher":"fixture","host":">=1.10.0",
            "capabilities":[{"name":"hosts"}],
            "contributes":{"diagnostic":{}}
        },
        "config":{},"grants":["hosts"],"features":[]
    });
    let sealed = json!({
        "reads":[],
        "writes":[],
        "commands":[],
        "hosts":[{
            "alias":alias,
            "hostFingerprint":fingerprint,
            "script":"PROBE",
            "args":[],
            "timeoutMs":1000,
            "maxBytes":1024
        }],
        "hostSnapshots":[{
            "alias":alias,
            "hostFingerprint":fingerprint,
            "callerGeneration":"caller-fixture",
            "providerGeneration":"provider-fixture",
            "providerProcess":9,
            "providerId":"pacer-ssh"
        }]
    });
    let host_attach = host_snapshots_from_value(&sealed).unwrap();
    let resources = call_resources_from_value(&sealed).unwrap();
    let mut session = session_for_call(
        &hello,
        resources,
        Some(vec!["hosts".into()]),
        Duration::from_secs(10),
        None,
        Some(&host_attach),
        None,
        None,
        None,
    )
    .unwrap();
    session.seal_call_authority(&json!({"owning": true}));
    session.bind_hosts_fixture(
        FixtureHostProvider::new(snapshot.clone(), "probe-ok"),
        [snapshot],
    );

    let dir = TempDir::new().unwrap();
    let mut owner = ProcessOwner::native_for_tests();
    owner
        .spawn("fx-host", &peer_script(dir.path(), source))
        .unwrap();
    owner
        .install_capability_session("fx-host", session)
        .unwrap();
    owner
        .call_plugin("fx-host", "plugin.hello", hello, Duration::from_secs(5))
        .await
        .unwrap();
    let ping = owner
        .call_plugin(
            "fx-host",
            "diagnostic.ping",
            json!({}),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    assert_eq!(
        ping,
        json!({"ok": true, "stdout": "probe-ok"}),
        "Core-sealed hostSnapshots must answer capability.hosts.run"
    );
    owner.terminate("fx-host").await.unwrap();
}

#[tokio::test]
async fn process_owner_answers_orca_prepare_when_core_seals_attempt() {
    let home = TempDir::new().unwrap();
    let task_id = "t-20261106-125719-c5fb";
    let mut store = TaskStore::open(home.path()).unwrap();
    store
        .insert(
            &json!({
                "id": task_id,
                "rev": 1,
                "createdAt": 1,
                "state": "running",
                "attempts": [],
                "brief": {"repo": "/synthetic"},
            }),
            1.0,
        )
        .unwrap();

    let source = r#"const r = Bun.stdin.stream().getReader();
let b = "";
let pending;
const send = (x) => console.log(JSON.stringify({ jsonrpc: "2.0", ...x }));
for (;;) {
  const { value, done } = await r.read();
  if (done) break;
  b += new TextDecoder().decode(value);
  while (b.includes("\n")) {
    const i = b.indexOf("\n");
    const m = JSON.parse(b.slice(0, i));
    b = b.slice(i + 1);
    if (m.method === "plugin.hello") {
      send({ id: m.id, result: { ok: true, protocol: "1.10.0", id: "pacer-exec-orca", version: "1.0.0", contributes: ["executor"] } });
    } else if (m.method === "executor.run") {
      pending = m.id;
      send({ id: 7, method: "capability.orca.prepare", params: { taskId: "t-20261106-125719-c5fb", attempt: 1 } });
    } else if (m.id === 7) {
      send({ id: pending, result: { ok: true, prepared: m.result?.method === "prepare" } });
    }
  }
}"#;

    let hello = json!({
        "protocol":"1.10.0","pacer":"0.2.0",
        "manifest":{
            "id":"pacer-exec-orca","version":"1.0.0","publisher":"fixture","host":">=1.10.0",
            "capabilities":[{"name":"orca","scopes":["task-owned"]}],
            "contributes":{"executor":{"backends":["orca"]}}
        },
        "config":{},"grants":["orca"],"features":[]
    });
    let grant = OrcaAttemptResource {
        task_id: task_id.into(),
        attempt: 1,
        provider_id: "pacer-exec-orca".into(),
        executor: "fx-executor".into(),
        session: "host-only-session".into(),
    };
    let sealed = json!({
        "reads":[],
        "writes":[],
        "commands":[],
        "hosts":[],
        "orcaAttempt": {
            "taskId": task_id,
            "attempt": 1,
            "providerId": "pacer-exec-orca",
            "executor": "fx-executor",
            "session": "host-only-session",
        }
    });
    let resources = call_resources_from_value(&sealed).unwrap();
    let orca_context = OrcaCallContext {
        home: home.path().to_path_buf(),
        status_executable: None,
        status_env: HashMap::new(),
    };
    let mut session = session_for_call(
        &hello,
        resources,
        Some(vec!["orca".into()]),
        Duration::from_secs(10),
        None,
        None,
        Some(orca_context),
        None,
        None,
    )
    .unwrap();
    session.seal_call_authority(&json!({"owning": true}));
    session
        .bind_orca_fixture(
            home.path(),
            grant.clone(),
            FixtureOrcaSession {
                session_id: grant.session.clone(),
                task_id: grant.task_id.clone(),
                attempt: grant.attempt,
                executor: grant.executor.clone(),
                response: json!({"method": "prepare"}),
            },
        )
        .unwrap();

    let dir = TempDir::new().unwrap();
    let mut owner = ProcessOwner::native_for_tests();
    owner
        .spawn("pacer-exec-orca", &peer_script(dir.path(), source))
        .unwrap();
    owner
        .install_capability_session("pacer-exec-orca", session)
        .unwrap();
    owner
        .call_plugin(
            "pacer-exec-orca",
            "plugin.hello",
            hello,
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    let run = owner
        .call_plugin(
            "pacer-exec-orca",
            "executor.run",
            json!({"task":{"id":task_id,"rev":1},"attempt":1,"runDir":1,"orca":{"executor":"fx-executor","model":null,"timeoutMs":60000}}),
            Duration::from_secs(10),
        )
        .await
        .unwrap();
    assert_eq!(
        run,
        json!({"ok": true, "prepared": true}),
        "Core-sealed orcaAttempt must answer capability.orca.prepare"
    );
    owner.terminate("pacer-exec-orca").await.unwrap();
}

#[tokio::test]
async fn process_owner_answers_worktree_resolve_base_when_core_seals_grant() {
    let root = TempDir::new().unwrap();
    let home = root.path().join("home");
    let repo = root.path().join("repo");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir(&repo).unwrap();
    let env: HashMap<String, String> = HashMap::from([
        ("HOME".into(), home.to_str().unwrap().into()),
        ("GIT_CONFIG_GLOBAL".into(), "/dev/null".into()),
        ("GIT_CONFIG_SYSTEM".into(), "/dev/null".into()),
        ("PATH".into(), "/usr/bin:/bin".into()),
    ]);
    for args in [
        vec!["init", "-q"],
        vec![
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "initial",
        ],
    ] {
        assert!(
            Command::new("/usr/bin/git")
                .args(args)
                .current_dir(&repo)
                .env_clear()
                .envs(&env)
                .status()
                .unwrap()
                .success()
        );
    }
    let task_id = "t-20261106-125719-c5fb";
    let mut store = TaskStore::open(&home).unwrap();
    store
        .insert(
            &json!({
                "id": task_id,
                "rev": 1,
                "createdAt": 1,
                "state": "running",
                "executorProvider": "fx-executor",
                "attempts": [],
                "brief": {"repo": repo}
            }),
            1.0,
        )
        .unwrap();
    let base_sha = Command::new("/usr/bin/git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&repo)
        .env_clear()
        .envs(&env)
        .output()
        .unwrap()
        .stdout;
    let base_sha = String::from_utf8(base_sha).unwrap().trim().to_owned();

    let source = r#"const r = Bun.stdin.stream().getReader();
let b = "", pending;
const send = (x) => console.log(JSON.stringify({ jsonrpc: "2.0", ...x }));
for (;;) {
  const { value, done } = await r.read();
  if (done) break;
  b += new TextDecoder().decode(value);
  while (b.includes("\n")) {
    const i = b.indexOf("\n");
    const m = JSON.parse(b.slice(0, i));
    b = b.slice(i + 1);
    if (m.method === "plugin.hello") {
      send({ id: m.id, result: { ok: true, protocol: "1.10.0", id: "fx-executor", version: "1.0.0", contributes: ["executor"] } });
    } else if (m.method === "executor.run") {
      pending = m.id;
      send({ id: 7, method: "capability.worktree.resolveBase", params: { taskId: "t-20261106-125719-c5fb", attempt: 1 } });
    } else if (m.id === 7) {
      send({ id: pending, result: { ok: true, sha: m.result?.sha } });
    }
  }
}"#;

    let hello = json!({
        "protocol":"1.10.0","pacer":"0.2.0",
        "manifest":{
            "id":"fx-executor","version":"1.0.0","publisher":"fixture","host":">=1.10.0",
            "capabilities":[{"name":"worktree"}],
            "contributes":{"executor":{"backends":["direct"]}}
        },
        "config":{},"grants":["worktree"],"features":[]
    });
    let sealed = json!({
        "reads":[],
        "writes":[],
        "commands":[],
        "hosts":[],
        "worktree":{"taskId": task_id, "attempt": 1, "baseSha": base_sha},
        "worktreeContext":{
            "home": home.to_str().unwrap(),
            "providerId":"fx-executor",
            "git":"/usr/bin/git",
            "base":"HEAD",
            "env": env
        }
    });
    let resources = call_resources_from_value(&sealed).unwrap();
    let worktree_context = worktree_context_from_value(&sealed).unwrap();
    let mut session = session_for_call(
        &hello,
        resources,
        Some(vec!["worktree".into()]),
        Duration::from_secs(30),
        None,
        None,
        None,
        worktree_context,
        None,
    )
    .unwrap();
    session.seal_call_authority(&json!({"owning": true}));
    session.bind_process_owner_worktree().await.unwrap();

    let dir = TempDir::new().unwrap();
    let mut owner = ProcessOwner::native_for_tests();
    owner
        .spawn("fx-executor", &peer_script(dir.path(), source))
        .unwrap();
    owner
        .install_capability_session("fx-executor", session)
        .unwrap();
    owner
        .call_plugin("fx-executor", "plugin.hello", hello, Duration::from_secs(5))
        .await
        .unwrap();
    let run = owner
        .call_plugin(
            "fx-executor",
            "executor.run",
            json!({"task":{"id":task_id,"rev":1},"attempt":1,"runDir":1,"owned":{"placement":"new","timeoutMs":60000}}),
            Duration::from_secs(30),
        )
        .await
        .unwrap();
    assert_eq!(
        run["sha"].as_str().unwrap(),
        base_sha,
        "Core-sealed worktree must answer capability.worktree.resolveBase"
    );
    owner.terminate("fx-executor").await.unwrap();
}

#[tokio::test]
async fn process_owner_answers_executor_claim_when_core_seals_grant() {
    let root = TempDir::new().unwrap();
    let home = {
        fs::create_dir_all(root.path().join("home")).unwrap();
        fs::canonicalize(root.path().join("home")).unwrap()
    };
    let repo = root.path().join("repo");
    fs::create_dir(&repo).unwrap();
    let repo = fs::canonicalize(&repo).unwrap();
    let task_id = "t-20261106-125719-c5fb";
    let executable = fs::canonicalize("/usr/bin/printf").unwrap();
    let mut store = TaskStore::open(&home).unwrap();
    store
        .insert(
            &json!({
                "id": task_id,
                "rev": 1,
                "createdAt": 1,
                "state": "running",
                "executorProvider": "fx-executor",
                "executor": "tool",
                "attempts": [],
                "brief": {"repo": repo.to_str().unwrap()}
            }),
            1.0,
        )
        .unwrap();

    let source = r#"const r = Bun.stdin.stream().getReader();
let b = "", pending;
const send = (x) => console.log(JSON.stringify({ jsonrpc: "2.0", ...x }));
for (;;) {
  const { value, done } = await r.read();
  if (done) break;
  b += new TextDecoder().decode(value);
  while (b.includes("\n")) {
    const i = b.indexOf("\n");
    const m = JSON.parse(b.slice(0, i));
    b = b.slice(i + 1);
    if (m.method === "plugin.hello") {
      send({ id: m.id, result: { ok: true, protocol: "1.10.0", id: "fx-executor", version: "1.0.0", contributes: ["executor"] } });
    } else if (m.method === "executor.run") {
      pending = m.id;
      send({ id: 7, method: "capability.process.claimRun", params: { taskId: "t-20261106-125719-c5fb", attempt: 1 } });
    } else if (m.id === 7) {
      send({ id: pending, result: { ok: true, runDir: m.result?.runDir } });
    }
  }
}"#;

    let hello = json!({
        "protocol":"1.10.0","pacer":"0.2.0",
        "manifest":{
            "id":"fx-executor","version":"1.0.0","publisher":"fixture","host":">=1.10.0",
            "capabilities":[{"name":"process.spawn","scopes":["printf"]}],
            "contributes":{"executor":{"backends":["direct"]}}
        },
        "config":{},"grants":["process.spawn"],"features":[]
    });
    let sealed = json!({
        "reads":[],
        "writes":[],
        "commands":[],
        "hosts":[],
        "executorClaim":{
            "taskId": task_id,
            "attempt": 1,
            "providerId":"fx-executor",
            "executor":"tool",
            "launch":{
                "argv":["printf","%s","claimed"],
                "cwd": repo,
                "executable": executable,
                "env": {}
            }
        },
        "executorContext":{"home": home}
    });
    let resources = call_resources_from_value(&sealed).unwrap();
    let executor_context = executor_context_from_value(&sealed).unwrap();
    let mut session = session_for_call(
        &hello,
        resources,
        Some(vec!["process.spawn".into()]),
        Duration::from_secs(30),
        None,
        None,
        None,
        None,
        executor_context,
    )
    .unwrap();
    session.seal_call_authority(&json!({"owning": true}));
    session.bind_process_owner_executor().unwrap();

    let dir = TempDir::new().unwrap();
    let mut owner = ProcessOwner::native_for_tests();
    owner
        .spawn("fx-executor", &peer_script(dir.path(), source))
        .unwrap();
    owner
        .install_capability_session("fx-executor", session)
        .unwrap();
    owner
        .call_plugin("fx-executor", "plugin.hello", hello, Duration::from_secs(5))
        .await
        .unwrap();
    let run = owner
        .call_plugin(
            "fx-executor",
            "executor.run",
            json!({"task":{"id":task_id,"rev":1},"attempt":1,"runDir":1,"owned":{"placement":"current","timeoutMs":60000}}),
            Duration::from_secs(30),
        )
        .await
        .unwrap();
    assert_eq!(
        run["runDir"].as_u64(),
        Some(1),
        "Core-sealed executorClaim must answer capability.process.claimRun"
    );
    owner.terminate("fx-executor").await.unwrap();
}
