#![allow(clippy::unwrap_used)]
//! ProcessOwner answers capability.* through the plugin-host broker (P4d-6/7).

use pacer_plugin_runtime::{
    CallAuthority, CallResources, CapabilityBroker, FixtureHostProvider, LocalHostEffect,
    PluginCapabilitySession, ProcessOwner, ProviderSnapshot, ReadResource, SpawnSpec,
    call_resources_from_value, host_snapshots_from_value, parse_manifest,
    observation_bootstrap_from_value, session_for_call, session_from_hello,
};
use serde_json::json;
use std::{
    env, fs,
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
    let session = session_for_call(
        &hello,
        resources,
        Some(vec!["fs.read".into()]),
        Duration::from_secs(10),
        None,
        None,
    )
    .unwrap();

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
    let session = session_for_call(
        &hello,
        resources,
        Some(vec!["process.spawn".into()]),
        Duration::from_secs(10),
        None,
        None,
    )
    .unwrap();

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
async fn process_owner_answers_observation_tasks_list_when_core_seals_bootstrap() {
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
      send({{ id: pending, result: {{ ok: true, tasks: m.result?.tasks ?? null }} }});
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
    let session = session_for_call(
        &hello,
        resources,
        Some(vec!["tasks.read".into(), "events.subscribe".into()]),
        Duration::from_secs(10),
        observation,
        None,
    )
    .unwrap();

    let mut owner = ProcessOwner::native_for_tests();
    owner
        .spawn("fx-obs", &peer_script(dir.path(), &source))
        .unwrap();
    owner
        .install_capability_session("fx-obs", session)
        .unwrap();
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
    assert_eq!(
        ping,
        json!({"ok": true, "tasks": []}),
        "Core-sealed observation bootstrap must answer capability.tasks.list"
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
    )
    .unwrap();
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
