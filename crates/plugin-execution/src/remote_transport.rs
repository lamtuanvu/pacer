//! Concrete fixed-script owner for NativeRemote; binary artifacts never cross RPC.
use crate::WireReply;
use crate::{
    BrokerError, BundleSpec, NativeBundle, NativeGit, NativeSsh, RemoteHost, RemoteOperation,
    native_command::{CommandFailure, denied},
    native_git::{facts, remote_preflight, transfer_owner},
    native_run::directory::RunDirectory,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::Instant,
};

mod start;
#[cfg(test)]
mod tests;

pub struct RemoteTransport {
    home: PathBuf,
    ssh: NativeSsh,
    git: NativeGit,
    deadline: Instant,
    current: std::sync::Arc<dyn Fn() -> String + Send + Sync>,
    offsets: HashMap<String, u64>,
    tails: HashMap<String, Vec<u8>>,
}
impl RemoteTransport {
    pub fn new(
        home: &Path,
        ssh: NativeSsh,
        git: NativeGit,
        deadline: Instant,
        current: impl Fn() -> String + Send + Sync + 'static,
    ) -> Self {
        let current: std::sync::Arc<dyn Fn() -> String + Send + Sync> =
            std::sync::Arc::new(current);
        let selected = current.clone();
        let expected = ssh.config.fingerprint.clone();
        let git = git.with_context(std::sync::Arc::new(move || selected() == expected));
        Self {
            home: home.into(),
            ssh,
            git,
            deadline,
            current,
            offsets: HashMap::new(),
            tails: HashMap::new(),
        }
    }
    fn active(&self) -> Result<(), BrokerError> {
        self.ssh.check()?;
        if (self.current)() != self.ssh.config.fingerprint {
            return Err(denied());
        }
        if Instant::now() >= self.deadline {
            return Err(BrokerError::Timeout);
        }
        Ok(())
    }
    async fn fixed(
        &self,
        name: &str,
        args: &[String],
        input: &[u8],
        mutating: bool,
        max: usize,
    ) -> Result<Value, BrokerError> {
        self.active()?;
        let timeout_ms = if name == "STOP" {
            let [_, seconds] = args else {
                return Err(denied());
            };
            let grace = seconds
                .parse::<u64>()
                .ok()
                .filter(|n| (1..=25).contains(n) && seconds == &n.to_string())
                .ok_or_else(denied)?;
            grace
                .checked_add(10)
                .and_then(|n| n.checked_mul(1000))
                .ok_or_else(denied)?
        } else {
            60000
        };
        let lease = if mutating {
            let label = format!(
                "Remote {} operation on {}",
                start::operation_label(name)?,
                self.ssh.config.alias
            );
            let blocker = uuid::Uuid::new_v4().to_string();
            Some(crate::WorkLease::begin_blocker(
                &self.home,
                crate::Blocker {
                    kind: crate::BlockerKind::Operation,
                    id: &blocker,
                    label: &label,
                },
            )?)
        } else {
            None
        };
        if let Some(lease) = &lease {
            // TS registry.ts:425/497/572: re-check after admission, before
            // dispatch. Synchronous; the finish error wins (D5).
            if let Err(error) = self.active() {
                lease.finish()?;
                return Err(error);
            }
        }
        let nonce = lease.as_ref().map(|lease| lease.id().to_owned());
        // No `.await` between begin_blocker and the spawn inside run_tracked.
        let mut result = match self
            .ssh
            .run_tracked(
                name,
                args,
                nonce.as_deref(),
                input,
                timeout_ms,
                max,
                self.deadline,
            )
            .await
        {
            Ok(result) => result,
            Err(CommandFailure::Undispatched(error)) => {
                if let Some(lease) = &lease {
                    lease.finish()?;
                }
                return Err(error);
            }
            // The effect may have begun: the lease stays pending.
            Err(CommandFailure::Dispatched(error)) => return Err(error),
        };
        if result["timedOut"] == false
            && let (Some(lease), Some(nonce)) = (&lease, &nonce)
        {
            let suffix = format!("\n__PACER_DONE__={nonce}\n");
            let text = result["stdout"]
                .as_str()
                .ok_or_else(denied)?
                .strip_suffix(&suffix)
                .ok_or_else(denied)?
                .to_owned();
            // Receipt-proven: release before re-validation (registry.ts:436-438).
            lease.finish()?;
            result["stdout"] = json!(text);
        }
        self.active()?;
        Ok(result)
    }
    async fn checked(
        &self,
        name: &str,
        args: &[String],
        input: &[u8],
        mutating: bool,
        max: usize,
    ) -> Result<String, BrokerError> {
        let result = self.fixed(name, args, input, mutating, max).await?;
        if result["code"].as_f64() != Some(0.0) || result["timedOut"] != false {
            return Err(BrokerError::Effect(
                "remote fixed operation is unverified".into(),
            ));
        }
        Ok(result["stdout"].as_str().ok_or_else(denied)?.into())
    }
    async fn question(&self, id: &str, run: &Value) -> Result<Vec<String>, BrokerError> {
        let work = text(run, "remoteWorktree")?;
        let question = self
            .checked("QUESTION", &[work.into()], &[], false, 4096)
            .await?;
        if !question.is_empty() {
            if crate::js_semantics::utf16_len(&question) > 1000 {
                return Err(denied());
            }
            let mut store = pacer_store::TaskStore::open(&self.home)?;
            let current = transfer_owner(&mut store, id, run)?;
            if let Some(prior) = current.get("question") {
                if prior["text"] != question {
                    return Err(denied());
                }
            } else {
                store.edit(
                    id,
                    crate::native_run::rev(&current)?,
                    crate::native_run::now(),
                    |t| {
                        t.put(
                            "/question",
                            WireReply::new(json!({"text":question,"at":crate::native_run::now()})),
                        )
                    },
                )?;
            }
        }
        let mut args = vec![
            work.into(),
            text(run, "baseSha")?.into(),
            text(run, "remoteBranch")?.into(),
        ];
        if !question.is_empty() {
            let input = format!("blob {}\0{question}", question.len()).into_bytes();
            use sha1::Sha1;
            args.push(format!("{:x}", Sha1::digest(&input)));
            args.push(format!("{:x}", Sha256::digest(&input)));
        }
        Ok(args)
    }
    async fn observe(&mut self, id: &str, run: &Value) -> Result<Value, BrokerError> {
        let remote = text(run, "remoteDir")?.to_owned();
        let report = self
            .checked("REPORT", std::slice::from_ref(&remote), &[], false, 65536)
            .await?;
        let f = facts(&report)?;
        let binding = RunDirectory::existing(
            &self.home,
            id,
            crate::js_semantics::safe_u64(&run["attempt"]).ok_or_else(denied)?,
        )?;
        let admission: Value =
            serde_json::from_slice(&binding.bytes("admission.json", 65536)?.ok_or_else(denied)?)
                .map_err(|_| denied())?;
        if admission["host"] != self.ssh.config.alias || admission["remoteDir"] != remote {
            return Err(denied());
        }
        let mut complete = true;
        for (stream, key) in [("stdout", "out"), ("stderr", "err")] {
            let total = f
                .get(key)
                .and_then(|v| crate::js_semantics::number_text(v))
                .and_then(|n| crate::js_semantics::safe_u64(&json!(n)))
                .ok_or_else(denied)?;
            let mut offset = *self.offsets.get(stream).unwrap_or(&0);
            if total < offset {
                return Err(denied());
            }
            let mut budget = 4 * 1024 * 1024;
            while offset < total && budget > 0 {
                let len = (total - offset).min(262144).min(budget);
                let args = vec![
                    remote.clone(),
                    stream.into(),
                    offset.to_string(),
                    len.to_string(),
                    "hex".into(),
                ];
                let encoded = self.checked("READ_FROM", &args, &[], false, 524288).await?;
                if encoded.len() % 2 != 0 || encoded.len() as u64 > len * 2 {
                    return Err(denied());
                }
                let mut bytes = Vec::new();
                for chunk in encoded.as_bytes().as_chunks::<2>().0 {
                    let pair = std::str::from_utf8(chunk).map_err(|_| denied())?;
                    bytes.push(u8::from_str_radix(pair, 16).map_err(|_| denied())?);
                }
                if bytes.is_empty() {
                    break;
                }
                offset += bytes.len() as u64;
                budget -= bytes.len() as u64;
                let tail = self.tails.entry(stream.into()).or_default();
                tail.extend(bytes);
                if tail.len() > 262144 {
                    tail.drain(..tail.len() - 262144);
                }
                self.offsets.insert(stream.into(), offset);
            }
            complete &= offset == total;
        }
        let exit = f
            .get("exit")
            .and_then(|v| crate::js_semantics::number_text(v))
            .and_then(|n| crate::js_semantics::safe_i64(&json!(n)));
        let nonce = admission["lease"].as_str().ok_or_else(denied)?;
        complete &= f.get("admission_complete").map(String::as_str) == Some(nonce);
        if complete && exit.is_some() {
            crate::WorkLease::complete_remote(&self.home, nonce, &self.ssh.config.alias, &remote)?;
        }
        Ok(
            json!({"alive":f.get("alive").map(String::as_str)==Some("1"),"exit":exit,"complete":complete,
            "stdoutBase64":STANDARD.encode(self.tails.get("stdout").map_or(&[][..],Vec::as_slice)),"stderrBase64":STANDARD.encode(self.tails.get("stderr").map_or(&[][..],Vec::as_slice))}),
        )
    }
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str, BrokerError> {
    v[key].as_str().ok_or_else(denied)
}
impl RemoteHost for RemoteTransport {
    fn fingerprint(&self) -> String {
        (self.current)()
    }
    async fn invoke(&mut self, op: RemoteOperation, p: &Value) -> Result<Value, BrokerError> {
        self.active()?;
        let intent = &p["intent"];
        let run = &p["run"];
        let id = text(p, "taskId")?;
        if intent["hostFingerprint"] != self.ssh.config.fingerprint
            || intent["alias"] != self.ssh.config.alias
        {
            return Err(denied());
        }
        match op {
            RemoteOperation::Prepare
            | RemoteOperation::PrepareBundle
            | RemoteOperation::Recover => {
                let repo = self.git.repo()?;
                if repo != text(intent, "repoTop")? {
                    return Err(denied());
                }
                let url = self
                    .git
                    .text(repo, &["remote", "get-url", "origin"], &[], self.deadline)
                    .await?;
                if format!("{:x}", Sha256::digest(url.as_bytes())) != text(intent, "originHash")? {
                    return Err(denied());
                }
                if self
                    .git
                    .text(
                        repo,
                        &[
                            "rev-parse",
                            "--verify",
                            &format!("{}^{{commit}}", text(intent, "base")?),
                        ],
                        &[],
                        self.deadline,
                    )
                    .await?
                    != text(intent, "baseSha")?
                {
                    return Err(denied());
                }
                let configured: Value =
                    serde_json::from_str(&self.ssh.config.fingerprint).map_err(|_| denied())?;
                let key = repo_key(&url).ok_or_else(denied)?;
                if configured["ssh"] != self.ssh.config.target
                    || configured["paused"] == true
                    || configured["session"] == "full"
                    || configured["repos"][&key] != intent["checkout"]
                {
                    return Err(denied());
                }
                let tag = format!(
                    "{}-{}",
                    key.rsplit('/').next().ok_or_else(denied)?,
                    &format!("{:x}", sha1::Sha1::digest(key.as_bytes()))[..8]
                );
                if intent["tag"] != tag {
                    return Err(denied());
                }
                let attempt =
                    crate::js_semantics::safe_u64(&intent["attempt"]).ok_or_else(denied)?;
                let args = vec![
                    text(intent, "checkout")?.into(),
                    text(intent, "tag")?.into(),
                    id.into(),
                    text(intent, "baseSha")?.into(),
                    text(intent, "base")?.into(),
                    attempt.to_string(),
                ];
                let input = if op == RemoteOperation::PrepareBundle {
                    self.git
                        .base_bundle(id, text(intent, "baseSha")?, self.deadline)
                        .await?
                } else {
                    vec![]
                };
                self.fixed(
                    if op == RemoteOperation::Recover {
                        "PREPARE_RECOVER"
                    } else {
                        "PREPARE"
                    },
                    &args,
                    &input,
                    op != RemoteOperation::Recover,
                    65536,
                )
                .await
            }
            RemoteOperation::Start => {
                let launch = &p["launch"];
                // Existing position (malformed typed input); `[]` fails at issuance.
                let argv = launch["argv"].as_array().ok_or_else(denied)?;
                // A non-object env is ignored (existing native default).
                let env = launch["env"].as_object();
                // TS run-io.ts:61 env-key precheck, before admission.
                if env.is_some_and(|env| !env.keys().all(|k| start::env_key(k))) {
                    return Err(denied());
                }
                let alias = self.ssh.config.alias.as_str();
                let remote_dir = text(run, "remoteDir")?;
                let session = start::session_blocker_id(alias, remote_dir);
                let label = format!("Remote session on {alias}");
                // A reservation error wins over every later validation (TS order).
                let lease = crate::WorkLease::begin_blocker(
                    &self.home,
                    crate::Blocker {
                        kind: crate::BlockerKind::Session,
                        id: &session,
                        label: &label,
                    },
                )?;
                // TS `sent = false` window (run-io.ts:67-79). Synchronous; any
                // error here is proven pre-dispatch. A stale admission.json then
                // names a lease that no longer exists, so complete_remote matches
                // nothing; NativeRemote forbids a second START in the attempt, and
                // TS leaves the same stale file (run-io.ts:71/94).
                let staged = (|| -> Result<(Vec<String>, Vec<u8>), BrokerError> {
                    let local = text(run, "dir")?;
                    lease.attach_remote(local, alias, remote_dir)?;
                    let attempt =
                        crate::js_semantics::safe_u64(&intent["attempt"]).ok_or_else(denied)?;
                    let dir = RunDirectory::existing(&self.home, id, attempt)?;
                    dir.write(
                        "admission.json",
                        &serde_json::to_vec(
                            &json!({"lease":lease.id(),"host":alias,"remoteDir":run["remoteDir"]}),
                        )
                        .map_err(|_| denied())?,
                    )?;
                    let args = start::compose(
                        remote_dir,
                        text(run, "workdir")?,
                        env,
                        id,
                        lease.id(),
                        argv,
                    )?;
                    // A non-string stdin becomes "" (existing native default).
                    let input = start::input(launch["stdin"].as_str().unwrap_or_default());
                    // TS loadStrategy at issuance.
                    let host = (self.current)();
                    start::issue(
                        &start::Issue {
                            alias,
                            id,
                            remote_dir,
                            local_dir: local,
                            run,
                            args: &args,
                            input: &input,
                        },
                        &host,
                    )?;
                    Ok((args, input))
                })();
                let (args, input) = match staged {
                    Ok(staged) => staged,
                    Err(error) => {
                        // D5: the finish error wins.
                        lease.finish()?;
                        return Err(error);
                    }
                };
                // TS `sent = true` (run-io.ts:80): every later outcome retains the
                // session lease, even a nested Undispatched operation.
                let f = facts(&self.checked("START", &args, &input, true, 65536).await?)?;
                if f.contains_key("error") {
                    return Err(denied());
                }
                let pid = f
                    .get("pid")
                    .and_then(|v| crate::js_semantics::number_text(v))
                    .and_then(|n| crate::js_semantics::safe_u64(&json!(n)))
                    .filter(|n| *n > 0)
                    .ok_or_else(denied)?;
                Ok(json!({"pid":pid}))
            }
            RemoteOperation::Read | RemoteOperation::Report => self.observe(id, run).await,
            RemoteOperation::Stop => {
                let grace = crate::js_semantics::safe_u64(&p["extra"]["graceMs"])
                    .filter(|n| *n > 0 && *n <= 25000)
                    .ok_or_else(denied)?;
                let args = vec![
                    text(run, "remoteDir")?.into(),
                    grace.div_ceil(1000).to_string(),
                ];
                let f = facts(&self.checked("STOP", &args, &[], true, 65536).await?)?;
                let code = f
                    .get("code")
                    .and_then(|v| crate::js_semantics::number_text(v))
                    .and_then(|n| crate::js_semantics::safe_i64(&json!(n)))
                    .ok_or_else(denied)?;
                let killed = match f.get("killed").map(String::as_str) {
                    Some("0") => false,
                    Some("1") => true,
                    _ => return Err(denied()),
                };
                Ok(json!({"code":code,"killed":killed}))
            }
            RemoteOperation::Preflight => {
                let args = self.question(id, run).await?;
                let f = facts(&self.checked("PREFLIGHT", &args, &[], false, 65536).await?)?;
                let exact = f.len() == 7
                    && [
                        "ancestor",
                        "dirty",
                        "dirty_files",
                        "commits",
                        "emails",
                        "signoffs",
                        "head",
                    ]
                    .iter()
                    .all(|k| f.contains_key(*k));
                let no_work = exact
                    && [
                        ("ancestor", "1"),
                        ("dirty", "0"),
                        ("dirty_files", ""),
                        ("commits", "0"),
                        ("emails", ""),
                        ("signoffs", ""),
                    ]
                    .iter()
                    .all(|(k, v)| f.get(*k).map(String::as_str) == Some(*v))
                    && f.get("head").map(String::as_str) == Some(text(run, "baseSha")?);
                let commits = f.get("commits").is_some_and(|v| {
                    v.as_bytes()
                        .first()
                        .is_some_and(|b| (b'1'..=b'9').contains(b))
                        && v.bytes().all(|b| b.is_ascii_digit())
                        && crate::js_semantics::number_text(v)
                            .and_then(|n| crate::js_semantics::safe_u64(&json!(n)))
                            .is_some()
                });
                Ok(
                    json!({"noWork":no_work,"baseSha":run["baseSha"],"committedWork":exact&&commits}),
                )
            }
            RemoteOperation::Transfer => {
                let args = self.question(id, run).await?;
                self.git
                    .admit_destination(&self.home, id, run, self.deadline)
                    .await?;
                let preflight = self.checked("PREFLIGHT", &args, &[], false, 65536).await?;
                let (head, commits) = remote_preflight(&preflight, text(run, "baseSha")?)?;
                let args = args[..3].to_vec();
                let mut argv = vec!["ssh".into()];
                argv.extend(self.ssh.argv("BUNDLE_OUT", &args, None)?);
                let mut bundle = NativeBundle::prepare(
                    &self.home,
                    BundleSpec {
                        argv: argv.clone(),
                        executable: self.ssh.image.canonical.to_string_lossy().into_owned(),
                        env: self.ssh.env.clone(),
                        timeout_ms: 60000,
                        max_bytes: 50 * 1024 * 1024,
                    },
                )?;
                let result = bundle
                    .stage(
                        &json!({"argv":argv,"timeoutMs":60000,"maxBytes":50*1024*1024}),
                        self.deadline,
                    )
                    .await?;
                let mut ticket = bundle.claim(text(&result, "handle")?)?;
                let verified = self
                    .git
                    .verify(
                        &mut ticket,
                        text(run, "baseSha")?,
                        text(run, "remoteBranch")?,
                        self.deadline,
                    )
                    .await?;
                if verified.head() != head || verified.commits() != commits {
                    return Err(denied());
                }
                self.question(id, run).await?;
                self.active()?;
                ticket.dispose()?;
                self.git
                    .publish(&self.home, id, run, verified, self.deadline)
                    .await
            }
        }
    }
}

fn repo_key(value: &str) -> Option<String> {
    let scp = regex::Regex::new(r"^[^@\s/:]+@([A-Za-z0-9.-]+):([^\s]+)$").ok()?;
    let (host, path) = if let Some(c) = scp.captures(value) {
        (c.get(1)?.as_str().to_owned(), c.get(2)?.as_str().to_owned())
    } else {
        let parsed = url::Url::parse(value).ok()?;
        if !["https", "ssh"].contains(&parsed.scheme())
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || parsed.password().is_some()
        {
            return None;
        }
        (
            parsed.host_str()?.to_owned(),
            parsed.path().strip_prefix('/')?.to_owned(),
        )
    };
    let key = format!("{host}/{path}").to_lowercase();
    let key = key.strip_suffix(".git").unwrap_or(&key);
    let canonical = regex::Regex::new(r"^[a-z0-9][a-z0-9.-]*/[a-z0-9._-]+/[a-z0-9._-]+$").ok()?;
    (canonical.is_match(key) && !key.ends_with(".git")).then(|| key.to_owned())
}
