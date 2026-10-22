//! Supervised internal core, with a fresh credential for every generation.
use std::{collections::HashMap, io, process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{Mutex, RwLock, oneshot},
    task::JoinHandle,
    time::{Instant, timeout},
};

type Target = Arc<RwLock<Option<(u16, String)>>>;
pub struct CoreChild {
    target: Target,
    stop: Mutex<Option<oneshot::Sender<()>>>,
    task: Mutex<Option<JoinHandle<()>>>,
}
impl CoreChild {
    pub fn spawn(core: Vec<String>, env: HashMap<String, String>) -> Self {
        let target = Arc::new(RwLock::new(None));
        let (stop, mut stopped) = oneshot::channel();
        let shared = target.clone();
        let task = tokio::spawn(async move {
            let mut delay = 1;
            loop {
                let mut healthy_since = None;
                let token = hex::encode(rand::random::<[u8; 32]>());
                let result = start(&core, &env, &token);
                match result {
                    Ok(mut child) => {
                        // Child::wait closes stdin unless its handle has been taken.
                        // Keep ownership until this generation exits or is terminated.
                        let _ownership = child.stdin.take();
                        let ready = async {
                            let stdout = child
                                .stdout
                                .take()
                                .ok_or_else(|| io::Error::other("missing core stdout"))?;
                            let mut reader = BufReader::new(stdout);
                            let mut line = String::new();
                            reader.read_line(&mut line).await?;
                            let value: serde_json::Value = serde_json::from_str(&line)?;
                            let port = value["internal"]["port"]
                                .as_u64()
                                .and_then(|n| u16::try_from(n).ok())
                                .filter(|n| *n != 0)
                                .ok_or_else(|| io::Error::other("invalid core announcement"))?;
                            Ok::<_, io::Error>((port, reader))
                        };
                        let ready = tokio::select! {
                            _ = &mut stopped => { terminate(&mut child).await; return; }
                            ready = timeout(Duration::from_secs(15), ready) => ready,
                        };
                        match ready {
                            Ok(Ok((port, mut stdout))) => {
                                healthy_since = Some(Instant::now());
                                // The credential belongs only to this child's environment.
                                *shared.write().await = Some((port, token));
                                let copy = tokio::spawn(async move {
                                    let mut output = tokio::io::stdout();
                                    let mut line = Vec::new();
                                    loop {
                                        line.clear();
                                        match stdout.read_until(b'\n', &mut line).await {
                                            Ok(0) => break,
                                            Ok(_) => {
                                                if output.write_all(&line).await.is_err()
                                                    || output.flush().await.is_err()
                                                {
                                                    break;
                                                }
                                            }
                                            Err(error) => {
                                                eprintln!("pacer: core stdout: {error}");
                                                break;
                                            }
                                        }
                                    }
                                });
                                tokio::select! {
                                    _ = &mut stopped => { *shared.write().await = None; terminate(&mut child).await; copy.abort(); return; }
                                    result = child.wait() => { if let Err(error) = result { eprintln!("pacer: core wait: {error}"); } }
                                }
                                *shared.write().await = None;
                                // A descendant can keep the dead generation's stdout open.
                                // Its pipe must never prevent starting a replacement core.
                                copy.abort();
                                let _ = copy.await;
                            }
                            _ => {
                                eprintln!("pacer: core did not announce its listener");
                                terminate(&mut child).await;
                            }
                        }
                    }
                    Err(error) => eprintln!("pacer: core start: {error}"),
                }
                if healthy_since.is_some_and(|since| since.elapsed() >= Duration::from_secs(60)) {
                    delay = 1;
                }
                tokio::select! { _ = &mut stopped => return, _ = tokio::time::sleep(Duration::from_secs(delay)) => {} }
                delay = (delay * 2).min(30);
            }
        });
        Self {
            target,
            stop: Mutex::new(Some(stop)),
            task: Mutex::new(Some(task)),
        }
    }
    pub async fn target(&self) -> Option<(u16, String)> {
        self.target.read().await.clone()
    }
    pub async fn shutdown(&self) {
        if let Some(stop) = self.stop.lock().await.take() {
            let _ = stop.send(());
        }
        if let Some(task) = self.task.lock().await.take() {
            let _ = task.await;
        }
    }
}
fn start(core: &[String], env: &HashMap<String, String>, token: &str) -> io::Result<Child> {
    let (program, args) = core
        .split_first()
        .ok_or_else(|| io::Error::other("empty core argv"))?;
    Command::new(program)
        .args(args)
        .args(["serve", "--internal"])
        .envs(env)
        .env("PACER_INTERNAL_TOKEN", token)
        .env("PACER_INTERNAL_PARENT_PIPE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
}
async fn terminate(child: &mut Child) {
    if let Some(pid) = child.id() {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status()
            .await;
    }
    if timeout(Duration::from_secs(5), child.wait()).await.is_err() {
        let _ = child.kill().await;
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    async fn ready(core: &CoreChild) -> (u16, String) {
        timeout(Duration::from_secs(4), async {
            loop {
                if let Some(target) = core.target().await {
                    return target;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap()
    }
    #[tokio::test]
    async fn restarts_with_new_credential_and_shuts_down() {
        let core = CoreChild::spawn(
            vec![
                "/bin/sh".into(),
                "-c".into(),
                "printf '{\"internal\":{\"port\":12345}}\\n'; exec sleep 0.2".into(),
            ],
            HashMap::new(),
        );
        let first = ready(&core).await;
        assert_eq!(first.0, 12345);
        assert_eq!(first.1.len(), 64);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(core.target().await.is_none());
        let second = ready(&core).await;
        assert_ne!(first.1, second.1);
        core.shutdown().await;
        assert!(core.target().await.is_none());
    }
    #[tokio::test]
    async fn inherited_stdout_does_not_block_restart() {
        let dir = tempfile::tempdir().unwrap();
        let pids = dir.path().join("pids");
        let core = CoreChild::spawn(
            vec!["/bin/sh".into(), "-c".into(),
                "sleep 10 & echo $! >> \"$PIDS\"; printf '{\"internal\":{\"port\":12345}}\\n'; exec sleep 0.1".into()],
            HashMap::from([("PIDS".into(), pids.to_string_lossy().into_owned())]),
        );
        let first = ready(&core).await;
        let restarted = timeout(Duration::from_secs(3), async {
            loop {
                if core
                    .target()
                    .await
                    .is_some_and(|target| target.1 != first.1)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        for pid in std::fs::read_to_string(pids).unwrap().lines() {
            let _ = Command::new("kill").args(["-TERM", pid]).status().await;
        }
        core.shutdown().await;
        assert!(
            restarted.is_ok(),
            "inherited stdout prevented a new core generation"
        );
    }
}
