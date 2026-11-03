#![allow(clippy::unwrap_used)]
#[path = "support/exact_task.rs"]
mod exact_task;
#[path = "support/git_shim.rs"]
mod git_shim;
use pacer_plugin_host::{BundleSpec, BundleTicket, NativeBundle, NativeGit, remote_preflight};
use std::{
    collections::HashMap,
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};
const ID: &str = "t-20261102-175253-93d8";
fn git(repo: &Path, args: &[&str]) -> Vec<u8> {
    let r = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
    r.stdout
}
fn text(repo: &Path, args: &[&str]) -> String {
    String::from_utf8(git(repo, args)).unwrap().trim().into()
}
struct Fixture {
    root: PathBuf,
    repo: PathBuf,
    remote: PathBuf,
    base: String,
    head: String,
    branch: String,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("pacer-native-git-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let root = fs::canonicalize(root).unwrap();
        // Owned, initially-empty global gitconfig (mode 0600) plus an owned xdg
        // dir, so an ordinary Git sees only the fixture's config, never the
        // machine's system or user config (toolchain gitconfigs commonly install
        // a credential helper and other global settings).
        fs::write(root.join("owner.gitconfig"), b"").unwrap();
        fs::set_permissions(
            root.join("owner.gitconfig"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        fs::create_dir(root.join("xdg")).unwrap();
        fs::set_permissions(root.join("xdg"), fs::Permissions::from_mode(0o700)).unwrap();
        let repo = root.join("local");
        fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["config", "user.name", "Fixture"]);
        git(&repo, &["config", "user.email", "fixture@invalid.test"]);
        fs::write(repo.join("base"), "base").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-qm", "base"]);
        let base = text(&repo, &["rev-parse", "HEAD"]);
        let remote = root.join("remote");
        git(
            &repo,
            &[
                "clone",
                "-q",
                repo.to_str().unwrap(),
                remote.to_str().unwrap(),
            ],
        );
        git(&remote, &["config", "user.name", "Fixture"]);
        git(&remote, &["config", "user.email", "fixture@invalid.test"]);
        let branch = format!("pacer/{ID}");
        git(&remote, &["checkout", "-qb", &branch]);
        fs::write(remote.join("change"), "change").unwrap();
        git(&remote, &["add", "."]);
        git(
            &remote,
            &[
                "commit",
                "-qm",
                "result\n\nSigned-off-by: Fixture <fixture@invalid.test>",
            ],
        );
        let head = text(&remote, &["rev-parse", "HEAD"]);
        Self {
            root,
            repo,
            remote,
            base,
            head,
            branch,
        }
    }
    /// The owner-selected environment every fixture hands to NativeGit: PATH,
    /// HOME=<root>, Git config fully owned (NOSYSTEM + owned global gitconfig +
    /// XDG), plus markers proving `GIT_*` (and `PACER_*`) pass-through or drop.
    fn owner_env(&self) -> HashMap<String, String> {
        HashMap::from([
            ("PATH".into(), std::env::var("PATH").unwrap()),
            ("HOME".into(), self.root.to_str().unwrap().into()),
            ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
            (
                "GIT_CONFIG_GLOBAL".into(),
                self.root.join("owner.gitconfig").to_str().unwrap().into(),
            ),
            (
                "XDG_CONFIG_HOME".into(),
                self.root.join("xdg").to_str().unwrap().into(),
            ),
            ("PACER_FIXTURE_MARKER".into(), "owner".into()),
            ("GIT_FIXTURE_MARKER".into(), "owner".into()),
        ])
    }
    fn native(&self) -> NativeGit {
        NativeGit::prepare(&self.root, &self.repo, "/usr/bin/git", &self.owner_env()).unwrap()
    }
    async fn ticket(&self, bytes: &[u8]) -> BundleTicket {
        let source = self.root.join(format!("source-{}", uuid::Uuid::new_v4()));
        fs::write(&source, bytes).unwrap();
        let child = self.root.join("ssh");
        fs::write(&child,"#!/usr/bin/env python3\nimport os,sys\nsys.stdout.buffer.write(open(os.environ['FIXTURE_BUNDLE'],'rb').read())\n").unwrap();
        fs::set_permissions(&child, fs::Permissions::from_mode(0o700)).unwrap();
        let argv = vec!["ssh".into()];
        let env = HashMap::from([
            ("PATH".into(), std::env::var("PATH").unwrap()),
            ("FIXTURE_BUNDLE".into(), source.to_str().unwrap().into()),
        ]);
        let mut stage = NativeBundle::prepare(
            &self.root,
            BundleSpec {
                argv: argv.clone(),
                executable: child.to_str().unwrap().into(),
                env,
                timeout_ms: 60000,
                max_bytes: 50 * 1024 * 1024,
            },
        )
        .unwrap();
        let result = stage
            .stage(
                &serde_json::json!({"argv":argv,"timeoutMs":60000,"maxBytes":50*1024*1024}),
                deadline(),
            )
            .await
            .unwrap();
        stage.claim(result["handle"].as_str().unwrap()).unwrap()
    }
    fn bytes(&self) -> Vec<u8> {
        git(
            &self.remote,
            &[
                "bundle",
                "create",
                "-",
                &format!("{}..{}", self.base, self.branch),
            ],
        )
    }
}
fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(60)
}
#[tokio::test]
async fn verified_snapshot_requires_exact_head_identity_history_and_does_not_import_into_local_repo()
 {
    let f = Fixture::new();
    let native = f.native();
    let mut ticket = f.ticket(&f.bytes()).await;
    let verified = native
        .verify(&mut ticket, &f.base, &f.branch, deadline())
        .await
        .unwrap();
    assert_eq!(verified.head(), f.head);
    assert_eq!(verified.commits(), 1);
    let has = Command::new("git")
        .arg("-C")
        .arg(&f.repo)
        .args(["cat-file", "-e", &f.head])
        .output()
        .unwrap();
    assert!(!has.status.success());
    ticket.dispose().unwrap();
}
#[tokio::test]
async fn bundle_ref_mismatch_foreign_author_committer_and_signoff_are_rejected() {
    for mutation in [
        "branch",
        "author",
        "committer",
        "signoff",
        "unicode-signoff",
        "multiple",
    ] {
        let f = Fixture::new();
        match mutation {
            "author" => {
                git(
                    &f.remote,
                    &[
                        "commit",
                        "--amend",
                        "--no-edit",
                        "--author",
                        "Other <other@invalid.test>",
                    ],
                );
            }
            "committer" => {
                git(&f.remote, &["config", "user.email", "other@invalid.test"]);
                git(&f.remote, &["commit", "--amend", "--no-edit"]);
            }
            "unicode-signoff" => {
                git(
                    &f.remote,
                    &[
                        "commit",
                        "--amend",
                        "-qm",
                        "result\u{2028}Signed-off-by: Other <other@invalid.test>",
                    ],
                );
            }
            "signoff" => {
                git(
                    &f.remote,
                    &[
                        "commit",
                        "--amend",
                        "-qm",
                        "result\n\nSIGNED-OFF-BY: Other <other@invalid.test>",
                    ],
                );
            }
            _ => {}
        }
        let bytes = if mutation == "multiple" {
            git(&f.remote, &["branch", "pacer/extra"]);
            git(&f.remote, &["bundle", "create", "-", "--branches"])
        } else {
            f.bytes()
        };
        let mut ticket = f.ticket(&bytes).await;
        let branch = if mutation == "branch" {
            "pacer/foreign"
        } else {
            &f.branch
        };
        assert!(
            f.native()
                .verify(&mut ticket, &f.base, branch, deadline())
                .await
                .is_err(),
            "{mutation}"
        );
    }
}
#[tokio::test]
async fn base_bundle_ref_is_temporary_and_binary_bytes_are_not_rpc_text() {
    let f = Fixture::new();
    let bytes = f
        .native()
        .base_bundle(ID, &f.base, deadline())
        .await
        .unwrap();
    assert!(bytes.starts_with(b"# v2 git bundle"));
    assert!(
        Command::new("git")
            .arg("-C")
            .arg(&f.repo)
            .args([
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/pacer/base/{ID}")
            ])
            .status()
            .unwrap()
            .code()
            == Some(1)
    );
}
#[test]
fn preflight_duplicate_dirty_ancestry_count_head_and_js_trim_matrix() {
    let base = "a".repeat(40);
    let good = format!("ancestor=1\ndirty=0\ncommits=1\nhead={}\n", "b".repeat(40));
    assert_eq!(remote_preflight(&good, &base).unwrap().1, 1);
    for bad in [
        good.replace("dirty=0", "dirty=1"),
        good.replace("ancestor=1", "ancestor=0"),
        good.replace("commits=1", "commits=501"),
        good.replace("commits=1", "commits=0"),
        good.replace("commits=1", "commits=01"),
        good.replace("commits=1", "commits=1e0"),
        good.replace("commits=1", "commits=9007199254740992"),
        format!("{good}dirty=0\n"),
        good.replace(&"b".repeat(40), &"b".repeat(39)),
        format!("{good}\u{0085}"),
    ] {
        assert!(remote_preflight(&bad, &base).is_err(), "{bad:?}");
    }
    assert!(remote_preflight(&format!("{good}\u{feff}"), &base).is_ok());
}
#[tokio::test]
async fn concrete_remote_transport_runs_the_owned_pipe_and_verified_git_transfer() {
    use pacer_plugin_host::{NativeRemote, NativeSsh, RemoteIntent, RemoteTransport, SshConfig};
    use serde_json::json;
    use sha2::{Digest, Sha256};
    let f = Fixture::new();
    let bundle = f.root.join("result.bundle");
    fs::write(&bundle, f.bytes()).unwrap();
    git(
        &f.repo,
        &[
            "remote",
            "add",
            "origin",
            "https://fixture.invalid/team/repo.git",
        ],
    );
    let executable = f.root.join("fixture-ssh");
    fs::write(&executable,r##"#!/usr/bin/env python3
import sys,shlex,os,re
words=shlex.split(sys.argv[-1]);program=words[2];args=words[4:]
root=os.environ['FIXTURE_ROOT'];task=os.environ['FIXTURE_TASK'];base=os.environ['FIXTURE_BASE'];head=os.environ['FIXTURE_HEAD'];branch='pacer/'+task
assert sys.argv[1:5]==['-o','BatchMode=yes','-o','ConnectTimeout=10']
if 'git bundle create -' in program:
 assert '__PACER_BEGIN__' not in program
 sys.stdout.buffer.write(open(root+'/result.bundle','rb').read());sys.exit(0)
if 'checkout="$1"; tag="$2"' in program:
 output='worktree=/remote/.pacer-remote/worktrees/repo-c108e486/'+task+'-1\nbranch='+branch+'\n'
elif 'cwd="$2"; mode="$3"' in program:
 nonce=next(a.split('=',1)[1] for a in args if a.startswith('PACER_COMPLETION_NONCE='))
 open(root+'/completion','w').write(nonce)
 data=sys.stdin.buffer.read();assert data.endswith(b'private host prompt');assert b'__PACER_STDIN__\n' in data
 output='pid=12345\n'
elif 'admission_complete=' in program:
 output='admission_complete='+open(root+'/completion').read()+'\nsession=pipe\npid=12345\nalive=0\nexit=0\nstarted=1\nout=13\nerr=0\n'
elif 'Hex mode preserves' in program:
 content=b'native\x00output' if args[1]=='stdout' else b''
 output=content[int(args[2]):int(args[2])+int(args[3])].hex()
elif 'ancestor=0' in program:
 import json
 record=json.load(open(root+'/tasks/'+task+'.json'))
 assert record['remoteTransferIntent']['branch']==branch
 output='ancestor=1\ndirty=0\ndirty_files=\ncommits=1\nemails=fixture@invalid.test\nsignoffs=fixture@invalid.test\nhead='+head+'\n'
elif 'file="$1/.pacer-question"' in program: output='question 😀'
else: raise Exception(program)
nonce=re.findall(r'__PACER_DONE__=([a-f0-9-]{36})',program)
sys.stdout.write('__PACER_BEGIN__\n'+output+ ('\n__PACER_DONE__='+nonce[0]+'\n' if nonce else ''))
"##).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let env = HashMap::from([
        ("PATH".into(), std::env::var("PATH").unwrap()),
        ("HOME".into(), f.root.to_str().unwrap().into()),
        ("FIXTURE_ROOT".into(), f.root.to_str().unwrap().into()),
        ("FIXTURE_TASK".into(), ID.into()),
        ("FIXTURE_BASE".into(), f.base.clone()),
        ("FIXTURE_HEAD".into(), f.head.clone()),
    ]);
    let fingerprint=json!({"alias":"box","ssh":"fixture-host","repos":{"fixture.invalid/team/repo":"/fixture/source"},"accounts":{}}).to_string();
    let ssh = NativeSsh::prepare(
        &f.root,
        SshConfig {
            alias: "box".into(),
            target: "fixture-host".into(),
            fingerprint: fingerprint.clone(),
        },
        executable.to_str().unwrap(),
        env,
    )
    .unwrap();
    let configured = fingerprint.clone();
    // Plan §4 Task 1 / review F1: drive the real `RemoteTransport::invoke(
    // Transfer)` caller path through the *owned git shim* (not /usr/bin/git)
    // so every Git phase the transfer runs is logged with its argv+env. The
    // shim `Exec`s through to real git under the env NativeGit selects; this
    // is the same environment every owner-selected fixture hands NativeGit.
    let shim = git_shim::shim(&f.root, &[]); // Exec -> real git, argv+env logged
    let native =
        NativeGit::prepare(&f.root, &f.repo, shim.to_str().unwrap(), &f.owner_env()).unwrap();
    let host = RemoteTransport::new(&f.root, ssh, native, deadline(), move || configured.clone());
    let intent = RemoteIntent {
        attempt: 1,
        provider_id: "pacer-exec-direct".into(),
        executor: "codex@box".into(),
        alias: "box".into(),
        host_fingerprint: fingerprint,
        repo_top: f.repo.to_str().unwrap().into(),
        origin_hash: format!(
            "{:x}",
            Sha256::digest(b"https://fixture.invalid/team/repo.git")
        ),
        checkout: "/fixture/source".into(),
        tag: "repo-c108e486".into(),
        base_sha: f.base.clone(),
        base: "HEAD".into(),
    };
    pacer_store::TaskStore::open(&f.root).unwrap().insert(&json!({"id":ID,"rev":1,"createdAt":1,"state":"running","executorProvider":"pacer-exec-direct","executor":"codex@box","attempts":[],"brief":{"repo":f.repo}}),1.0).unwrap();
    exact_task::seed(&f.root, ID);
    let mut remote = NativeRemote::issue(
        &f.root,
        ID,
        intent,
        host,
        json!({"argv":["codex","exec"],"stdin":"private host prompt"}),
        deadline(),
    )
    .unwrap();
    let p = json!({"taskId":ID,"attempt":1.0});
    for method in [
        "capability.hosts.prepareOwned",
        "capability.hosts.claimOwned",
        "capability.hosts.startOwned",
    ] {
        remote
            .answer(method, &p)
            .await
            .unwrap_or_else(|e| panic!("{method}: {e}"));
    }
    assert_eq!(
        remote
            .answer("capability.hosts.pollOwned", &p)
            .await
            .unwrap()["state"],
        "exited"
    );
    let transferred = remote
        .answer("capability.hosts.transferOwned", &p)
        .await
        .unwrap();
    assert_eq!(transferred["transferred"], true);
    assert_eq!(transferred["commits"], 1);
    let work = Path::new(transferred["reviewWorktree"].as_str().unwrap());
    assert_eq!(text(work, &["rev-parse", "HEAD"]), f.head);
    assert_eq!(fs::read(work.join("change")).unwrap(), b"change");
    // F1: every Git record the real caller path ran is classified by its argv
    // (plan §2.2) — never from the observed environment — and its env must be
    // the owner map (admission #1-3, publication #19-29), the sealed map
    // (verification prelude #7-13), or sealed plus the alternate objects
    // (inspection #14-18). A misrouted command still fails loudly.
    let owner = f.owner_env();
    let owner_clean = git_shim::without_shell(&owner);
    let sealed = git_shim::sealed_for(&owner);
    let objects = f.repo.join(".git").join("objects");
    let mut want_alternate = sealed.clone();
    want_alternate.insert(
        "GIT_ALTERNATE_OBJECT_DIRECTORIES".into(),
        objects.to_str().unwrap().into(),
    );
    let records = git_shim::calls(&f.root);
    assert!(
        !records.is_empty(),
        "RemoteTransport::invoke(Transfer) must run git through the owned shim"
    );
    let (mut owner_records, mut sealed_prelude, mut inspected) = (0, 0, 0);
    for (args, env) in &records {
        let joined = args.join(" ");
        let in_inspection = args.iter().any(|a| a.contains(".bundle-inspect-"));
        let cleaned = git_shim::without_shell(env);
        if in_inspection {
            if args.iter().any(|a| a.contains("--bare")) {
                sealed_prelude += 1; // #13 init --bare stays sealed (no alternate)
                assert_eq!(
                    cleaned, sealed,
                    "verify #13 init `{joined}` must use the sealed map exactly"
                );
            } else {
                inspected += 1; // #14-18
                assert_eq!(
                    cleaned, want_alternate,
                    "verify inspection `{joined}` must use sealed + alternate objects"
                );
            }
        } else if joined.contains("config user.email")
            || joined.contains("rev-parse --show-object-format")
            || joined.contains("bundle verify ")
            || joined.contains("bundle list-heads")
            || joined.contains("rev-parse --path-format=absolute")
            || (joined.contains("rev-parse --verify")
                && args.iter().any(|a| {
                    // verify's sealed prelude bolts a real 40-64 hex object onto
                    // ^{commit}; the owner path's equivalent uses a ref like
                    // HEAD, or refs/heads/..., so it must stay on the owner map.
                    a.strip_suffix("^{commit}").is_some_and(|hex| {
                        (40..=64).contains(&hex.len())
                            && hex
                                .bytes()
                                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                    })
                }))
        {
            sealed_prelude += 1; // #7-12 verification prelude
            assert_eq!(
                cleaned, sealed,
                "verify prelude `{joined}` must use the sealed map exactly"
            );
        } else {
            owner_records += 1; // admission #1-3, publication #19-29
            assert_eq!(
                cleaned, owner_clean,
                "ordinary `{joined}` must run under the owner map exactly"
            );
        }
    }
    assert!(
        owner_records > 0,
        "no ordinary (admission/publication) git commands were logged through the caller path"
    );
    assert_eq!(
        sealed_prelude, 7,
        "verify must run exactly the 7 sealed prelude commands through the caller path"
    );
    assert_eq!(
        inspected, 5,
        "verify must run exactly the 5 inspection commands through the caller path"
    );
    exact_task::assert_preserved(&f.root, ID);
    assert_eq!(
        pacer_store::TaskStore::open(&f.root)
            .unwrap()
            .read(ID)
            .unwrap()
            .unwrap()["question"]["text"],
        "question 😀"
    );
}

#[tokio::test]
async fn cancelled_base_bundle_still_cleans_its_temporary_ref() {
    let f = Fixture::new();
    let shim = f.root.join("git-shim");
    let marker = f.root.join("bundling");
    fs::write(&shim, format!("#!/usr/bin/env python3\nimport os,sys,time\nif 'bundle' in sys.argv:\n open({},'w').close()\n time.sleep(0.25)\nos.execv('/usr/bin/git',['git']+sys.argv[1:])\n", serde_json::to_string(marker.to_str().unwrap()).unwrap())).unwrap();
    fs::set_permissions(&shim, fs::Permissions::from_mode(0o700)).unwrap();
    let native =
        NativeGit::prepare(&f.root, &f.repo, shim.to_str().unwrap(), &f.owner_env()).unwrap();
    let base = f.base.clone();
    let task = tokio::spawn(async move { native.base_bundle(ID, &base, deadline()).await });
    let until = Instant::now() + Duration::from_secs(10);
    while !marker.exists() {
        assert!(Instant::now() < until);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    let reference = format!("refs/pacer/base/{ID}");
    loop {
        let result = Command::new("git")
            .arg("-C")
            .arg(&f.repo)
            .args(["show-ref", "--verify", "--quiet", &reference])
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .status()
            .unwrap();
        if result.code() == Some(1) {
            break;
        }
        assert!(
            Instant::now() < until,
            "cancelled caller stranded its base ref"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[tokio::test]
async fn signoffs_match_typescript_full_body_oracle() {
    for body in [
        "result\n\nSigned-off-by: Other <other@invalid.test\n>",
        "result\nSigned-off-by: Fixture <fixture@invalid.test>",
        "result\rSigned-off-by: Other <other@invalid.test>",
        "result\rSigned-off-by: Fixture <fixture@invalid.test>",
        "result\u{2028}Signed-off-by: Other <other@invalid.test>",
        "result\u{2028}Signed-off-by: Fixture <fixture@invalid.test>",
        "result\u{2029}Signed-off-by: Fixture <fixture@invalid.test>",
        "result\u{2029}Signed-off-by: Other <other@invalid.test>",
        "result\nSigned-off-by: Other <other@invalid.test>",
        "result\nSigned-off-by: <other@invalid.test> <fixture@invalid.test>",
        "result\nSigned-off-by: Fixture <fixture@invalid.test\n>",
    ] {
        let f = Fixture::new();
        git(
            &f.remote,
            &["commit", "--amend", "--cleanup=verbatim", "-qm", body],
        );
        let actual_body = String::from_utf8(git(&f.remote, &["log", "-1", "--format=%B"])).unwrap();
        let oracle = Command::new("bun").args(["-e", "const body = process.argv[1]; const matches = [...body.matchAll(/^Signed-off-by:.*<([^>]+)>/gim)]; process.stdout.write(String(matches.every(m => m[1] === 'fixture@invalid.test')))", &actual_body]).output().unwrap();
        assert!(oracle.status.success());
        let allowed = oracle.stdout == b"true";
        let mut ticket = f.ticket(&f.bytes()).await;
        let result = f
            .native()
            .verify(&mut ticket, &f.base, &f.branch, deadline())
            .await;
        assert_eq!(result.is_ok(), allowed, "body: {body:?}");
    }
}

#[tokio::test]
async fn concrete_remote_stop_rounds_milliseconds_up_to_typescript_seconds() {
    use pacer_plugin_host::{
        AuthorityError, BrokerError, NativeSsh, RemoteHost, RemoteOperation, RemoteTransport,
        SshConfig,
    };
    use serde_json::{Value, json};

    let cases: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/remote-stop-grace.json"
    ))
    .unwrap();
    let f = Fixture::new();
    let remote_dir = format!("/remote/.pacer-remote/runs/{ID}/1");
    // Positive rows match the TS ceil rule; zero must fail its actual issuer.
    let reference = std::process::Command::new("bun")
        .args([
            "-e",
            "import {issueConfiguredHostStop} from './src/plugins/host-stop-issuer.ts'; const [raw,id]=Bun.argv.slice(-2),c=JSON.parse(raw); console.log(JSON.stringify(c.map(x=>{const seconds=Math.ceil(x.graceMs/1000);if(x.error){try{issueConfiguredHostStop({},'box','/remote/.pacer-remote/runs/'+id+'/1','/fixture/local',seconds);return {unexpected:'accepted'};}catch(e){return {error:e.code};}}return {seconds};})));",
            &cases.to_string(),
            ID,
        ])
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .env("HOME", &f.root)
        .env("PACER_HOME", &f.root)
        .output()
        .unwrap();
    assert!(
        reference.status.success(),
        "{}",
        String::from_utf8_lossy(&reference.stderr)
    );
    let expected: Vec<Value> = serde_json::from_slice(&reference.stdout).unwrap();
    assert_eq!(expected.len(), cases.as_array().unwrap().len());
    let executable = f.root.join("fixture-stop-ssh");
    fs::write(
        &executable,
        r##"#!/usr/bin/env python3
import os,re,shlex,sys
words=shlex.split(sys.argv[-1]);program=words[2];args=words[4:]
assert sys.argv[1:5]==['-o','BatchMode=yes','-o','ConnectTimeout=10']
assert sys.argv[-2]=='fixture-host'
assert 'D="$1"; grace="$2"' in program
assert args[0]==os.environ['FIXTURE_REMOTE']
with open(os.environ['FIXTURE_GRACE'],'a') as output: output.write(args[1]+'\n')
nonce=re.findall(r'__PACER_DONE__=([a-f0-9-]{36})',program)
assert len(nonce)==1
sys.stdout.write('__PACER_BEGIN__\ncode=137\nkilled=0\n\n__PACER_DONE__='+nonce[0]+'\n')
"##,
    )
    .unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let captured = f.root.join("stop-seconds");
    let ssh = NativeSsh::prepare(
        &f.root,
        SshConfig {
            alias: "box".into(),
            target: "fixture-host".into(),
            fingerprint: "configured".into(),
        },
        executable.to_str().unwrap(),
        HashMap::from([
            ("PATH".into(), std::env::var("PATH").unwrap()),
            ("HOME".into(), f.root.to_str().unwrap().into()),
            ("FIXTURE_GRACE".into(), captured.to_str().unwrap().into()),
            ("FIXTURE_REMOTE".into(), remote_dir.clone()),
        ]),
    )
    .unwrap();
    let mut transport =
        RemoteTransport::new(&f.root, ssh, f.native(), deadline(), || "configured".into());
    for (case, want) in cases.as_array().unwrap().iter().zip(expected) {
        assert_eq!(
            want,
            if case.get("error").is_some() {
                json!({"error":case["error"]})
            } else {
                json!({"seconds":case["seconds"]})
            }
        );
        let result = transport
            .invoke(
                RemoteOperation::Stop,
                &json!({"taskId":ID,"intent":{"hostFingerprint":"configured","alias":"box"},
                    "run":{"remoteDir":remote_dir},
                    "extra":{"graceMs":case["graceMs"]}}),
            )
            .await;
        if case.get("error").is_some() {
            let error = result.unwrap_err();
            assert!(matches!(
                error,
                BrokerError::Authority(AuthorityError::Denied(_))
            ));
            assert!(!captured.exists(), "denied zero grace must not execute SSH");
            continue;
        }
        let result = result.unwrap();
        assert_eq!(result, json!({"code":137,"killed":false}));
        assert_eq!(
            fs::read_to_string(&captured)
                .unwrap()
                .lines()
                .last()
                .unwrap(),
            case["seconds"].as_u64().unwrap().to_string(),
            "graceMs={}",
            case["graceMs"]
        );
    }
    assert_eq!(fs::read_to_string(captured).unwrap().lines().count(), 5);
}

#[tokio::test]
async fn concrete_remote_stop_uses_the_actual_typescript_issuer_timeout_budget() {
    use pacer_plugin_host::{
        BrokerError, NativeSsh, RemoteHost, RemoteOperation, RemoteTransport, SshConfig,
    };
    use serde_json::{Value, json};

    let f = Fixture::new();
    let reference = Command::new("bun")
        .args([
            "test/fixtures/remote-stop-budget-oracle.ts",
            "[0,1,999,1000,1001,25000]",
        ])
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .env("HOME", &f.root)
        .env("PACER_HOME", &f.root)
        .output()
        .unwrap();
    assert!(
        reference.status.success(),
        "{}",
        String::from_utf8_lossy(&reference.stderr)
    );
    let budgets: Value = serde_json::from_slice(&reference.stdout).unwrap();
    assert_eq!(
        budgets,
        json!([
            {"error":"capability_denied"},
            {"seconds":1,"timeoutMs":11000},
            {"seconds":1,"timeoutMs":11000},
            {"seconds":1,"timeoutMs":11000},
            {"seconds":2,"timeoutMs":12000},
            {"seconds":25,"timeoutMs":35000},
        ])
    );
    let executable = f.root.join("fixture-stop-timeout-ssh");
    let completed = f.root.join("stop-completed");
    fs::write(
        &executable,
        r##"#!/usr/bin/env python3
import os,re,shlex,sys,time
words=shlex.split(sys.argv[-1]);program=words[2];args=words[4:]
assert sys.argv[-2]=='fixture-host'
assert 'D="$1"; grace="$2"' in program
assert args[1]=='1'
nonce=re.findall(r'__PACER_DONE__=([a-f0-9-]{36})',program)
assert len(nonce)==1
# After the issuer's 11-second budget, but before the old fixed 60-second budget.
time.sleep(15)
with open(os.environ['FIXTURE_COMPLETED'],'w') as output: output.write('completed')
sys.stdout.write('__PACER_BEGIN__\ncode=137\nkilled=0\n\n__PACER_DONE__='+nonce[0]+'\n')
"##,
    )
    .unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let ssh = NativeSsh::prepare(
        &f.root,
        SshConfig {
            alias: "box".into(),
            target: "fixture-host".into(),
            fingerprint: "configured".into(),
        },
        executable.to_str().unwrap(),
        HashMap::from([
            ("PATH".into(), std::env::var("PATH").unwrap()),
            ("HOME".into(), f.root.to_str().unwrap().into()),
            (
                "FIXTURE_COMPLETED".into(),
                completed.to_str().unwrap().into(),
            ),
        ]),
    )
    .unwrap();
    let mut transport =
        RemoteTransport::new(&f.root, ssh, f.native(), deadline(), || "configured".into());
    let result = transport
        .invoke(
            RemoteOperation::Stop,
            &json!({"taskId":ID,
        "intent":{"hostFingerprint":"configured","alias":"box"},
        "run":{"remoteDir":format!("/remote/.pacer-remote/runs/{ID}/1")},"extra":{"graceMs":1}}),
        )
        .await;
    assert!(
        matches!(result,Err(BrokerError::Effect(ref text)) if text=="remote fixed operation is unverified"),
        "{result:?}"
    );
    assert!(
        !completed.exists(),
        "timed-out SSH must not complete or emit a successful receipt"
    );
}

#[tokio::test]
async fn large_valid_bundle_matches_typescript_blob_header_reads_and_full_verification() {
    let mut f = Fixture::new();
    let mut seed = 0x519c_2f17_b4a6_d803u64;
    let payload: Vec<u8> = (0..2 * 1024 * 1024)
        .map(|_| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed as u8
        })
        .collect();
    fs::write(f.remote.join("large"), payload).unwrap();
    git(&f.remote, &["add", "large"]);
    git(&f.remote, &["commit", "--amend", "--no-edit", "-q"]);
    f.head = text(&f.remote, &["rev-parse", "HEAD"]);
    let bytes = f.bytes();
    assert!(bytes.len() > 1024 * 1024);
    let source = f.root.join("large.bundle");
    fs::write(&source, &bytes).unwrap();
    let oracle = Command::new("bun")
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .args(["-e", "import {execProcess} from './src/exec/process.ts';const [repo,file]=Bun.argv.slice(-2);const input=new Blob([await Bun.file(file).arrayBuffer()]);const results=[];for(const op of ['verify','list-heads'])results.push(await execProcess({argv:['/usr/bin/git','-C',repo,'bundle',op,'/dev/fd/0'],cwd:repo,env:process.env,stdinBlob:input,timeoutMs:10000,maxStdoutBytes:1048576}));console.log(JSON.stringify(results));"])
        .arg(&f.repo).arg(&source).env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", &f.root).env("GIT_CONFIG_NOSYSTEM", "1").env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output().unwrap();
    assert!(
        oracle.status.success(),
        "{}",
        String::from_utf8_lossy(&oracle.stderr)
    );
    let rows: Vec<serde_json::Value> = serde_json::from_slice(&oracle.stdout).unwrap();
    for row in &rows {
        assert_eq!(row["code"], 0, "{row}");
        assert_eq!(row["timedOut"], false);
    }
    assert_eq!(
        rows[1]["stdout"].as_str().unwrap().trim(),
        format!("{} refs/heads/{}", f.head, f.branch)
    );
    // Host-issued synthetic source: an existing binary reads a temp fixture.
    let argv = vec!["ssh".into(), source.to_str().unwrap().into()];
    let mut stage = NativeBundle::prepare(
        &f.root,
        BundleSpec {
            argv: argv.clone(),
            executable: "/bin/cat".into(),
            env: HashMap::new(),
            timeout_ms: 10000,
            max_bytes: 50 * 1024 * 1024,
        },
    )
    .unwrap();
    let staged = stage
        .stage(
            &serde_json::json!({"argv":argv,"timeoutMs":10000,"maxBytes":50*1024*1024}),
            deadline(),
        )
        .await
        .unwrap();
    let mut ticket = stage.claim(staged["handle"].as_str().unwrap()).unwrap();
    let result = f
        .native()
        .verify(&mut ticket, &f.base, &f.branch, deadline())
        .await;
    assert!(
        result.is_ok(),
        "bundle bytes={}, TS={}, native={:?}",
        bytes.len(),
        String::from_utf8_lossy(&oracle.stdout),
        result.as_ref().err()
    );
    let verified = result.unwrap();
    assert_eq!(verified.head(), f.head);
    assert_eq!(verified.commits(), 1);
    assert_eq!(bytes, fs::read(source).unwrap());
    let local = Command::new("git")
        .arg("-C")
        .arg(&f.repo)
        .args(["cat-file", "-e", &f.head])
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(!local.status.success());
    ticket.dispose().unwrap();
}

#[tokio::test]
async fn transfer_intents_copy_exact_run_fields_with_and_without_prior_admission() {
    use pacer_plugin_host::WireReply;
    use pacer_store::TaskStore;
    use serde_json::json;
    for admit_first in [false, true] {
        let f = Fixture::new();
        let native = f.native();
        let mut ticket = f.ticket(&f.bytes()).await;
        let verified = native
            .verify(&mut ticket, &f.base, &f.branch, deadline())
            .await
            .unwrap();
        let mut store = TaskStore::open(&f.root).unwrap();
        store.insert(&json!({"id":ID,"rev":1,"createdAt":1,"state":"running","executorProvider":"pacer-exec-direct","executor":"tool@host","attempts":[],"brief":{"repo":f.repo}}), 1.0).unwrap();
        let run = WireReply::parse(&format!(r#"{{"attempt":1,"dir":"\ud800","startedAt":{{"array":["\udc01","�"]}},"baseSha":"{}"}}"#, f.base)).unwrap();
        let receipt = WireReply::parse(r#"{"attempt":1,"providerId":"pacer-exec-direct","dir":"\ud800","startedAt":{"array":["\udc01","�"]}}"#).unwrap();
        store
            .edit(ID, 1, 2.0, |t| {
                t.put("/run", run.clone())?;
                t.put("/startIntent", receipt.clone())?;
                t.put("/executorExitReceipt", receipt.clone())
            })
            .unwrap();
        exact_task::seed(&f.root, ID);
        if admit_first {
            native
                .admit_destination(&f.root, ID, run.preview(), deadline())
                .await
                .unwrap();
        }
        native
            .publish(&f.root, ID, run.preview(), verified, deadline())
            .await
            .unwrap();
        let task = store.read_wire(ID).unwrap().unwrap();
        for field in ["dir", "startedAt"] {
            assert_eq!(
                task.subtree(&format!("/remoteTransferIntent/{field}"))
                    .unwrap()
                    .to_json()
                    .unwrap(),
                run.subtree(&format!("/{field}"))
                    .unwrap()
                    .to_json()
                    .unwrap()
            );
        }
        assert_eq!(task.preview()["run"]["transferredHead"], f.head);
        exact_task::assert_preserved(&f.root, ID);
        ticket.dispose().unwrap();
    }
}

// Task 4 - lexical boundaries (plan §4). Oracle rows taken literally from
// `.work/reviews/native-git-phase-plan/oracle/oracle-out.json` (executed TS
// diagnostics at p4b5). Each test uses an owned /bin/sh git shim under the
// owner's isolated Git config/HOME; no ambient hooks, config, credentials or
// network are read.
const BRANCH_ROWS: &[(&str, bool)] = &[
    ("pacer/", false),
    ("pacer", false),
    ("pacer/x", true),
    ("pacer//", true),
    ("pacer/.", true),
    ("pacer/..", true),
    ("pacer/a..b", true),
    ("pacer/-", true),
    ("pacer/UPPER", true),
    ("pacer/x~y", false),
    ("pacer/x y", false),
    ("other/x", false),
    ("pacer/x\n", false),
    ("pacer/\u{e9}", false),
    ("Pacer/x", false),
    ("pacer/x.lock", true),
    ("pacer/t-20261103-091837-234d", true),
    ("pacer/t-20261103-091837-234d-r2", true),
];

#[tokio::test]
async fn branch_predicate_matches_typescript() {
    for (branch, accepted) in BRANCH_ROWS {
        let f = Fixture::new();
        let shim = git_shim::shim(&f.root, &[]);
        let native =
            NativeGit::prepare(&f.root, &f.repo, shim.to_str().unwrap(), &f.owner_env()).unwrap();
        let mut ticket = f.ticket(&f.bytes()).await;
        let result = native
            .verify(&mut ticket, &f.base, branch, deadline())
            .await;
        let dispatched = git_shim::ran(&f.root, "config user.email");
        if *accepted {
            assert!(
                dispatched,
                "branch {branch:?} must dispatch config user.email like TS"
            );
        } else {
            assert!(
                result.is_err(),
                "branch {branch:?} must be denied by the predicate"
            );
            assert!(
                !dispatched,
                "branch {branch:?} must dispatch no git command (TS rejects)"
            );
        }
    }
}

const COUNT_ROWS: &[(&str, bool)] = &[
    ("+1", false),
    ("+500", false),
    ("+0", false),
    ("1", true),
    ("500", true),
    ("501", false),
    ("0", false),
    ("00", false),
    ("01", true),
    ("0001", true),
    ("0500", true),
    ("000000000000000000000001", true),
    ("99999999999999999999", false),
    ("9007199254740993", false),
    ("1.0", false),
    ("1e0", false),
    ("-1", false),
    ("", false),
    ("1 ", true),
    (" 1\n", true),
    ("\t500\n", true),
    ("\u{feff}1\u{feff}", true),
    ("\u{a0}1", true),
    ("1\n2", false),
    ("\u{661}", false),
    ("\u{ff11}", false),
    ("0x1", false),
    ("1_0", false),
];

// Rows whose JS-trimmed value is exactly 1 commit; only these may complete
// end-to-end (the fixture range carries exactly one real commit).
fn is_one_commit(raw: &str) -> bool {
    [
        "1",
        "01",
        "0001",
        "000000000000000000000001",
        "1 ",
        " 1\n",
        "\u{feff}1\u{feff}",
        "\u{a0}1",
    ]
    .contains(&raw)
}

#[tokio::test]
async fn inspected_count_matches_typescript() {
    for (raw, accepted) in COUNT_ROWS {
        let f = Fixture::new();
        let shim = git_shim::shim(
            &f.root,
            &[("rev-list --count", git_shim::Action::Print((*raw).into()))],
        );
        let native =
            NativeGit::prepare(&f.root, &f.repo, shim.to_str().unwrap(), &f.owner_env()).unwrap();
        let mut ticket = f.ticket(&f.bytes()).await;
        let result = native
            .verify(&mut ticket, &f.base, &f.branch, deadline())
            .await;
        let inspected = git_shim::ran(&f.root, "log --format=");
        assert_eq!(
            inspected, *accepted,
            "raw {raw:?}: the inspection must proceed to `log` iff TS accepts the count"
        );
        assert_eq!(
            result.is_ok(),
            is_one_commit(raw),
            "raw {raw:?}: end-to-end verification must succeed only for a count of exactly 1"
        );
    }
}

// Task 1 - env split (plan §4, D-1). The owner map and the sealed map are
// asserted per API call by bracketing the shim log. Every record's expected
// phase comes from the call that produced it (plus the owner's ordinary hex
// path or the sealed inspection path), never from the observed environment,
// so a misrouted verify that wrote owner env into a sealed phase fails loudly.
#[tokio::test]
async fn every_git_phase_uses_its_owner_environment() {
    use pacer_plugin_host::WireReply;
    use pacer_store::TaskStore;
    use serde_json::json;

    let f = Fixture::new();
    let shim = git_shim::shim(&f.root, &[]); // Exec everywhere -> real git under the owner env
    let native =
        NativeGit::prepare(&f.root, &f.repo, shim.to_str().unwrap(), &f.owner_env()).unwrap();
    let owner = f.owner_env();
    let owner_clean = git_shim::without_shell(&owner);
    let sealed = git_shim::sealed_for(&owner);
    let objects = f.repo.join(".git").join("objects");

    // One running task used by every call; /run and intents come from the task.
    let mut store = TaskStore::open(&f.root).unwrap();
    store
        .insert(
            &json!({"id":ID,"rev":1,"createdAt":1,"state":"running","executorProvider":"pacer-exec-direct","executor":"tool@host","attempts":[],"brief":{"repo":f.repo}}),
            1.0,
        )
        .unwrap();
    let run = WireReply::parse(&format!(
        r#"{{"attempt":1,"dir":"d","startedAt":{{"s":1}},"baseSha":"{}"}}"#,
        f.base
    ))
    .unwrap();
    let receipt = WireReply::parse(
        r#"{"attempt":1,"providerId":"pacer-exec-direct","dir":"d","startedAt":{"s":1}}"#,
    )
    .unwrap();
    store
        .edit(ID, 1, 2.0, |t| {
            t.put("/run", run.clone())?;
            t.put("/startIntent", receipt.clone())?;
            t.put("/executorExitReceipt", receipt.clone())
        })
        .unwrap();
    exact_task::seed(&f.root, ID);

    // Verification runs under the sealed map (asserted inline in the verify
    // loop below). Admission, base, and publication are ordinary -- asserted by
    // owner_phase per bracketed call.
    let owner_phase = |slot: &str, records: &[(Vec<String>, HashMap<String, String>)]| {
        assert!(
            !records.is_empty(),
            "{slot}: expected ordinary git commands under the owner map"
        );
        for (args, env) in records {
            assert_eq!(
                git_shim::without_shell(env),
                owner_clean,
                "{slot}: `{}` must run under the owner env exactly",
                args.join(" ")
            );
        }
    };

    // Admission and base-set are ordinary.
    git_shim::clear(&f.root);
    native
        .admit_destination(&f.root, ID, run.preview(), deadline())
        .await
        .unwrap();
    owner_phase("admit_destination", &git_shim::calls(&f.root));
    git_shim::clear(&f.root);
    native.base_bundle(ID, &f.base, deadline()).await.unwrap();
    owner_phase("base_bundle", &git_shim::calls(&f.root));

    // Verification is sealed, including the inspection (sealed + alternates).
    // The phase each record must carry is derived from the known call
    // sequence (plan §2.2): the prelude (#7-13) runs `-C <repo>` under the
    // sealed map, and the inspection (#14-18) runs `-C <inspection dir>`
    // (created under `home/transfers/` with a `.bundle-inspect-` prefix,
    // native_git.rs:456) under sealed plus the alternate objects path. We
    // classify by that argv path rather than by the observed environment, so
    // a misrouted prelude that happened to gain the alternate variable (or an
    // inspection that dropped it) fails loudly.
    git_shim::clear(&f.root);
    let mut ticket = f.ticket(&f.bytes()).await;
    let verified = native
        .verify(&mut ticket, &f.base, &f.branch, deadline())
        .await
        .unwrap();
    let verify_records = git_shim::calls(&f.root);
    let mut prelude = 0;
    let mut inspected = 0;
    let mut want_alternate = sealed.clone();
    want_alternate.insert(
        "GIT_ALTERNATE_OBJECT_DIRECTORIES".into(),
        objects.to_str().unwrap().into(),
    );
    for (args, env) in &verify_records {
        let cleaned = git_shim::without_shell(env);
        let joined = args.join(" ");
        // Inspection commands (#14-18) run with `-C <.../.bundle-inspect-...>`
        // AND carry one of the five inspection argv shapes, so they can be told
        // apart from #13 `init --bare`, which *also* runs in the inspection
        // dir but stays sealed (no alternate). We classify on that argv shape
        // (derived from the known call), never from the observed env.
        let is_alternate = args.iter().any(|a| a.contains(".bundle-inspect-"))
            && !args.iter().any(|a| a.contains("--bare"));
        if is_alternate {
            inspected += 1;
            assert_eq!(
                cleaned, want_alternate,
                "verify inspection `{joined}` must use sealed + alternate objects"
            );
        } else {
            prelude += 1;
            assert_eq!(
                cleaned, sealed,
                "verify `{joined}` must use the sealed map exactly"
            );
        }
    }
    // Exactly the verified prelude (7) and inspection (5) commands ran.
    assert_eq!(
        prelude, 7,
        "verify must run exactly the 7 sealed prelude commands"
    );
    assert_eq!(
        inspected, 5,
        "verify must run exactly the 5 inspection commands"
    );
    assert!(
        git_shim::ran(&f.root, "bundle unbundle /dev/fd/0"),
        "verify must have inspected the bundle (sealed + alternate)"
    );

    // Fresh publication is ordinary and creates the worktree (#29).
    git_shim::clear(&f.root);
    let dest = native
        .publish(&f.root, ID, run.preview(), verified, deadline())
        .await
        .unwrap();
    owner_phase("publish (fresh)", &git_shim::calls(&f.root));
    assert!(
        git_shim::ran(&f.root, "worktree add -q"),
        "fresh publish must create the worktree"
    );

    // Reused publication targets the existing worktree (#24 symbolic-ref, #25
    // status, #28 read-tree). An untracked file in the worktree plus the
    // owned global config (`status.showUntrackedFiles = no`) lets the owner
    // proceed; on the pre-split code the sealed map hides that config and the
    // reuse is rejected, so this is also the ordinary ownership proof.
    //
    // The `remoteTransferIntent` below is a legitimate owner proof written the
    // way `publish` journals it (transfer_owner -> destination, §2.2 #result):
    // it carries `dir`/`startedAt` copied verbatim from the run receipt, not
    // null. The prior must compare equal against the freshly-recomputed
    // destination (native_git.rs:610-621), which takes dir/startedAt from
    // `run`; nulls would fail that legitimate prove rather than any guard.
    fs::write(
        f.root.join("owner.gitconfig"),
        "[status]\n\tshowUntrackedFiles = no\n",
    )
    .unwrap();
    let work = fs::canonicalize(dest["reviewWorktree"].as_str().unwrap()).unwrap();
    fs::write(work.join("untracked"), "untracked\n").unwrap();

    // Plan §4 Task 1 RED semantic proof (a) / review F2: an actual TypeScript
    // oracle for the reused-worktree `status --porcelain` check (#25), run
    // through the real `execProcess` owner function (the same one `defaultRun`/
    // `ctx.run` use) under the *same* owned global config -- the one the native
    // reuse path has just written (`showUntrackedFiles = no`) -- and the *same*
    // worktree with the untracked file above. TS must see an empty porcelain
    // output here, exactly as native's reuse proceeds. The Bun process is
    // isolated (HOME, PACER_HOME, NOSYSTEM, owned GLOBAL, XDG); no operator
    // gitconfig, credential helper or system config is read.
    let status_gitconfig = f.root.join("owner.gitconfig");
    let status_oracle = Command::new("bun")
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .args([
            "-e",
            "import {execProcess} from './src/exec/process.ts';const [work, globalConfig]=Bun.argv.slice(-2);const env={...process.env,GIT_CONFIG_GLOBAL:globalConfig,GIT_CONFIG_NOSYSTEM:'1'};const r=await execProcess({argv:['/usr/bin/git','-C',work,'status','--porcelain'],cwd:work,env,timeoutMs:10000});console.log(JSON.stringify({stdout:r.stdout,code:r.code}));",
        ])
        .arg(&work)
        .arg(&status_gitconfig)
        .env("HOME", &f.root)
        .env("PACER_HOME", &f.root)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", &status_gitconfig)
        .env("XDG_CONFIG_HOME", f.root.join("xdg"))
        .output()
        .unwrap();
    assert!(
        status_oracle.status.success(),
        "TS oracle failed: {}",
        String::from_utf8_lossy(&status_oracle.stderr)
    );
    let status_row: serde_json::Value = serde_json::from_slice(&status_oracle.stdout)
        .unwrap_or_else(|e| panic!("TS oracle malformed output: {e}"));
    assert_eq!(
        status_row["code"], 0,
        "TS `git status --porcelain` under the owned config must succeed: {status_row}"
    );
    assert_eq!(
        status_row["stdout"], "",
        "TS `git status --porcelain` must be empty under `showUntrackedFiles = no` (native reuse would too): {status_row}"
    );
    // Sanity: absent the owned `showUntrackedFiles = no`, git would report the
    // untracked file, so the assertion above is a real parity proof, not vacuous.
    let control = Command::new("git")
        .arg("-C")
        .arg(&work)
        .args(["status", "--porcelain"])
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", &f.root)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(
        !String::from_utf8_lossy(&control.stdout).is_empty(),
        "control: the untracked file must make bare `status --porcelain` non-empty"
    );
    let mut ticket2 = f.ticket(&f.bytes()).await;
    let verified2 = native
        .verify(&mut ticket2, &f.base, &f.branch, deadline())
        .await
        .unwrap();
    git_shim::clear(&f.root);
    store
        .edit_current(ID, 4.0, |t| {
            t.put(
                "/remoteTransferIntent",
                WireReply::new(json!({
                    "attempt": 1,
                    "providerId": "pacer-exec-direct",
                    "dir": run.preview()["dir"],
                    "startedAt": run.preview()["startedAt"],
                    "branch": f.branch,
                    "oldHead": verified2.head(),
                })),
            )
        })
        .unwrap();
    git_shim::clear(&f.root);
    native
        .publish(&f.root, ID, run.preview(), verified2, deadline())
        .await
        .unwrap();
    owner_phase("publish (reused)", &git_shim::calls(&f.root));
    assert!(
        git_shim::ran(&f.root, "symbolic-ref HEAD"),
        "reused publish must run the symbolic-ref check"
    );
    assert!(
        git_shim::ran(&f.root, "read-tree --reset -u"),
        "reused publish must reset the existing worktree via read-tree"
    );
    ticket.dispose().unwrap();
    ticket2.dispose().unwrap();
}

// Plan §4 Task 1 RED semantic proof (b): verification stays sealed even when
// the *owner* provides a global email. The fixture repo has no local
// `user.email`, while the owned global config sets one. Because verify (
// #7) runs `config user.email` under the sealed map (GIT_CONFIG_GLOBAL=/dev/
// null), git sees no email, the prelude returns empty and verify is denied --
// an owner-provided email cannot unlock verification. The shim log records
// that the prelude ran with the /dev/null global, closing the control: the
// failure is the sealed map, not the fixture.
#[tokio::test]
async fn sealed_verification_ignores_owned_global_email() {
    let f = Fixture::new();
    let shim = git_shim::shim(&f.root, &[]); // Exec -> real git under the env NativeGit chooses
    // The local repo has no user config; the owner map would satisfy it.
    git(&f.repo, &["config", "--unset", "user.email"]);
    fs::write(
        f.root.join("owner.gitconfig"),
        "[user]\n\tname = Fixture\n\temail = from-owner@invalid.test\n",
    )
    .unwrap();
    let native =
        NativeGit::prepare(&f.root, &f.repo, shim.to_str().unwrap(), &f.owner_env()).unwrap();
    let mut ticket = f.ticket(&f.bytes()).await;
    let result = native
        .verify(&mut ticket, &f.base, &f.branch, deadline())
        .await;
    assert!(
        result.is_err(),
        "verify must be denied: the sealed map hides the owned global email"
    );
    let records = git_shim::calls(&f.root);
    let email_record = records
        .iter()
        .find(|(args, _)| {
            args.contains(&"config".to_string()) && args.contains(&"user.email".to_string())
        })
        .unwrap_or_else(|| panic!("prelude must run `config user.email`"));
    assert_eq!(
        email_record.1.get("GIT_CONFIG_GLOBAL").map(String::as_str),
        Some("/dev/null"),
        "the email prelude must read the sealed /dev/null global, never the owner's"
    );
    assert_eq!(
        email_record
            .1
            .get("GIT_TERMINAL_PROMPT")
            .map(String::as_str),
        Some("0"),
    );
    ticket.dispose().unwrap();
}
