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
pub async fn run(
    image: &Image,
    args: &[String],
    env: &HashMap<String, String>,
    input: &[u8],
    timeout_ms: u64,
    max_bytes: usize,
    deadline: Instant,
) -> Result<Output, BrokerError> {
    image.check()?;
    if Instant::now() >= deadline || timeout_ms == 0 {
        return Err(BrokerError::Timeout);
    }
    if args.iter().any(|s| s.contains('\0')) {
        return Err(denied());
    }
    let mut child = OwnedChild(
        Command::new(&image.canonical)
            .args(args)
            .env_clear()
            .envs(env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| denied())?,
    );
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
    let mut status = None;
    let (mut ob, mut eb) = (vec![0; 65536], vec![0; 65536]);
    let end = deadline.min(Instant::now() + Duration::from_millis(timeout_ms));
    let result = loop {
        if status.is_some() && out_end && err_end {
            break Ok(false);
        }
        tokio::select! {
            v=&mut write,if !written => {written=true;if v.is_err() && !input.is_empty(){break Err(denied());}},
            v=stdout.read(&mut ob),if !out_end => {match v{Ok(0)=>out_end=true,Ok(n)=>{if out.len()+err.len()+n>max_bytes{break Err(BrokerError::Invalid("host output exceeds bound"));}out.extend_from_slice(&ob[..n]);},Err(_)=>break Err(denied())}},
            v=stderr.read(&mut eb),if !err_end => {match v{Ok(0)=>err_end=true,Ok(n)=>{if out.len()+err.len()+n>max_bytes{break Err(BrokerError::Invalid("host output exceeds bound"));}err.extend_from_slice(&eb[..n]);},Err(_)=>break Err(denied())}},
            v=child.wait(),if status.is_none() && out_end && err_end=>{match v{Ok(s)=>status=Some(s),Err(_)=>break Err(denied())}},
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
