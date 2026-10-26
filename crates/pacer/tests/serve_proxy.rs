#![allow(clippy::unwrap_used)]
use std::{
    fs,
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
struct Server {
    child: Child,
    port: u16,
    home: tempfile::TempDir,
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = Command::new("kill")
            .args(["-TERM", &self.child.id().to_string()])
            .status();
        let _ = self.child.wait();
    }
}
fn request(server: &Server, path: &str, extra: &[&str]) -> std::process::Output {
    Command::new("curl")
        .args([
            "-sS",
            "--max-time",
            "2",
            "-H",
            "Authorization: Bearer test-token",
            "-w",
            "\n%{http_code}",
        ])
        .args(extra)
        .arg(format!("http://127.0.0.1:{}{path}", server.port))
        .output()
        .unwrap()
}
#[test]
fn core_receives_the_bound_public_port_instead_of_the_ambient_port() {
    let home = tempfile::tempdir().unwrap();
    let observed = home.path().join("child-port");
    let preload = home.path().join("preload.ts");
    let marker = home.path().join("preload-ran");
    fs::write(
        &preload,
        "await Bun.write(process.env.PACER_TEST_PRELOAD_MARKER, 'executed');",
    )
    .unwrap();
    let bun = std::env::var("PACER_TEST_BUN").unwrap_or_else(|_| "bun".into());
    let script = "await Bun.write(process.env.PACER_TEST_PORT_FILE, process.env.PACER_PORT ?? 'missing'); console.log(JSON.stringify({internal:{port:1}})); process.stdin.resume();";
    let mut child = Command::new(env!("CARGO_BIN_EXE_pacer"))
        .args(["serve", "--port", "0"])
        .env("PACER_HOME", home.path())
        .env("PACER_PORT", "1")
        .env("PACER_TEST_PORT_FILE", &observed)
        .env("PACER_TEST_PRELOAD_MARKER", &marker)
        .env("BUN_OPTIONS", format!("--preload {}", preload.display()))
        .env("PACER_SERVE_ANNOUNCE", "1")
        .env(
            "PACER_CORE_ARGV",
            serde_json::json!([bun, "--eval", script]).to_string(),
        )
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let port = serde_json::from_str::<serde_json::Value>(&line).unwrap()["port"]
        .as_u64()
        .unwrap() as u16;
    let server = Server { child, port, home };
    let deadline = Instant::now() + Duration::from_secs(5);
    let actual = loop {
        if let Ok(value) = fs::read_to_string(&observed)
            && !value.is_empty()
        {
            break value;
        }
        assert!(
            Instant::now() < deadline,
            "core never recorded its public port"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_ne!(server.port, 0);
    assert_eq!(actual, server.port.to_string());
    assert!(!marker.exists(), "ambient preload ran in the internal core");
}
#[test]
fn forwards_http_sse_limits_and_recovers_core() {
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    // The executor supplies the pinned Bun through PATH, keeping machine paths out of fixtures.
    let bun = std::env::var("PACER_TEST_BUN").unwrap_or_else(|_| "bun".into());
    assert!(
        Command::new(&bun)
            .arg("--version")
            .output()
            .unwrap()
            .status
            .success()
    );
    let home = tempfile::tempdir().unwrap();
    fs::write(home.path().join("token"), "test-token\n").unwrap();
    fs::create_dir_all(home.path().join("link")).unwrap();
    fs::write(home.path().join("link/outbox.jsonl"), "{\"seq\":1,\"at\":123,\"envelope\":{\"type\":\"mode\",\"data\":{\"mode\":\"normal\",\"previous\":null,\"strategy\":\"test\",\"at\":123}}}\n").unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_pacer"))
        .args(["serve", "--port", "0"])
        .env("PACER_HOME", home.path())
        .env("PACER_SERVE_ANNOUNCE", "1")
        .env(
            "PACER_CORE_ARGV",
            serde_json::json!([&bun, repo.join("src/cli.ts")]).to_string(),
        )
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let port = serde_json::from_str::<serde_json::Value>(&line).unwrap()["port"]
        .as_u64()
        .unwrap() as u16;
    let server = Server { child, port, home };
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if String::from_utf8_lossy(&request(&server, "/v3/hello", &[]).stdout).ends_with("200") {
            break;
        }
        assert!(Instant::now() < deadline, "core never became ready");
        std::thread::sleep(Duration::from_millis(50));
    }
    // Health reflects the core heartbeat: a probe lands within a few seconds of readiness.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let out = String::from_utf8_lossy(&request(&server, "/health", &[]).stdout).into_owned();
        let (body, code) = out.rsplit_once('\n').unwrap();
        assert_eq!(code, "200");
        let health: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(health["ok"], true);
        if health["backendLagS"].as_f64().unwrap() < 2.0 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the core heartbeat never landed: {health}"
        );
        std::thread::sleep(Duration::from_millis(200));
    }
    for path in ["/v2/hello", "/v3/hello"] {
        let response = request(&server, path, &[]);
        assert!(String::from_utf8_lossy(&response.stdout).ends_with("200"));
    }
    let expected = Command::new(&bun).current_dir(&repo).args(["--eval", "import {helloBody} from './src/api/protocol'; console.log(JSON.stringify(helloBody()))"]).output().unwrap();
    assert!(expected.status.success());
    let expected_text = String::from_utf8_lossy(&expected.stdout).trim().to_owned();
    let mut advertised: serde_json::Value = serde_json::from_str(&expected_text).unwrap();
    let expected_text = if cfg!(feature = "test-ops") {
        let ops = advertised["ops"].as_array_mut().unwrap();
        ops.push(serde_json::json!("test.echo"));
        ops.sort_by_key(|v| v.as_str().unwrap().to_owned());
        advertised.to_string()
    } else {
        expected_text
    };
    assert_eq!(
        String::from_utf8_lossy(&request(&server, "/v3/hello", &[]).stdout),
        format!("{expected_text}\n200")
    );
    let unknown = request(&server, "/v3/ops/not.an.op", &["--data", "{}"]);
    let unknown = String::from_utf8_lossy(&unknown.stdout);
    let (body, status) = unknown.rsplit_once('\n').unwrap();
    assert_eq!(status, "404");
    let error: serde_json::Value = serde_json::from_str(body).unwrap();
    let hint = error["error"]["hint"]
        .as_str()
        .unwrap()
        .strip_prefix("operations: ")
        .unwrap();
    let names: Vec<_> = advertised["ops"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(hint.split(", ").collect::<Vec<_>>(), names);
    let ws_fixture = r#"
import {createTask} from './src/tasks/store';
import {createServer} from 'node:net';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {socketPath} from './src/session/host';
import {WireDecoder,wire} from './src/session/framing';
import {makeCtx} from './src/ctx';
const ctx=makeCtx();
const task=createTask(ctx,{brief:{goal:'proxy ws',repo:ctx.home},kind:null,requestedExecutor:null,timeoutS:300});
const dir=join(ctx.pacerHome,'runs',task.id,'1');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'session.log'),'');
const path=socketPath(dir);writeFileSync(join(dir,'session.sock.path'),path);
let peer;
const unix=createServer(s=>{peer=s;const decoder=new WireDecoder();s.on('data',b=>{for(const f of decoder.push(Buffer.from(b)))if(f.type===1)s.write(wire(3,Buffer.from([0,255,27])));});});
await new Promise((resolve,reject)=>{unix.once('error',reject);unix.listen(path,resolve);});
const ws=new WebSocket(`ws://127.0.0.1:${process.env.TEST_PORT}/v3/tasks/${task.id}/session`,{headers:{authorization:'Bearer test-token'}});
ws.binaryType='arraybuffer';
try {await Promise.race([new Promise((resolve,reject)=>{ws.onopen=()=>ws.send(JSON.stringify({type:'hello',v:1,client:'cli'}));ws.onerror=reject;ws.onmessage=e=>{if(typeof e.data==='string')return;const bytes=Buffer.from(e.data);if(!bytes.equals(wire(3,Buffer.from([0,255,27]))))reject(Error('changed binary frame'));else resolve();};}),Bun.sleep(3000).then(()=>{throw Error('WebSocket timeout');})]);}
finally{ws.close();peer?.destroy();unix.close();}
"#;
    let ws_result = Command::new(&bun)
        .current_dir(&repo)
        .env("PACER_HOME", server.home.path())
        .env("TEST_PORT", server.port.to_string())
        .args(["--eval", ws_fixture])
        .output()
        .unwrap();
    assert!(
        ws_result.status.success(),
        "{}",
        String::from_utf8_lossy(&ws_result.stderr)
    );
    let response = request(&server, "/v3/ops/version.get", &["-X", "POST", "-d", "{}"]);
    assert!(
        String::from_utf8_lossy(&response.stdout).ends_with("200"),
        "{:?}",
        response
    );
    let events = request(&server, "/v3/events?since=0", &["-N"]);
    assert!(
        String::from_utf8_lossy(&events.stdout).contains("data:"),
        "{:?}",
        events
    );
    let body = server.home.path().join("large");
    fs::write(&body, vec![b'x'; 300 * 1024]).unwrap();
    let response = request(
        &server,
        "/v3/ops/version.get",
        &["--data-binary", &format!("@{}", body.display())],
    );
    assert_eq!(
        String::from_utf8_lossy(&response.stdout),
        "{\"error\":{\"code\":\"too_large\",\"message\":\"body exceeds 256 KiB\"}}\n413"
    );
    // No bearer: the public listener must answer the app's 401 page itself.
    let response = Command::new("curl")
        .args(["-sS", "--max-time", "2", "-w", "\n%{http_code}"])
        .arg(format!("http://127.0.0.1:{}/app/", server.port))
        .output()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&response.stdout).ends_with("401"),
        "{:?}",
        response
    );
    let children = Command::new("pgrep")
        .args(["-P", &server.child.id().to_string()])
        .output()
        .unwrap();
    let pid = String::from_utf8(children.stdout).unwrap();
    assert!(
        Command::new("kill")
            .args(["-KILL", pid.trim()])
            .status()
            .unwrap()
            .success()
    );
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(
        String::from_utf8_lossy(&request(&server, "/v3/hello", &[]).stdout),
        "pacer core is restarting\n\n502"
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if String::from_utf8_lossy(&request(&server, "/v3/hello", &[]).stdout).ends_with("200") {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(50));
    }
    // Even SIGKILL must close the ownership pipe and stop the private core.
    let children = Command::new("pgrep")
        .args(["-P", &server.child.id().to_string()])
        .output()
        .unwrap();
    let core_pid = String::from_utf8(children.stdout).unwrap();
    assert!(!core_pid.trim().is_empty());
    Command::new("kill")
        .args(["-KILL", &server.child.id().to_string()])
        .status()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let alive = Command::new("kill")
            .args(["-0", core_pid.trim()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success();
        if !alive {
            break;
        }
        if Instant::now() >= deadline {
            let _ = Command::new("kill")
                .args(["-KILL", core_pid.trim()])
                .status();
            panic!("internal core survived the front door");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}
