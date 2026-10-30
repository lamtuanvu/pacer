#![allow(clippy::unwrap_used)]
//! The front door's LAN radio talks to the core over `/_internal/discovery/*`. Real multicast is
//! exercised in live validation (CT-11); here the fake core keeps discovery disabled.
use std::{
    fs,
    path::PathBuf,
    process::{Child, Command, ExitStatus, Stdio},
    time::{Duration, Instant},
};
#[path = "support/keychain_stub.rs"]
mod keychain_stub;

// Records each internal discovery call and whether it carried this generation's internal bearer.
const FAKE_CORE: &str = r#"
const { appendFileSync, writeFileSync } = require("node:fs");
const log = process.env.PACER_TEST_DISCOVERY_LOG;
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
  const path = new URL(req.url).pathname;
  if (path.startsWith("/_internal/discovery/")) {
    const auth = req.headers.get("authorization") === `Bearer ${process.env.PACER_INTERNAL_TOKEN}` ? "auth" : "noauth";
    appendFileSync(log, `${req.method} ${path} ${auth}\n`);
  }
  if (path === "/_internal/discovery/config") return Response.json({ rev: 1, enabled: false, listen: false, advertise: null });
  return Response.json({ ok: true });
} });
writeFileSync(process.env.PACER_TEST_READY, "ready");
console.log(JSON.stringify({ internal: { port: server.port } }));
process.stdin.resume();
"#;

struct Serve {
    child: Child,
    home: tempfile::TempDir,
}
impl Serve {
    fn start(discovery: Option<&str>) -> Serve {
        let home = tempfile::tempdir().unwrap();
        let bun = std::env::var("PACER_TEST_BUN").unwrap_or_else(|_| "bun".into());
        let mut command = Command::new(env!("CARGO_BIN_EXE_pacer"));
        command
            .args(["serve", "--port", "0"])
            .env("PACER_HOME", home.path())
            .env("PATH", keychain_stub::keychain_stub_path(home.path(), &bun))
            .env(
                "PACER_TEST_DISCOVERY_LOG",
                home.path().join("discovery.log"),
            )
            .env("PACER_TEST_READY", home.path().join("ready"))
            .env(
                "PACER_CORE_ARGV",
                serde_json::json!([bun, "--eval", FAKE_CORE]).to_string(),
            )
            .env_remove("PACER_DISCOVERY")
            .stdout(Stdio::null());
        if let Some(value) = discovery {
            command.env("PACER_DISCOVERY", value);
        }
        Serve {
            child: command.spawn().unwrap(),
            home,
        }
    }
    fn path(&self, name: &str) -> PathBuf {
        self.home.path().join(name)
    }
    fn calls(&self) -> String {
        fs::read_to_string(self.path("discovery.log")).unwrap_or_default()
    }
    fn stop(mut self) -> ExitStatus {
        Command::new("kill")
            .args(["-TERM", &self.child.id().to_string()])
            .status()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status;
            }
            assert!(Instant::now() < deadline, "pacer serve did not stop");
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}
impl Drop for Serve {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn wait_for(what: &str, timeout: Duration, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + timeout;
    while !done() {
        assert!(Instant::now() < deadline, "{what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn radio_polls_the_core_config_and_stops_cleanly() {
    let serve = Serve::start(None);
    wait_for("core never started", Duration::from_secs(15), || {
        serve.path("ready").exists()
    });
    wait_for(
        "the radio never polled its config",
        Duration::from_secs(10),
        || serve.calls().contains("POST /_internal/discovery/config"),
    );
    let calls = serve.calls();
    assert!(
        calls
            .lines()
            .all(|line| line == "POST /_internal/discovery/config auth"),
        "{calls}"
    );
    // Disabled discovery starts no mDNS daemon, so nothing is ever observed.
    assert!(!calls.contains("/_internal/discovery/observed"), "{calls}");
    assert!(serve.stop().success());
}

#[test]
fn discovery_off_never_polls_the_core() {
    let serve = Serve::start(Some("off"));
    wait_for("core never started", Duration::from_secs(15), || {
        serve.path("ready").exists()
    });
    // Longer than one 5-second poll interval.
    std::thread::sleep(Duration::from_secs(7));
    assert_eq!(serve.calls(), "");
    assert!(serve.stop().success());
}
