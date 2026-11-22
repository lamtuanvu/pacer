#![allow(clippy::unwrap_used, clippy::expect_used)]
//! A sealed call may pin the child it runs on (`expectPid`), as Core's flag-off
//! `expectedProcess` does: the owner never starts or substitutes a child for it.

use pacer_plugin_runtime::{METHOD_PLUGIN_CALL, NativeHostSession, OwnerKey, authenticate};
use serde_json::{Value, json};
use std::{env, fs, os::unix::fs::PermissionsExt, path::Path};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
};

const CHILD: &str = r"require('node:fs').appendFileSync(process.env.STARTS,'s\n');const r=Bun.stdin.stream().getReader();let b='';const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));for(;;){const {value,done}=await r.read();if(done)break;b+=new TextDecoder().decode(value);while(b.includes('\n')){const i=b.indexOf('\n'),m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='plugin.hello')send({id:m.id,result:{protocol:'1.10.0',id:m.params.manifest.id,version:'1.0.0',contributes:['diagnostic']}});else if(m.method==='diagnostic.ping')send({id:m.id,result:{ok:true}});}}";

fn request(id: &str, starts: &Path, expect_pid: Option<Value>) -> Value {
    let mut vars = env::vars().collect::<std::collections::HashMap<_, _>>();
    vars.insert("STARTS".into(), starts.display().to_string());
    let mut params = json!({
        "id": id, "method": "diagnostic.ping", "params": {}, "deadlineMs": 10_000,
        "spawn": {"argv": ["bun", "-e", CHILD], "cwd": env::current_dir().unwrap(), "env": vars,
            "hello": {"protocol": "1.10.0", "pacer": "0.2.0", "config": {}, "grants": [], "features": [],
                "manifest": {"id": id, "version": "1.0.0", "publisher": "fixture", "host": ">=1.10.0",
                    "contributes": {"diagnostic": {}}}}},
        "authority": {"resources": {}, "grants": [], "ttlMs": 10_000},
    });
    if let Some(pid) = expect_pid {
        params["expectPid"] = pid;
    }
    json!({"jsonrpc": "2.0", "id": 1, "method": METHOD_PLUGIN_CALL, "params": params})
}

struct Bridge {
    _home: tempfile::TempDir,
    session: NativeHostSession,
}

impl Bridge {
    fn start() -> Self {
        let home = tempfile::tempdir().unwrap();
        fs::set_permissions(home.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let (session, _) = NativeHostSession::start(home.path()).unwrap();
        Self {
            _home: home,
            session,
        }
    }

    async fn call(&self, id: &str, starts: &Path, expect_pid: Option<Value>) -> Value {
        let request = request(id, starts, expect_pid);
        dial(self.session.socket_path(), self.session.key(), &request).await
    }

    async fn stop(self, id: &str) {
        let _ = self.session.owner().lock().await.terminate(id).await;
        self.session.shutdown().await;
    }
}

/// Prove the session's key, as Core does, then send one request.
async fn dial(path: &Path, key: &OwnerKey, request: &Value) -> Value {
    let mut reader = BufReader::new(UnixStream::connect(path).await.unwrap());
    authenticate(&mut reader, key).await.unwrap();
    let mut bytes = serde_json::to_vec(request).unwrap();
    bytes.push(b'\n');
    reader.get_mut().write_all(&bytes).await.unwrap();
    let mut line = Vec::new();
    reader.read_until(b'\n', &mut line).await.unwrap();
    serde_json::from_slice(line.trim_ascii_end()).unwrap()
}

fn starts_file(prefix: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "pacer-expect-pid-{prefix}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir.join("starts")
}

fn starts_count(path: &Path) -> usize {
    match fs::read_to_string(path) {
        Ok(text) => text.lines().count(),
        Err(_) => 0,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reply_carries_the_serving_child_pid() {
    let bridge = Bridge::start();
    let starts = starts_file("reply-pid");
    let reply = bridge.call("fx-pid", &starts, None).await;
    assert!(reply.get("error").is_none(), "{reply}");
    let pid = reply["result"]["pid"].as_u64().expect("has pid") as u32;
    assert!(pid > 0, "{reply}");
    let tracked = bridge
        .session
        .owner()
        .lock()
        .await
        .find_plugin("fx-pid")
        .unwrap()
        == pid;
    assert!(tracked, "{reply}");
    bridge.stop("fx-pid").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn expect_pid_runs_on_the_same_child() {
    let bridge = Bridge::start();
    let starts = starts_file("same-child");
    let first = bridge.call("fx-same", &starts, None).await;
    let pid = first["result"]["pid"].as_u64().unwrap() as u32;
    let second = bridge.call("fx-same", &starts, Some(json!(pid))).await;
    assert!(second.get("error").is_none(), "{second}");
    assert_eq!(second["result"]["value"]["ok"], true, "{second}");
    assert_eq!(
        second["result"]["pid"].as_u64().unwrap() as u32,
        pid,
        "{second}"
    );
    assert_eq!(starts_count(&starts), 1, "child must not be started again");
    bridge.stop("fx-same").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn expect_pid_never_substitutes_a_child() {
    let bridge = Bridge::start();
    let starts = starts_file("never-substitute");
    let first = bridge.call("fx-sub", &starts, None).await;
    let pid = first["result"]["pid"].as_u64().unwrap() as u32;
    bridge
        .session
        .owner()
        .lock()
        .await
        .terminate("fx-sub")
        .await
        .unwrap();
    let reply = bridge.call("fx-sub", &starts, Some(json!(pid))).await;
    assert_eq!(
        reply["error"]["data"]["code"], "plugin_unavailable",
        "{reply}"
    );
    assert_eq!(
        reply["error"]["message"], "host runner provider changed",
        "{reply}"
    );
    assert!(
        bridge
            .session
            .owner()
            .lock()
            .await
            .find_plugin("fx-sub")
            .is_none()
    );
    assert_eq!(
        starts_count(&starts),
        1,
        "the owner must not start a replacement"
    );
    bridge.stop("fx-sub").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn expect_pid_never_starts_a_child() {
    let bridge = Bridge::start();
    let starts = starts_file("never-start");
    let reply = bridge.call("fx-nostart", &starts, Some(json!(4242))).await;
    assert_eq!(
        reply["error"]["data"]["code"], "plugin_unavailable",
        "{reply}"
    );
    assert_eq!(
        reply["error"]["message"], "host runner provider changed",
        "{reply}"
    );
    assert!(
        !starts.exists(),
        "no child may be started for an unknown pinned lane"
    );
    bridge.stop("fx-nostart").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invalid_expect_pid_is_refused() {
    let bridge = Bridge::start();
    let starts = starts_file("invalid");
    for bad in [json!(0), json!("x"), json!(4294967296u64)] {
        let reply = bridge.call("fx-invalid", &starts, Some(bad)).await;
        assert_eq!(reply["error"]["message"], "invalid expectPid", "{reply}");
    }
    assert_eq!(starts_count(&starts), 0, "no child may be started");
    bridge.stop("fx-invalid").await;
}
