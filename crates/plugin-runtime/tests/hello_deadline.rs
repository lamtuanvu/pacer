#![allow(clippy::unwrap_used)]
//! The owner gives `plugin.hello` the registry's 10 s (`HELLO_DEADLINE_MS`),
//! bounded by the call's own deadline, and words a hello timeout as the
//! registry does: `plugin.hello passed its 10000 ms deadline`.

use pacer_plugin_runtime::{METHOD_PLUGIN_CALL, NativeHostSession};
use serde_json::{Value, json};
use std::{
    env, fs,
    os::unix::fs::PermissionsExt,
    path::Path,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
};

/// Answers `plugin.hello` after `HELLO_DELAY` ms, or never when it is `never`.
const SLOW_HELLO: &str = r"const r=Bun.stdin.stream().getReader();let b='';const delay=process.env.HELLO_DELAY;const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));for(;;){const {value,done}=await r.read();if(done)break;b+=new TextDecoder().decode(value);while(b.includes('\n')){const i=b.indexOf('\n'),m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='plugin.hello'){if(delay!=='never')setTimeout(()=>send({id:m.id,result:{protocol:'1.10.0',id:m.params.manifest.id,version:'1.0.0',contributes:['diagnostic']}}),Number(delay));}else if(m.method==='diagnostic.ping')send({id:m.id,result:{ok:true}});}}";

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

    /// A sealed `diagnostic.ping` to `id` with the call deadline `deadline_ms`.
    async fn ping(&self, id: &str, hello_delay: &str, deadline_ms: u64) -> (Value, Duration) {
        let mut vars = env::vars().collect::<std::collections::HashMap<_, _>>();
        vars.insert("HELLO_DELAY".into(), hello_delay.into());
        let request = json!({
            "jsonrpc": "2.0", "id": 1, "method": METHOD_PLUGIN_CALL,
            "params": {
                "id": id, "method": "diagnostic.ping", "params": {}, "deadlineMs": deadline_ms,
                "spawn": {
                    "argv": ["bun", "-e", SLOW_HELLO],
                    "cwd": env::current_dir().unwrap(),
                    "env": vars,
                    "hello": {
                        "protocol": "1.10.0", "pacer": "0.2.0", "config": {}, "grants": [], "features": [],
                        "manifest": {"id": id, "version": "1.0.0", "publisher": "fixture",
                            "host": ">=1.10.0", "contributes": {"diagnostic": {}}},
                    },
                },
                "authority": {"resources": {}, "grants": [], "ttlMs": deadline_ms},
            }
        });
        let started = Instant::now();
        let reply = dial(self.session.socket_path(), &request).await;
        (reply, started.elapsed())
    }

    async fn stop(self, id: &str) {
        let _ = self.session.owner().lock().await.terminate(id).await;
        self.session.shutdown().await;
    }
}

async fn dial(path: &Path, request: &Value) -> Value {
    let mut stream = UnixStream::connect(path).await.unwrap();
    let mut bytes = serde_json::to_vec(request).unwrap();
    bytes.push(b'\n');
    stream.write_all(&bytes).await.unwrap();
    let mut line = Vec::new();
    BufReader::new(stream)
        .read_until(b'\n', &mut line)
        .await
        .unwrap();
    serde_json::from_slice(line.trim_ascii_end()).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_hello_answered_after_six_seconds_readies_the_child() {
    let bridge = Bridge::start();
    let (reply, _) = bridge.ping("fx-slow", "6000", 30_000).await;
    assert!(reply.get("error").is_none(), "{reply}");
    assert_eq!(reply["result"]["value"]["ok"], true, "{reply}");
    assert_eq!(reply["result"]["hello"]["protocol"], "1.10.0", "{reply}");
    bridge.stop("fx-slow").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_silent_hello_fails_at_ten_seconds_with_the_registry_text() {
    let bridge = Bridge::start();
    let (reply, elapsed) = bridge.ping("fx-silent", "never", 30_000).await;
    assert_eq!(reply["error"]["data"]["code"], "plugin_timeout", "{reply}");
    assert_eq!(
        reply["error"]["message"], "plugin.hello passed its 10000 ms deadline",
        "{reply}"
    );
    assert!(
        (Duration::from_secs(10)..Duration::from_secs(15)).contains(&elapsed),
        "{elapsed:?}"
    );
    bridge.stop("fx-silent").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_silent_hello_within_a_shorter_call_deadline_fails_as_the_call() {
    let bridge = Bridge::start();
    let (reply, elapsed) = bridge.ping("fx-short", "never", 3_000).await;
    assert_eq!(reply["error"]["data"]["code"], "plugin_timeout", "{reply}");
    assert_eq!(
        reply["error"]["message"], "plugin call passed its absolute deadline",
        "{reply}"
    );
    assert!(elapsed < Duration::from_secs(5), "{elapsed:?}");
    bridge.stop("fx-short").await;
}
