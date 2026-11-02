#![allow(clippy::unwrap_used)]
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
    fn native(&self) -> NativeGit {
        NativeGit::prepare(
            &self.root,
            &self.repo,
            "/usr/bin/git",
            &HashMap::from([
                ("PATH".into(), std::env::var("PATH").unwrap()),
                ("HOME".into(), self.root.to_str().unwrap().into()),
            ]),
        )
        .unwrap()
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
elif 'file="$1/.pacer-question"' in program: output=''
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
    let host = RemoteTransport::new(&f.root, ssh, f.native(), deadline(), move || {
        configured.clone()
    });
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
}

#[tokio::test]
async fn cancelled_base_bundle_still_cleans_its_temporary_ref() {
    let f = Fixture::new();
    let shim = f.root.join("git-shim");
    let marker = f.root.join("bundling");
    fs::write(&shim, format!("#!/usr/bin/env python3\nimport os,sys,time\nif 'bundle' in sys.argv:\n open({},'w').close()\n time.sleep(0.25)\nos.execv('/usr/bin/git',['git']+sys.argv[1:])\n", serde_json::to_string(marker.to_str().unwrap()).unwrap())).unwrap();
    fs::set_permissions(&shim, fs::Permissions::from_mode(0o700)).unwrap();
    let native = NativeGit::prepare(
        &f.root,
        &f.repo,
        shim.to_str().unwrap(),
        &HashMap::from([
            ("PATH".into(), std::env::var("PATH").unwrap()),
            ("HOME".into(), f.root.to_str().unwrap().into()),
        ]),
    )
    .unwrap();
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
