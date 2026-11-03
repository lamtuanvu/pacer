//! Private bounded subprocesses for host-owned programs and binary Git input.
use crate::{
    AuthorityError, BrokerError,
    native_process::{Image, OwnedChild, terminate_unreaped},
};
use std::{
    collections::HashMap,
    process::Stdio,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
};

pub struct Output {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub timed_out: bool,
}
pub fn denied() -> BrokerError {
    AuthorityError::Denied("host command identity, input or output changed".into()).into()
}
/// Failure relative to the only dispatch point, the call to `Command::spawn`.
/// Tokio can fail after the OS child exists (stdio/reaper registration), so a
/// spawn error is never proof of non-dispatch.
#[derive(Debug)]
pub enum CommandFailure {
    /// Rejected before `spawn` was called: no program image ran.
    Undispatched(BrokerError),
    /// `spawn` was called; the effect may have begun.
    Dispatched(BrokerError),
}
impl From<CommandFailure> for BrokerError {
    fn from(f: CommandFailure) -> Self {
        match f {
            CommandFailure::Undispatched(e) | CommandFailure::Dispatched(e) => e,
        }
    }
}
pub async fn run(
    image: &Image,
    args: &[String],
    env: &HashMap<String, String>,
    input: &[u8],
    timeout_ms: u64,
    max_bytes: usize,
    deadline: Instant,
) -> Result<Output, BrokerError> {
    run_tracked(image, args, env, input, timeout_ms, max_bytes, deadline)
        .await
        .map_err(Into::into)
}
pub async fn run_tracked(
    image: &Image,
    args: &[String],
    env: &HashMap<String, String>,
    input: &[u8],
    timeout_ms: u64,
    max_bytes: usize,
    deadline: Instant,
) -> Result<Output, CommandFailure> {
    image.check().map_err(CommandFailure::Undispatched)?;
    if Instant::now() >= deadline || timeout_ms == 0 {
        return Err(CommandFailure::Undispatched(BrokerError::Timeout));
    }
    if args.iter().any(|s| s.contains('\0')) {
        return Err(CommandFailure::Undispatched(denied()));
    }
    // Dispatch point: no `.await` may precede this in the function.
    let spawned = Command::new(&image.canonical)
        .args(args)
        .env_clear()
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true)
        .spawn();
    supervise(image, spawned, input, timeout_ms, max_bytes, deadline)
        .await
        .map_err(CommandFailure::Dispatched)
}
async fn supervise(
    image: &Image,
    spawned: std::io::Result<tokio::process::Child>,
    input: &[u8],
    timeout_ms: u64,
    max_bytes: usize,
    deadline: Instant,
) -> Result<Output, BrokerError> {
    let mut child = OwnedChild(spawned.map_err(|_| denied())?);
    let mut stdin = child.stdin.take().ok_or_else(denied)?;
    let mut stdout = child.stdout.take().ok_or_else(denied)?;
    let mut stderr = child.stderr.take().ok_or_else(denied)?;
    let mut out = Vec::new();
    let mut err = Vec::new();
    let mut write = Box::pin(async move {
        let result = stdin.write_all(input).await;
        drop(stdin);
        result
    });
    let (mut written, mut out_end, mut err_end) = (false, false, false);
    let mut status: Option<std::process::ExitStatus> = None;
    let mut early_close = false;
    let (mut ob, mut eb) = (vec![0; 65536], vec![0; 65536]);
    let end = deadline.min(Instant::now() + Duration::from_millis(timeout_ms));
    let result = loop {
        if status.is_some() && out_end && err_end && written {
            // Header readers may close stdin early. Only a completed successful
            // child can make that BrokenPipe benign; all other guards still apply.
            break if early_close && !status.is_some_and(|s| s.success()) {
                Err(denied())
            } else {
                Ok(false)
            };
        }
        tokio::select! {
            v=&mut write,if !written => {written=true;if let Err(error)=v {if error.kind()==std::io::ErrorKind::BrokenPipe {early_close=true;}else{break Err(denied());}}},
            v=stdout.read(&mut ob),if !out_end => {match v{Ok(0)=>out_end=true,Ok(n)=>{if out.len()+err.len()+n>max_bytes{break Err(BrokerError::Invalid("host output exceeds bound"));}out.extend_from_slice(&ob[..n]);},Err(_)=>break Err(denied())}},
            v=stderr.read(&mut eb),if !err_end => {match v{Ok(0)=>err_end=true,Ok(n)=>{if out.len()+err.len()+n>max_bytes{break Err(BrokerError::Invalid("host output exceeds bound"));}err.extend_from_slice(&eb[..n]);},Err(_)=>break Err(denied())}},
            v=child.wait(),if status.is_none() && out_end && err_end && written=>{match v{Ok(s)=>status=Some(s),Err(_)=>break Err(denied())}},
            _=tokio::time::sleep_until(end.into())=>break Ok(true),
        }
    };
    if !result.as_ref().is_ok_and(|timed| !*timed) {
        terminate_unreaped(&mut child, Duration::from_millis(100)).await?;
    }
    let timed_out = result?;
    // A leader can exit while descendants retain its pipes. Timeout still reaps
    // the process group; dropping an ordinary Child alone would strand them.
    image.check()?;
    Ok(Output {
        code: status.and_then(|s| s.code()).unwrap_or(1),
        stdout: out,
        stderr: err,
        timed_out,
    })
}
